// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {Position} from "@uniswap/v4-core/src/libraries/Position.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";
import {TideLauncherBase} from "./TideLauncherBase.sol";

/// @title TideMigrator
/// @notice Liquidity migration for TideLauncher, split out to keep the launcher under the 24 KB code limit.
///         Runs only via DELEGATECALL from the launcher's unlock callback, on the launcher's storage and with
///         the launcher as the PoolManager caller. Calling it directly reverts.
contract TideMigrator is TideLauncherBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;

    error NotDelegated();

    address private immutable self = address(this);

    constructor(IPoolManager _poolManager, address _patience, address _spring, address _bond, address _session)
        TideLauncherBase(_poolManager, _patience, _spring, _bond, _session)
    {}

    function migrate(uint256 id, Migration memory m, uint256 minQuoteOut) external {
        if (address(this) == self) revert NotDelegated();
        _migrate(id, m, minQuoteOut);
    }

    struct Move {
        address token;
        address oldQuote;
        uint256 tokenAmt;
        uint256 quoteAmt;
        int24 tick;
        bool tokenIs0;
        PoolKey oldKey;
        PoolKey key;
    }

    function _migrate(uint256 id, Migration memory m, uint256 minQuoteOut) internal {
        Launch storage l = _launches[id];
        Move memory mv;
        mv.token = l.token;
        mv.oldKey = l.key;
        mv.oldQuote = _quoteOf(l);

        // 1. Pull every unit of locked liquidity out of the old pool. Fees go to the creator;
        //    principal stays as a PoolManager credit and funds the new pool without any ERC20 transfer.
        (mv.tokenAmt, mv.quoteAmt) = _removeAll(l, id, mv.oldKey);

        // 2-4. Same price, new pool: convert the quote side if the pair changes, then open and re-seed.
        _openMigrated(l, id, m, mv, minQuoteOut);

        // 5. Settle: dust of the token is burned, any quote left over goes to the creator.
        _sweep(Currency.wrap(mv.token), BURN);
        _sweep(Currency.wrap(m.quote), l.creator);
        if (mv.oldQuote != m.quote) _sweep(Currency.wrap(mv.oldQuote), l.creator);

        _pastPools[id].push(mv.oldKey.toId());
        l.key = mv.key;
        l.kind = m.kind;
        l.tokenIsCurrency0 = mv.tokenIs0;
        l.migrations += 1;
        emit Migrated(id, mv.oldKey.toId(), mv.key.toId(), m.kind, m.quote, mv.tick, mv.tokenAmt, mv.quoteAmt);
    }

    function _openMigrated(Launch storage l, uint256 id, Migration memory m, Move memory mv, uint256 minQuoteOut)
        internal
    {
        // The old pool's price in "raw tokens per raw quote" orientation.
        (, int24 oldTick,,) = poolManager.getSlot0(mv.oldKey.toId());
        int24 tn = l.tokenIsCurrency0 ? -oldTick : oldTick;

        // Convert the quote side through the admin's route pool and re-express the price in the new quote.
        if (m.quote != mv.oldQuote) {
            int24 rate;
            (mv.quoteAmt, rate) = _convert(mv.oldQuote, m.quote, mv.quoteAmt, m, minQuoteOut);
            tn -= rate;
        }

        // Open the new pool at the same price, rounded to the tick grid.
        int24 t0 = _align(tn);
        if (t0 <= TickMath.minUsableTick(TICK_SPACING) || t0 >= TickMath.maxUsableTick(TICK_SPACING)) {
            revert BadParams("price out of range");
        }
        mv.tokenIs0 = mv.token < m.quote;
        mv.key = _keyFor(mv.token, m.quote, m.kind);
        mv.tick = mv.tokenIs0 ? -t0 : t0;
        (uint160 existing,,,) = poolManager.getSlot0(mv.key.toId());
        if (existing != 0) revert PoolExists();
        poolManager.initialize(mv.key, TickMath.getSqrtPriceAtTick(mv.tick));
        _reseed(l, id, mv);
    }

    function _removeAll(Launch storage l, uint256 id, PoolKey memory key)
        internal
        returns (uint256 tokenAmt, uint256 quoteAmt)
    {
        (int256 p0, int256 p1) = _remove(l, key, l.tickLower, l.tickUpper, _saltA(id));
        if (l.bidLower != l.bidUpper) {
            (int256 q0, int256 q1) = _remove(l, key, l.bidLower, l.bidUpper, _saltB(id));
            p0 += q0;
            p1 += q1;
        }
        (tokenAmt, quoteAmt) = l.tokenIsCurrency0 ? (uint256(p0), uint256(p1)) : (uint256(p1), uint256(p0));
    }

    /// @dev Removes a whole position. Returns principal only; accrued fees are paid to the creator.
    function _remove(Launch storage l, PoolKey memory key, int24 lower, int24 upper, bytes32 salt)
        internal
        returns (int256 principal0, int256 principal1)
    {
        bytes32 positionKey = Position.calculatePositionKey(address(this), lower, upper, salt);
        uint128 liquidity = poolManager.getPositionLiquidity(key.toId(), positionKey);
        if (liquidity == 0) return (0, 0);
        (BalanceDelta d, BalanceDelta fees) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: lower, tickUpper: upper, liquidityDelta: -int256(uint256(liquidity)), salt: salt
            }),
            ""
        );
        uint256 f0 = _pos(fees.amount0());
        uint256 f1 = _pos(fees.amount1());
        if (f0 > 0) poolManager.take(key.currency0, l.creator, f0);
        if (f1 > 0) poolManager.take(key.currency1, l.creator, f1);
        principal0 = int256(d.amount0()) - int256(f0);
        principal1 = int256(d.amount1()) - int256(f1);
    }

    /// @dev Swaps `amountIn` of `from` into `to` through the route pool. Returns the amount received and the
    ///      effective rate as a tick (log1.0001 raw `to` per raw `from`), both sanity-checked against the route.
    function _convert(address from, address to, uint256 amountIn, Migration memory m, uint256 minOut)
        internal
        returns (uint256 out, int24 rate)
    {
        if (PoolId.unwrap(_routes[_pairKey(from, to)].toId()) != PoolId.unwrap(m.routeId)) {
            revert BadParams("route changed");
        }
        int24 proposedRate = m.routeTick;
        int24 spot = _routeRate(from, to);
        int256 drift = int256(spot) - int256(proposedRate);
        if (drift > MAX_ROUTE_DRIFT || drift < -MAX_ROUTE_DRIFT) revert PriceDrift(drift);
        if (amountIn == 0) return (0, spot);

        PoolKey memory route = _routes[_pairKey(from, to)];
        bool zeroForOne = Currency.unwrap(route.currency0) == from;
        BalanceDelta d = poolManager.swap(
            route,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        out = _pos(zeroForOne ? d.amount1() : d.amount0());
        if (out == 0 || out < minOut) revert Slippage(out, minOut);

        uint256 paid = uint256(uint128(-(zeroForOne ? d.amount0() : d.amount1())));
        // A partial fill would strand holders' quote; it must convert in full or not at all.
        if (paid != amountIn) revert Slippage(paid, amountIn);
        uint160 sqrtRate = uint160(FixedPointMathLib.sqrt(FullMath.mulDiv(out, 1 << 192, paid)));
        if (sqrtRate < TickMath.MIN_SQRT_PRICE || sqrtRate >= TickMath.MAX_SQRT_PRICE) revert BadParams("rate");
        rate = TickMath.getTickAtSqrtPrice(sqrtRate);
        drift = int256(rate) - int256(spot);
        if (drift > MAX_EXEC_DEVIATION || drift < -MAX_EXEC_DEVIATION) revert PriceDrift(drift);
    }

    function _reseed(Launch storage l, uint256 id, Move memory mv) internal {
        int24 minT = TickMath.minUsableTick(TICK_SPACING);
        int24 maxT = TickMath.maxUsableTick(TICK_SPACING);
        // Token side starts at the price and reaches the v4 maximum: no ceiling.
        (int24 lo, int24 hi) = mv.tokenIs0 ? (mv.tick, maxT) : (minT, mv.tick);
        (l.tickLower, l.tickUpper) = (lo, hi);
        _addLiquidity(mv.key, lo, hi, mv.tokenAmt, mv.tokenIs0, _saltA(id));
        // Quote side sits just below the price as bid support.
        (lo, hi) = mv.tokenIs0 ? (minT, mv.tick) : (mv.tick, maxT);
        bool placed = _addLiquidity(mv.key, lo, hi, mv.quoteAmt, !mv.tokenIs0, _saltB(id)) > 0;
        (l.bidLower, l.bidUpper) = placed ? (lo, hi) : (int24(0), int24(0));
    }

    function _sweep(Currency c, address to) internal {
        int256 delta = poolManager.currencyDelta(address(this), c);
        if (delta > 0) poolManager.take(c, to, uint256(delta));
    }
}
