// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TideFeeHook} from "./base/TideFeeHook.sol";

/// @title TidePotHook — the last buyer wins the pot
/// @notice A volume game built into the pool. Trades pay exactly the launchpad's 2% as everywhere else, but the
///         creator's 1% of every buy goes into the pool's pot instead of to the creator. A buy worth at least
///         MIN_BUY_BPS of the current pot (in the quote asset) makes its trader the leader and resets a ROUND
///         countdown. When the countdown runs out, the leader wins WINNER_BPS of the pot and the rest seeds the
///         next round. The round settles on the next swap or through `settle`; the winner withdraws with `claim`.
///
///         The leader is the address passed as hookData (32 bytes, so smart wallets and our router name the buyer),
///         else `tx.origin`, the wallet that signed. Whoever pays for the buy picks who leads, so nothing is gained
///         by naming someone else. Sells never touch the pot (they pay the usual 2% to the platform).
contract TidePotHook is TideFeeHook {
    using PoolIdLibrary for PoolKey;

    struct Pot {
        uint128 amount; // quote asset, held by this hook as PoolManager claims
        uint64 deadline; // 0 = no round running
        uint32 round;
        address leader;
    }

    event PotBuy(PoolId indexed poolId, address indexed leader, uint256 spent, uint256 pot, uint64 deadline);
    event PotWon(PoolId indexed poolId, address indexed winner, uint32 round, uint256 prize, uint256 carried);

    error StaticFeeOnly();
    error RoundRunning(uint64 deadline);

    uint64 public constant ROUND = 1 hours;
    uint256 public constant MIN_BUY_BPS = 200; // a qualifying buy spends >= 2% of the current pot
    uint256 public constant WINNER_BPS = 8_000; // 80% to the winner, 20% seeds the next round

    mapping(PoolId => Pot) public pots;

    constructor(IPoolManager _poolManager) TideFeeHook(_poolManager) {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeSwap = true;
        p.afterSwap = true;
        p.beforeSwapReturnDelta = true;
        p.afterSwapReturnDelta = true;
    }

    function beforeInitialize(address sender, PoolKey calldata key, uint160)
        external
        override
        onlyPoolManager
        returns (bytes4)
    {
        if (key.fee != 0) revert StaticFeeOnly(); // the pot game runs on the 2% tax alone, no LP fee
        _recordInitializer(sender, key);
        return this.beforeInitialize.selector;
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        override
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        _settleIfOver(key);
        (Currency quote, address creator, uint256 before) = _creatorOwed(key);
        BeforeSwapDelta d = _feeBefore(key, params);
        _divert(key.toId(), quote, creator, before);
        return (this.beforeSwap.selector, d, 0);
    }

    function afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) external override onlyPoolManager returns (bytes4, int128) {
        PoolId id = key.toId();
        (Currency quote, address creator, uint256 before) = _creatorOwed(key);
        int128 hookDelta = _feeAfter(key, params, delta);
        _divert(id, quote, creator, before);

        FeeConfig memory c = feeConfig[id];
        if (c.source != address(0) && params.zeroForOne == c.quoteIs0) {
            // A buy: the trader paid quote. delta is the swapper's balance change before the hook's own delta.
            int128 q = c.quoteIs0 ? delta.amount0() : delta.amount1();
            uint256 spent = q < 0 ? uint256(uint128(-q)) : 0;
            Pot storage p = pots[id];
            if (spent > 0 && spent * 10_000 >= uint256(p.amount) * MIN_BUY_BPS) {
                // The buyer may name who leads (smart wallets, buying for a friend); otherwise the signer leads.
                address who = hookData.length == 32 ? abi.decode(hookData, (address)) : tx.origin;
                p.leader = who;
                p.deadline = uint64(block.timestamp) + ROUND;
                emit PotBuy(id, who, spent, p.amount, p.deadline);
            }
        }
        return (this.afterSwap.selector, hookDelta);
    }

    /// @notice Anyone: pay out a finished round (the next swap does this too).
    function settle(PoolKey calldata key) external {
        Pot memory p = pots[key.toId()];
        if (p.deadline == 0 || block.timestamp <= p.deadline) revert RoundRunning(p.deadline);
        _settleIfOver(key);
    }

    /// @notice Live state of a pool's pot: amount (quote), leader, deadline, round and the buy needed to lead.
    function potOf(PoolId id)
        external
        view
        returns (uint256 amount, address leader, uint64 deadline, uint32 round, uint256 minBuy)
    {
        Pot memory p = pots[id];
        return (p.amount, p.leader, p.deadline, p.round, (uint256(p.amount) * MIN_BUY_BPS + 9_999) / 10_000);
    }

    // ------------------------------------------------------------------ internals

    function _creatorOwed(PoolKey calldata key)
        internal
        view
        returns (Currency quote, address creator, uint256 owedNow)
    {
        FeeConfig memory c = feeConfig[key.toId()];
        quote = c.quoteIs0 ? key.currency0 : key.currency1;
        creator = c.creator;
        owedNow = owed[creator][quote];
    }

    /// @dev Moves whatever the fee step just credited to the creator into the pot (the claims stay with the hook).
    function _divert(PoolId id, Currency quote, address creator, uint256 before) internal {
        uint256 added = owed[creator][quote] - before;
        if (added == 0) return;
        owed[creator][quote] = before;
        pots[id].amount += uint128(added);
    }

    function _settleIfOver(PoolKey calldata key) internal {
        PoolId id = key.toId();
        Pot storage p = pots[id];
        if (p.deadline == 0 || block.timestamp <= p.deadline) return;
        Currency quote = feeConfig[id].quoteIs0 ? key.currency0 : key.currency1;
        uint256 prize = (uint256(p.amount) * WINNER_BPS) / 10_000;
        uint256 carried = p.amount - prize;
        address winner = p.leader;
        owed[winner][quote] += prize; // withdrawn with claim(quote), like any creator fee
        uint32 round = p.round;
        p.amount = uint128(carried);
        p.deadline = 0;
        p.leader = address(0);
        p.round = round + 1;
        emit PotWon(id, winner, round, prize, carried);
    }
}
