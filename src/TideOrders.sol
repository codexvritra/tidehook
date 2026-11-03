// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";

/// @title TideOrders
/// @notice Limit orders and DCA for any Uniswap v4 pool, with no keeper privilege and no fee of its own.
///
///         Limit order = a single-sided liquidity position one tick-spacing wide just outside the current price
///         (the Uniswap "range order"). Selling currency0 sits above the price, selling currency1 below it. When
///         trades push the price fully through the range, the position holds only the bought currency; anyone may
///         then `fill` it, which withdraws it and pays the owner, locking the execution in. Takers crossing the
///         order pay the pool's normal fees; the maker pays nothing extra.
///
///         DCA = funds escrowed here and swapped in equal slices. Anyone may `execute` a slice once its interval
///         has passed; each slice must fill in full within the owner's worst-price limit (else it waits), and the
///         output goes straight to the owner. Owners can cancel either kind at any time and get the rest back.
contract TideOrders is IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeTransferLib for ERC20;

    struct Limit {
        address owner;
        bool zeroForOne; // true: sells currency0 for currency1 (range above the price)
        bool open;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        PoolKey key;
    }

    struct Dca {
        address owner;
        bool zeroForOne;
        uint32 slicesLeft;
        uint32 interval;
        uint64 nextAt;
        uint128 perSlice;
        uint160 limitSqrtPriceX96; // worst price a slice may push the pool to
        PoolKey key;
    }

    enum Action {
        AddRange,
        RemoveRange,
        Swap
    }

    event LimitPlaced(
        uint256 indexed id,
        address indexed owner,
        PoolId indexed poolId,
        bool zeroForOne,
        int24 tickLower,
        int24 tickUpper,
        uint256 amountIn
    );
    event LimitClosed(uint256 indexed id, address indexed owner, bool filled, uint256 amount0, uint256 amount1);
    event DcaCreated(
        uint256 indexed id,
        address indexed owner,
        PoolId indexed poolId,
        bool zeroForOne,
        uint256 perSlice,
        uint32 slices,
        uint32 interval,
        uint160 limitSqrtPriceX96
    );
    event DcaExecuted(uint256 indexed id, uint256 amountIn, uint256 amountOut, uint32 slicesLeft, uint64 nextAt);
    event DcaCancelled(uint256 indexed id, uint256 refund);

    error NotPoolManager();
    error NotOwner();
    error Closed();
    error BadRange();
    error BadAmount();
    error NotFilled();
    error NotDue(uint64 nextAt);
    error PriceLimit();
    error EthTransferFailed();

    uint32 public constant MIN_INTERVAL = 60;
    uint32 public constant MAX_SLICES = 1_000;

    IPoolManager public immutable poolManager;

    Limit[] internal _limits;
    Dca[] internal _dcas;

    constructor(IPoolManager _poolManager) {
        poolManager = _poolManager;
    }

    // ------------------------------------------------------------------ limit orders

    /// @notice Sell `amountIn` of one side once the price moves through [tickLower, tickLower + tickSpacing].
    ///         Selling currency0 requires the range to sit above the current tick, selling currency1 below it.
    function placeLimit(PoolKey calldata key, bool zeroForOne, int24 tickLower, uint128 amountIn)
        external
        payable
        returns (uint256 id)
    {
        if (amountIn == 0) revert BadAmount();
        int24 tickUpper = tickLower + key.tickSpacing;
        if (tickLower % key.tickSpacing != 0) revert BadRange();
        if (tickLower < TickMath.minUsableTick(key.tickSpacing) || tickUpper > TickMath.maxUsableTick(key.tickSpacing))
        {
            revert BadRange();
        }
        (, int24 tick,,) = poolManager.getSlot0(key.toId());
        // v4 positions are active for tickLower <= tick < tickUpper, so a range strictly out of range is single-sided.
        if (zeroForOne ? tick >= tickLower : tick < tickUpper) revert BadRange();

        Currency cin = zeroForOne ? key.currency0 : key.currency1;
        _checkValue(cin, amountIn);
        uint160 a = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 b = TickMath.getSqrtPriceAtTick(tickUpper);
        uint128 liquidity = zeroForOne
            ? LiquidityAmounts.getLiquidityForAmount0(a, b, amountIn)
            : LiquidityAmounts.getLiquidityForAmount1(a, b, amountIn);
        if (liquidity == 0) revert BadAmount();

        id = _limits.length;
        _limits.push(Limit(msg.sender, zeroForOne, true, tickLower, tickUpper, liquidity, key));
        uint256 paid =
            abi.decode(poolManager.unlock(abi.encode(Action.AddRange, abi.encode(id, msg.sender))), (uint256));
        _refundEth(cin, paid);
        emit LimitPlaced(id, msg.sender, key.toId(), zeroForOne, tickLower, tickUpper, paid);
    }

    /// @notice True once the price has moved fully through the order's range.
    function isFillable(uint256 id) public view returns (bool) {
        Limit storage o = _limits[id];
        if (!o.open) return false;
        (, int24 tick,,) = poolManager.getSlot0(o.key.toId());
        return o.zeroForOne ? tick >= o.tickUpper : tick < o.tickLower;
    }

    /// @notice Anyone: withdraw a filled order and pay its owner (locks the execution in).
    function fill(uint256 id) external {
        if (!isFillable(id)) revert NotFilled();
        _close(id, true);
    }

    /// @notice Owner: withdraw the order now, filled or not, and get back whatever it holds.
    function cancelLimit(uint256 id) external {
        Limit storage o = _limits[id];
        if (msg.sender != o.owner) revert NotOwner();
        if (!o.open) revert Closed();
        _close(id, isFillable(id));
    }

    function _close(uint256 id, bool filled) internal {
        Limit storage o = _limits[id];
        o.open = false;
        (uint256 a0, uint256 a1) =
            abi.decode(poolManager.unlock(abi.encode(Action.RemoveRange, abi.encode(id))), (uint256, uint256));
        emit LimitClosed(id, o.owner, filled, a0, a1);
    }

    // ------------------------------------------------------------------ DCA

    /// @notice Escrow `perSlice * slices` and swap one slice every `interval` seconds, never past `limitSqrtPriceX96`
    ///         (0 = no limit). The first slice is executable immediately.
    function createDca(
        PoolKey calldata key,
        bool zeroForOne,
        uint128 perSlice,
        uint32 slices,
        uint32 interval,
        uint160 limitSqrtPriceX96
    ) external payable returns (uint256 id) {
        if (perSlice == 0 || slices == 0 || slices > MAX_SLICES || interval < MIN_INTERVAL) {
            revert BadAmount();
        }
        uint256 total = uint256(perSlice) * slices;
        Currency cin = zeroForOne ? key.currency0 : key.currency1;
        if (cin.isAddressZero()) {
            if (msg.value != total) revert BadAmount();
        } else {
            if (msg.value != 0) revert BadAmount();
            ERC20(Currency.unwrap(cin)).safeTransferFrom(msg.sender, address(this), total);
        }
        uint160 limit = limitSqrtPriceX96 != 0
            ? limitSqrtPriceX96
            : (zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
        id = _dcas.length;
        _dcas.push(Dca(msg.sender, zeroForOne, slices, interval, uint64(block.timestamp), perSlice, limit, key));
        emit DcaCreated(id, msg.sender, key.toId(), zeroForOne, perSlice, slices, interval, limit);
    }

    function isDue(uint256 id) public view returns (bool) {
        Dca storage d = _dcas[id];
        return d.slicesLeft > 0 && block.timestamp >= d.nextAt;
    }

    /// @notice Anyone: run the next due slice. Reverts (and the slice waits) if it can't fill in full within the limit.
    function execute(uint256 id) external returns (uint256 amountOut) {
        Dca storage d = _dcas[id];
        if (d.slicesLeft == 0) revert Closed();
        if (block.timestamp < d.nextAt) revert NotDue(d.nextAt);
        d.slicesLeft -= 1;
        d.nextAt = uint64(block.timestamp) + d.interval;
        amountOut = abi.decode(poolManager.unlock(abi.encode(Action.Swap, abi.encode(id))), (uint256));
        emit DcaExecuted(id, d.perSlice, amountOut, d.slicesLeft, d.nextAt);
    }

    function cancelDca(uint256 id) external {
        Dca storage d = _dcas[id];
        if (msg.sender != d.owner) revert NotOwner();
        if (d.slicesLeft == 0) revert Closed();
        uint256 refund = uint256(d.perSlice) * d.slicesLeft;
        d.slicesLeft = 0;
        _pay(d.zeroForOne ? d.key.currency0 : d.key.currency1, d.owner, refund);
        emit DcaCancelled(id, refund);
    }

    // ------------------------------------------------------------------ views

    function limitCount() external view returns (uint256) {
        return _limits.length;
    }

    function dcaCount() external view returns (uint256) {
        return _dcas.length;
    }

    function getLimit(uint256 id) external view returns (Limit memory) {
        return _limits[id];
    }

    function getDca(uint256 id) external view returns (Dca memory) {
        return _dcas[id];
    }

    // ------------------------------------------------------------------ v4 plumbing

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (Action action, bytes memory inner) = abi.decode(data, (Action, bytes));

        if (action == Action.AddRange) {
            (uint256 id, address payer) = abi.decode(inner, (uint256, address));
            Limit storage o = _limits[id];
            (BalanceDelta d,) = _modify(o, int256(uint256(o.liquidity)), id);
            (Currency cin, int128 owed) = o.zeroForOne ? (o.key.currency0, d.amount0()) : (o.key.currency1, d.amount1());
            uint256 paid = uint256(uint128(-owed));
            _settle(cin, payer, paid);
            return abi.encode(paid);
        }
        if (action == Action.RemoveRange) {
            uint256 id = abi.decode(inner, (uint256));
            Limit storage o = _limits[id];
            (BalanceDelta d,) = _modify(o, -int256(uint256(o.liquidity)), id);
            uint256 a0 = d.amount0() > 0 ? uint256(uint128(d.amount0())) : 0;
            uint256 a1 = d.amount1() > 0 ? uint256(uint128(d.amount1())) : 0;
            if (a0 > 0) poolManager.take(o.key.currency0, o.owner, a0);
            if (a1 > 0) poolManager.take(o.key.currency1, o.owner, a1);
            return abi.encode(a0, a1);
        }
        uint256 dcaId = abi.decode(inner, (uint256));
        Dca storage s = _dcas[dcaId];
        BalanceDelta sd = poolManager.swap(
            s.key,
            SwapParams({
                zeroForOne: s.zeroForOne,
                amountSpecified: -int256(uint256(s.perSlice)),
                sqrtPriceLimitX96: s.limitSqrtPriceX96
            }),
            ""
        );
        (int128 inDelta, int128 outDelta) = s.zeroForOne ? (sd.amount0(), sd.amount1()) : (sd.amount1(), sd.amount0());
        if (uint256(uint128(-inDelta)) != s.perSlice) revert PriceLimit(); // partial fill: the slice waits
        (Currency cin, Currency cout) =
            s.zeroForOne ? (s.key.currency0, s.key.currency1) : (s.key.currency1, s.key.currency0);
        _settle(cin, address(this), s.perSlice);
        uint256 got = uint256(uint128(outDelta));
        if (got > 0) poolManager.take(cout, s.owner, got);
        return abi.encode(got);
    }

    function _modify(Limit storage o, int256 liquidityDelta, uint256 id) internal returns (BalanceDelta, BalanceDelta) {
        return poolManager.modifyLiquidity(
            o.key,
            ModifyLiquidityParams({
                tickLower: o.tickLower, tickUpper: o.tickUpper, liquidityDelta: liquidityDelta, salt: bytes32(id)
            }),
            ""
        );
    }

    /// @dev Pays `amount` of `c` into the PoolManager: ETH from this contract's balance, ERC20 from `from`.
    function _settle(Currency c, address from, uint256 amount) internal {
        if (amount == 0) return;
        if (c.isAddressZero()) {
            poolManager.settle{value: amount}();
        } else {
            poolManager.sync(c);
            if (from == address(this)) ERC20(Currency.unwrap(c)).safeTransfer(address(poolManager), amount);
            else ERC20(Currency.unwrap(c)).safeTransferFrom(from, address(poolManager), amount);
            poolManager.settle();
        }
    }

    function _checkValue(Currency cin, uint256 amountIn) internal view {
        if (cin.isAddressZero() ? msg.value < amountIn : msg.value != 0) revert BadAmount();
    }

    /// @dev Liquidity math rounds down, so an ETH order uses a hair less than was sent: return the rest.
    function _refundEth(Currency cin, uint256 paid) internal {
        if (cin.isAddressZero() && msg.value > paid) _pay(cin, msg.sender, msg.value - paid);
    }

    function _pay(Currency c, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (c.isAddressZero()) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            ERC20(Currency.unwrap(c)).safeTransfer(to, amount);
        }
    }
}
