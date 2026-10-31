// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {Position} from "@uniswap/v4-core/src/libraries/Position.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";
import {TideToken, TideTokenFactory} from "./TideToken.sol";
import {CreatorBondHook} from "./CreatorBondHook.sol";

interface ITideFeeHook {
    function registerFees(PoolKey calldata key, address creator, bool quoteIs0) external;
}

/// @title TideLauncherBase
/// @notice Shared types, storage layout and helpers for TideLauncher and its delegate TideMigrator.
///         Both inherit this and declare no storage of their own, so the layouts are identical.
abstract contract TideLauncherBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    enum Kind {
        Patience,
        Spring,
        Bond,
        Session
    }

    enum Action {
        Seed,
        Collect,
        Migrate
    }

    struct LaunchParams {
        string name;
        string symbol;
        string imageURI;
        string description;
        Kind kind;
        address quote; // address(0) = native ETH
        // Prices are ticks *as if the quote were currency0 and the token currency1*
        // (log1.0001 of raw tokens per raw quote). The launcher flips the sign when the token sorts first,
        // so a frontend never has to predict the new token's address to get the price right.
        int24 startTick; // launch price, multiple of TICK_SPACING
        uint16 creatorBps; // share of supply for the creator, max MAX_CREATOR_BPS
        int24 floorTick; // Bond only: price floor the creator promises (same orientation)
        uint64 vestDuration; // Bond only
        uint64 grace; // Bond only
    }

    struct Launch {
        address token;
        address creator;
        Kind kind;
        bool tokenIsCurrency0;
        int24 tickLower; // token-side position
        int24 tickUpper;
        int24 bidLower; // quote-side position after a migration (bidLower == bidUpper: none)
        int24 bidUpper;
        uint32 migrations;
        uint64 createdAt;
        uint64 createdBlock;
        uint64 renamedAt;
        PoolKey key;
        string name;
        string symbol;
        string imageURI;
        string description;
    }

    struct Migration {
        Kind kind;
        address quote;
        uint64 readyAt; // 0 = nothing pending
        int24 routeTick; // route spot rate at proposal (log1.0001 raw new quote per raw old quote)
        PoolId routeId; // route pool pinned at proposal; execution refuses if the admin changed it
    }

    event Launched(
        uint256 indexed id,
        address indexed token,
        address indexed creator,
        Kind kind,
        PoolId poolId,
        address quote,
        int24 startTick,
        uint256 creatorAmount
    );
    event FeesCollected(uint256 indexed id, uint256 amount0, uint256 amount1);
    event MetadataUpdated(uint256 indexed id, string name, string symbol, string imageURI, string description);
    event MigrationProposed(uint256 indexed id, Kind kind, address quote, uint64 readyAt);
    event MigrationCancelled(uint256 indexed id);
    event Migrated(
        uint256 indexed id,
        PoolId oldPoolId,
        PoolId newPoolId,
        Kind kind,
        address quote,
        int24 tick,
        uint256 tokenAmount,
        uint256 quoteAmount
    );
    event QuoteAllowed(address indexed quote, bool allowed);
    event RouteSet(address indexed currency0, address indexed currency1, PoolId poolId);
    event AdminSet(address admin);
    event FeeRecipientSet(address feeRecipient);
    event LaunchFeeSet(uint256 launchFee);
    event LpFeesRouted(uint256 indexed id, uint256 quoteToPlatform, uint256 tokenBurned);

    error NotPoolManager();
    error NotCreator();
    error NotAdmin();
    error LaunchFeeUnpaid(uint256 required);
    error EthTransferFailed();
    error UnknownLaunch();
    error BadParams(string reason);
    error RenameCooldown(uint256 readyAt);
    error NoMigration();
    error MigrationNotReady(uint256 readyAt);
    error MigrationExpired();
    error PoolExists();
    error PriceDrift(int256 drift);
    error Slippage(uint256 out, uint256 minOut);

    uint256 public constant SUPPLY = 1_000_000_000e18;
    int24 public constant TICK_SPACING = 200;
    uint24 public constant BOND_POOL_FEE = 10_000; // 1% static fee for Bond pools
    uint16 public constant MAX_CREATOR_BPS = 2_000; // 20%
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant RENAME_COOLDOWN = 1 days;
    uint256 public constant MIGRATION_DELAY = 1 days;
    uint256 public constant MIGRATION_WINDOW = 3 days;
    int24 public constant MAX_ROUTE_DRIFT = 500; // ~5%: route spot may move this much between propose and execute
    int24 public constant MAX_EXEC_DEVIATION = 300; // ~3%: route fill vs route spot (thin routes fail safe)

    IPoolManager public immutable poolManager;
    address public immutable patienceHook;
    address public immutable springHook;
    address public immutable bondHook;
    address public immutable sessionHook;

    /// @notice Curates which quote assets launches may migrate to, and the route pools used to convert.
    address public admin;
    /// @notice Platform wallet: receives the launch fee, platform trading fees and LP fees, all in ETH/quote.
    address public feeRecipient;
    /// @notice Launch fee in wei (about $3; the admin updates it as the ETH price moves).
    uint256 public launchFee;
    mapping(address => bool) public quoteAllowed;
    mapping(bytes32 => PoolKey) internal _routes;

    Launch[] internal _launches;
    /// @notice token => launch id + 1 (0 = not a tidehook token)
    mapping(address => uint256) public launchIdPlusOne;
    mapping(uint256 => Migration) public pendingMigration;
    mapping(uint256 => PoolId[]) internal _pastPools;

    constructor(IPoolManager _poolManager, address _patience, address _spring, address _bond, address _session) {
        poolManager = _poolManager;
        patienceHook = _patience;
        springHook = _spring;
        bondHook = _bond;
        sessionHook = _session;
    }

    function _get(uint256 id) internal view returns (Launch storage) {
        if (id >= _launches.length) revert UnknownLaunch();
        return _launches[id];
    }

    function _quoteOf(Launch storage l) internal view returns (address) {
        return Currency.unwrap(l.tokenIsCurrency0 ? l.key.currency1 : l.key.currency0);
    }

    function _keyFor(address token, address quote, Kind kind) internal view returns (PoolKey memory) {
        bool tokenIs0 = token < quote;
        return PoolKey({
            currency0: Currency.wrap(tokenIs0 ? token : quote),
            currency1: Currency.wrap(tokenIs0 ? quote : token),
            fee: kind == Kind.Bond ? BOND_POOL_FEE : LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(_hookFor(kind))
        });
    }

    /// @dev Route spot rate as a tick: log1.0001 of raw `to` per raw `from`.
    function _routeRate(address from, address to) internal view returns (int24) {
        PoolKey memory route = _routes[_pairKey(from, to)];
        if (route.tickSpacing == 0) revert BadParams("no route");
        (, int24 routeTick,,) = poolManager.getSlot0(route.toId());
        return Currency.unwrap(route.currency0) == from ? routeTick : -routeTick;
    }

    function _hookFor(Kind k) internal view returns (address) {
        if (k == Kind.Patience) return patienceHook;
        if (k == Kind.Spring) return springHook;
        if (k == Kind.Bond) return bondHook;
        return sessionHook;
    }

    function _align(int24 t) internal pure returns (int24) {
        int24 r = t % TICK_SPACING;
        t -= r;
        if (r * 2 >= TICK_SPACING) t += TICK_SPACING;
        else if (r * 2 <= -TICK_SPACING) t -= TICK_SPACING;
        return t;
    }

    /// @dev Turns on the hook's launchpad fees for a pool this contract initialized.
    function _registerFees(PoolKey memory key, address creator, bool tokenIs0) internal {
        ITideFeeHook(address(key.hooks)).registerFees(key, creator, !tokenIs0);
    }

    /// @dev LP fees from the locked liquidity: the quote side goes to the platform wallet, the token side is burned,
    ///      so nobody ever gets paid in the launched token.
    function _routeLpFees(uint256 id, PoolKey memory key, bool tokenIs0, uint256 a0, uint256 a1) internal {
        (Currency quote, uint256 q, Currency token, uint256 t) =
            tokenIs0 ? (key.currency1, a1, key.currency0, a0) : (key.currency0, a0, key.currency1, a1);
        if (q > 0) poolManager.take(quote, feeRecipient, q);
        if (t > 0) poolManager.take(token, BURN, t);
        if (q + t > 0) emit LpFeesRouted(id, q, t);
    }

    function _pairKey(address a, address b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function _saltA(uint256 id) internal pure returns (bytes32) {
        return bytes32(id);
    }

    function _saltB(uint256 id) internal pure returns (bytes32) {
        return bytes32(id | (1 << 255));
    }

    function _pos(int128 x) internal pure returns (uint256) {
        return x > 0 ? uint256(uint128(x)) : 0;
    }

    /// @dev Adds `amount` of one currency as single-sided liquidity; returns what the pool took (0 if too small).
    function _addLiquidity(PoolKey memory key, int24 lower, int24 upper, uint256 amount, bool inCurrency0, bytes32 salt)
        internal
        returns (uint256)
    {
        if (amount == 0) return 0;
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(lower);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(upper);
        uint128 liquidity = inCurrency0
            ? LiquidityAmounts.getLiquidityForAmount0(sqrtLower, sqrtUpper, amount)
            : LiquidityAmounts.getLiquidityForAmount1(sqrtLower, sqrtUpper, amount);
        if (liquidity == 0) return 0;
        (BalanceDelta d,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: lower, tickUpper: upper, liquidityDelta: int256(uint256(liquidity)), salt: salt
            }),
            ""
        );
        int128 owed = inCurrency0 ? d.amount0() : d.amount1();
        return uint256(uint128(-owed));
    }
}
