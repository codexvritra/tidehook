// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TideFeeHook} from "./base/TideFeeHook.sol";

/// @title SpringHook — fees as a restoring force
/// @notice The pool remembers where its price "rests" (a time-weighted EMA of the tick). Inside a
///         neutral band every swap pays `baseFee`. Once price is stretched beyond the band:
///         - swaps that stretch it further pay more, growing linearly with distance (Hooke's law),
///         - swaps that pull it back toward rest pay `minFee`, provided their price limit stops
///           at the rest price. A restoring swap with an open-ended limit could overshoot into a
///           cheap pump, so it pays `baseFee` instead.
///         Dumps and pumps get progressively expensive while arbitrageurs and dip-buyers who
///         restore the price get the cheapest fills in the pool. No trade is ever blocked.
/// @dev    The rest point is an EMA of the pre-swap tick weighted by elapsed time, so many swaps
///         within one block cannot drag it: intra-block manipulation moves price, never the anchor.
contract SpringHook is TideFeeHook {
    using PoolIdLibrary for PoolKey;
    using LPFeeLibrary for uint24;
    using StateLibrary for IPoolManager;

    error MustUseDynamicFee();

    event RestUpdated(PoolId indexed poolId, int24 restTick);

    struct Spring {
        int24 restTick;
        uint40 lastUpdate;
    }

    uint24 public immutable baseFee;
    uint24 public immutable minFee;
    uint24 public immutable maxFee;
    /// @notice Ticks either side of rest that count as "relaxed" (no surcharge, no discount).
    uint24 public immutable band;
    /// @notice Extra fee in pips per tick of stretch beyond the band.
    uint24 public immutable stiffness;
    /// @notice Seconds for the rest point to fully catch up with spot (EMA window).
    uint32 public immutable window;

    mapping(PoolId => Spring) public springs;

    constructor(
        IPoolManager _poolManager,
        uint24 _baseFee,
        uint24 _minFee,
        uint24 _maxFee,
        uint24 _band,
        uint24 _stiffness,
        uint32 _window
    ) TideFeeHook(_poolManager) {
        require(_minFee <= _baseFee && _baseFee <= _maxFee && _maxFee <= LPFeeLibrary.MAX_LP_FEE, "fees");
        require(_window > 0, "window");
        baseFee = _baseFee;
        minFee = _minFee;
        maxFee = _maxFee;
        band = _band;
        stiffness = _stiffness;
        window = _window;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.afterInitialize = true;
        p.beforeSwap = true;
        p.afterSwap = true;
        p.beforeSwapReturnDelta = true;
        p.afterSwapReturnDelta = true;
    }

    /// @notice sqrtPriceLimitX96 a restoring swap must use to qualify for `minFee`.
    function restLimit(PoolId id) public view returns (uint160) {
        return TickMath.getSqrtPriceAtTick(springs[id].restTick);
    }

    /// @notice Fee a swap would pay at the given spot tick.
    function quoteFee(PoolId id, int24 tick, bool zeroForOne, uint160 sqrtPriceLimitX96) public view returns (uint24) {
        int24 restTick = springs[id].restTick;
        int256 stretch = int256(tick) - int256(restTick);
        uint256 dist = stretch < 0 ? uint256(-stretch) : uint256(stretch);
        if (dist <= band) return baseFee;

        // zeroForOne pushes the tick down. Price below rest + selling token0 = stretching.
        bool stretching = (stretch < 0) == zeroForOne;
        if (!stretching) {
            uint160 rest = TickMath.getSqrtPriceAtTick(restTick);
            bool boundedAtRest = zeroForOne ? sqrtPriceLimitX96 >= rest : sqrtPriceLimitX96 <= rest;
            return boundedAtRest ? minFee : baseFee;
        }

        uint256 fee = uint256(baseFee) + (dist - band) * stiffness;
        return fee > maxFee ? maxFee : uint24(fee);
    }

    function beforeInitialize(address sender, PoolKey calldata key, uint160)
        external
        override
        onlyPoolManager
        returns (bytes4)
    {
        if (!key.fee.isDynamicFee()) revert MustUseDynamicFee();
        _recordInitializer(sender, key);
        return this.beforeInitialize.selector;
    }

    function afterInitialize(address, PoolKey calldata key, uint160, int24 tick)
        external
        override
        onlyPoolManager
        returns (bytes4)
    {
        springs[key.toId()] = Spring({restTick: tick, lastUpdate: uint40(block.timestamp)});
        return this.afterInitialize.selector;
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        override
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        (, int24 tick,,) = poolManager.getSlot0(id);
        _relax(id, tick);
        uint24 fee = quoteFee(id, tick, params.zeroForOne, params.sqrtPriceLimitX96);
        return (this.beforeSwap.selector, _feeBefore(key, params), fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    /// @dev Moves the rest point toward `tick`, the price that has stood since the last update,
    ///      weighted by how long it stood. Zero elapsed time means zero movement.
    function _relax(PoolId id, int24 tick) internal {
        Spring storage s = springs[id];
        uint256 dt = block.timestamp - s.lastUpdate;
        if (dt == 0) return;
        if (dt > window) dt = window;
        int256 rest = int256(s.restTick);
        rest += ((int256(tick) - rest) * int256(dt)) / int256(uint256(window));
        s.restTick = int24(rest);
        s.lastUpdate = uint40(block.timestamp);
        emit RestUpdated(id, s.restTick);
    }
}
