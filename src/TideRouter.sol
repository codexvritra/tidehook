// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";

/// @title TideRouter
/// @notice Minimal exact-input router for any Uniswap v4 pool, tidehook or not.
///         - native ETH in/out, excess ETH refunded
///         - slippage floor (`minOut`) and deadline
///         - `hookData` passed straight to the hook (PatienceHook reveals ride on this)
///         - `quoteExactIn`: an on-chain quote that runs the real swap and reverts with the result
contract TideRouter is IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using SafeTransferLib for ERC20;

    struct Swap {
        PoolKey key;
        bool zeroForOne;
        uint128 amountIn;
        uint128 minOut;
        uint160 sqrtPriceLimitX96; // 0 = no limit
        bytes hookData;
    }

    event Trade(PoolId indexed poolId, address indexed trader, bool zeroForOne, uint256 amountIn, uint256 amountOut);

    error NotPoolManager();
    error Expired();
    error TooLittleReceived(uint256 amountOut, uint256 minOut);
    error BadValue();
    error RefundFailed();
    error QuoteResult(uint256 amountIn, uint256 amountOut);

    IPoolManager public immutable poolManager;

    constructor(IPoolManager _poolManager) {
        poolManager = _poolManager;
    }

    function swapExactIn(Swap calldata s, address recipient, uint256 deadline)
        external
        payable
        returns (uint256 amountIn, uint256 amountOut)
    {
        if (block.timestamp > deadline) revert Expired();
        Currency cin = s.zeroForOne ? s.key.currency0 : s.key.currency1;
        if (!cin.isAddressZero() && msg.value != 0) revert BadValue();
        if (cin.isAddressZero() && msg.value < s.amountIn) revert BadValue();

        (amountIn, amountOut) =
            abi.decode(poolManager.unlock(abi.encode(false, msg.sender, recipient, s)), (uint256, uint256));
        if (amountOut < s.minOut) revert TooLittleReceived(amountOut, s.minOut);

        if (cin.isAddressZero() && msg.value > amountIn) {
            (bool ok,) = msg.sender.call{value: msg.value - amountIn}("");
            if (!ok) revert RefundFailed();
        }
        emit Trade(s.key.toId(), msg.sender, s.zeroForOne, amountIn, amountOut);
    }

    /// @notice Simulates the swap against live state. Call with eth_call; it never changes state.
    function quoteExactIn(Swap calldata s) external returns (uint256 amountIn, uint256 amountOut) {
        try poolManager.unlock(abi.encode(true, address(0), address(0), s)) {
            revert();
        } catch (bytes memory reason) {
            if (reason.length != 68 || bytes4(reason) != QuoteResult.selector) {
                assembly ("memory-safe") {
                    revert(add(reason, 32), mload(reason))
                }
            }
            assembly ("memory-safe") {
                amountIn := mload(add(reason, 36))
                amountOut := mload(add(reason, 68))
            }
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (bool quote, address payer, address recipient, Swap memory s) = abi.decode(data, (bool, address, address, Swap));

        uint160 limit = s.sqrtPriceLimitX96 != 0
            ? s.sqrtPriceLimitX96
            : (s.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
        BalanceDelta d = poolManager.swap(
            s.key,
            SwapParams({
                zeroForOne: s.zeroForOne, amountSpecified: -int256(uint256(s.amountIn)), sqrtPriceLimitX96: limit
            }),
            s.hookData
        );

        (int128 inDelta, int128 outDelta) = s.zeroForOne ? (d.amount0(), d.amount1()) : (d.amount1(), d.amount0());
        uint256 paid = uint256(uint128(-inDelta));
        uint256 got = uint256(uint128(outDelta));
        if (quote) revert QuoteResult(paid, got);

        (Currency cin, Currency cout) =
            s.zeroForOne ? (s.key.currency0, s.key.currency1) : (s.key.currency1, s.key.currency0);
        if (cin.isAddressZero()) {
            poolManager.settle{value: paid}();
        } else {
            poolManager.sync(cin);
            ERC20(Currency.unwrap(cin)).safeTransferFrom(payer, address(poolManager), paid);
            poolManager.settle();
        }
        if (got > 0) poolManager.take(cout, recipient, got);
        return abi.encode(paid, got);
    }
}
