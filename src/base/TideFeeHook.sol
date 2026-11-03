// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    toBeforeSwapDelta
} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TideBaseHook} from "./TideBaseHook.sol";

/// @notice The launchpad that registered a pool names its platform wallet here.
interface ITideFeeSource {
    function feeRecipient() external view returns (address);
}

/// @title TideFeeHook
/// @notice Launchpad trading fees, enforced inside the hook so no router can skip them:
///         - buy  (quote in, token out): 1% to the token's creator + 1% to the platform,
///         - sell (token in, quote out): 2% to the platform.
///         Fees are always taken in the pool's quote asset (ETH for ETH pairs), never in the launched token,
///         via v4 return-deltas: exact-input buys and exact-output sells in beforeSwap, the other two in afterSwap.
///         Fees accrue as ERC-6909 claims on the PoolManager (no token moves mid-swap, so a payee that
///         rejects ETH can never block trading) and are paid out in the quote asset on claim.
///         Only pools whose initializer registered them pay fees; anyone else using these hooks pays none.
abstract contract TideFeeHook is TideBaseHook, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    struct FeeConfig {
        address creator;
        address source; // launchpad contract; its feeRecipient() is the platform wallet
        bool quoteIs0;
    }

    event FeesRegistered(PoolId indexed poolId, address indexed creator, address indexed source, bool quoteIs0);
    event FeeTaken(PoolId indexed poolId, Currency currency, bool buy, uint256 toCreator, uint256 toPlatform);
    event FeesClaimed(address indexed account, address indexed to, Currency currency, uint256 amount);

    error NotInitializer();
    error NothingToClaim();

    uint256 public constant BUY_CREATOR_BPS = 100; // 1%
    uint256 public constant BUY_PLATFORM_BPS = 100; // 1%
    uint256 public constant SELL_PLATFORM_BPS = 200; // 2%

    /// @notice Address that called PoolManager.initialize for each pool.
    mapping(PoolId => address) public initializerOf;
    mapping(PoolId => FeeConfig) public feeConfig;
    /// @notice Unclaimed fees: creator or launchpad (platform) => currency => amount.
    mapping(address => mapping(Currency => uint256)) public owed;

    constructor(IPoolManager _poolManager) TideBaseHook(_poolManager) {}

    /// @notice The pool's initializer (the launchpad) turns on fees and names the creator.
    function registerFees(PoolKey calldata key, address creator, bool quoteIs0) external {
        PoolId id = key.toId();
        if (msg.sender != initializerOf[id] || address(key.hooks) != address(this)) revert NotInitializer();
        feeConfig[id] = FeeConfig({creator: creator, source: msg.sender, quoteIs0: quoteIs0});
        emit FeesRegistered(id, creator, msg.sender, quoteIs0);
    }

    /// @notice Creator: withdraw your fees in `currency` (address(0) = ETH).
    function claim(Currency currency) external returns (uint256) {
        return _payout(msg.sender, msg.sender, currency);
    }

    /// @notice Anyone: send a launchpad's platform fees to its current platform wallet.
    function claimPlatform(address source, Currency currency) external returns (uint256) {
        return _payout(source, ITideFeeSource(source).feeRecipient(), currency);
    }

    function _payout(address account, address to, Currency currency) internal returns (uint256 amount) {
        amount = owed[account][currency];
        if (amount == 0) revert NothingToClaim();
        owed[account][currency] = 0;
        poolManager.unlock(abi.encode(currency, to, amount));
        emit FeesClaimed(account, to, currency, amount);
    }

    /// @dev Redeems the hook's ERC-6909 claims for real tokens straight to the payee.
    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (Currency currency, address to, uint256 amount) = abi.decode(data, (Currency, address, uint256));
        poolManager.burn(address(this), currency.toId(), amount);
        poolManager.take(currency, to, amount);
        return "";
    }

    // ------------------------------------------------------------------ swap hooks

    function _recordInitializer(address sender, PoolKey calldata key) internal {
        initializerOf[key.toId()] = sender;
    }

    /// @dev Launchpad pools pay exactly the launchpad tax (2%) and no LP fee on top of it.
    ///      Pools nobody registered keep the hook's own fee logic.
    function _lpFee(PoolKey calldata key, uint24 fee) internal view returns (uint24) {
        return feeConfig[key.toId()].source == address(0) ? fee : 0;
    }

    /// @dev Charges fees when the quote asset is the swap's specified currency.
    function _feeBefore(PoolKey calldata key, SwapParams calldata p) internal returns (BeforeSwapDelta) {
        FeeConfig memory c = feeConfig[key.toId()];
        if (c.source == address(0)) return BeforeSwapDeltaLibrary.ZERO_DELTA;
        bool buy = p.zeroForOne == c.quoteIs0;
        bool exactIn = p.amountSpecified < 0;
        if (exactIn != buy) return BeforeSwapDeltaLibrary.ZERO_DELTA; // quote is unspecified: afterSwap charges
        uint256 amount = exactIn ? uint256(-p.amountSpecified) : uint256(p.amountSpecified);
        uint256 fee = _charge(key, c, buy, amount);
        return toBeforeSwapDelta(int128(int256(fee)), 0);
    }

    /// @dev Charges fees when the quote asset is the swap's unspecified currency.
    function _feeAfter(PoolKey calldata key, SwapParams calldata p, BalanceDelta d) internal returns (int128) {
        FeeConfig memory c = feeConfig[key.toId()];
        if (c.source == address(0)) return 0;
        bool buy = p.zeroForOne == c.quoteIs0;
        bool exactIn = p.amountSpecified < 0;
        if (exactIn == buy) return 0; // already charged in beforeSwap
        int128 q = c.quoteIs0 ? d.amount0() : d.amount1();
        uint256 amount = q < 0 ? uint256(int256(-q)) : uint256(int256(q));
        return int128(int256(_charge(key, c, buy, amount)));
    }

    function _charge(PoolKey calldata key, FeeConfig memory c, bool buy, uint256 amount)
        internal
        returns (uint256 fee)
    {
        uint256 toCreator = buy ? (amount * BUY_CREATOR_BPS) / 10_000 : 0;
        uint256 toPlatform = (amount * (buy ? BUY_PLATFORM_BPS : SELL_PLATFORM_BPS)) / 10_000;
        fee = toCreator + toPlatform;
        if (fee == 0) return 0;
        Currency quote = c.quoteIs0 ? key.currency0 : key.currency1;
        // Mint ERC-6909 claims instead of moving tokens: settled by the swapper through the returned delta.
        poolManager.mint(address(this), quote.toId(), fee);
        owed[c.creator][quote] += toCreator;
        owed[c.source][quote] += toPlatform;
        emit FeeTaken(key.toId(), quote, buy, toCreator, toPlatform);
    }

    /// @dev Default afterSwap: fees only. Hooks with their own afterSwap logic call _feeAfter themselves.
    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        virtual
        override
        onlyPoolManager
        returns (bytes4, int128)
    {
        return (this.afterSwap.selector, _feeAfter(key, params, delta));
    }
}
