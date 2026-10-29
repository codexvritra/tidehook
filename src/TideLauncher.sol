// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";
import {TideToken} from "./TideToken.sol";
import {CreatorBondHook} from "./CreatorBondHook.sol";

/// @title TideLauncher
/// @notice One transaction launches a token on Uniswap v4 behind a tidehook:
///         1. deploys a fixed-supply TideToken (1B, 18 decimals),
///         2. initializes its pool against ETH or any ERC20 quote asset at the creator's start price,
///         3. seeds the whole public supply as single-sided liquidity and locks it here forever,
///         4. bonds the creator's allocation in CreatorBondHook, or pays it out for other hooks.
///         The locked position keeps earning swap fees; only the creator can collect them.
contract TideLauncher is IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeTransferLib for ERC20;

    enum Kind {
        Patience,
        Spring,
        Bond,
        Session
    }

    enum Action {
        Seed,
        Collect
    }

    struct LaunchParams {
        string name;
        string symbol;
        string imageURI;
        string description;
        Kind kind;
        address quote; // address(0) = native ETH
        // Prices are given as ticks *as if the quote were currency0 and the token currency1*
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
        int24 tickLower;
        int24 tickUpper;
        uint64 createdAt;
        uint64 createdBlock;
        PoolKey key;
        string name;
        string symbol;
        string imageURI;
        string description;
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

    error NotPoolManager();
    error NotCreator();
    error UnknownLaunch();
    error BadParams(string reason);

    uint256 public constant SUPPLY = 1_000_000_000e18;
    int24 public constant TICK_SPACING = 200;
    uint24 public constant BOND_POOL_FEE = 10_000; // 1% static fee for Bond pools
    uint16 public constant MAX_CREATOR_BPS = 2_000; // 20%
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    IPoolManager public immutable poolManager;
    address public immutable patienceHook;
    address public immutable springHook;
    address public immutable bondHook;
    address public immutable sessionHook;

    Launch[] internal _launches;
    /// @notice token => launch id + 1 (0 = not a tidehook token)
    mapping(address => uint256) public launchIdPlusOne;

    constructor(IPoolManager _poolManager, address _patience, address _spring, address _bond, address _session) {
        poolManager = _poolManager;
        patienceHook = _patience;
        springHook = _spring;
        bondHook = _bond;
        sessionHook = _session;
    }

    // ------------------------------------------------------------------ launch

    function launch(LaunchParams calldata p) external returns (uint256 id, address token) {
        _validate(p);

        token = address(new TideToken(p.name, p.symbol, SUPPLY, address(this)));
        id = _launches.length;
        Launch storage l = _launches.push();
        l.token = token;
        l.creator = msg.sender;
        l.kind = p.kind;
        l.createdAt = uint64(block.timestamp);
        l.createdBlock = uint64(block.number);
        l.name = p.name;
        l.symbol = p.symbol;
        l.imageURI = p.imageURI;
        l.description = p.description;
        launchIdPlusOne[token] = id + 1;

        uint256 creatorAmount = (SUPPLY * p.creatorBps) / 10_000;
        bool tokenIs0 = token < p.quote;
        int24 startTick = tokenIs0 ? -p.startTick : p.startTick;
        _openPool(l, p.quote, startTick, SUPPLY - creatorAmount, id);
        _payCreator(l, p, creatorAmount);

        // Rounding dust from the liquidity math is burned, never kept.
        uint256 dust = ERC20(token).balanceOf(address(this));
        if (dust > 0) ERC20(token).safeTransfer(BURN, dust);

        emit Launched(id, token, msg.sender, p.kind, l.key.toId(), p.quote, startTick, creatorAmount);
    }

    /// @dev Builds the key, initializes at the start price and seeds `amount` tokens as single-sided liquidity.
    function _openPool(Launch storage l, address quote, int24 startTick, uint256 amount, uint256 id) internal {
        bool tokenIs0 = l.token < quote;
        l.tokenIsCurrency0 = tokenIs0;
        l.key = PoolKey({
            currency0: Currency.wrap(tokenIs0 ? l.token : quote),
            currency1: Currency.wrap(tokenIs0 ? quote : l.token),
            fee: l.kind == Kind.Bond ? BOND_POOL_FEE : LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(_hookFor(l.kind))
        });

        // The range holds only the token and starts exactly at the launch price.
        (l.tickLower, l.tickUpper) = tokenIs0
            ? (startTick, TickMath.maxUsableTick(TICK_SPACING))
            : (TickMath.minUsableTick(TICK_SPACING), startTick);
        if (l.tickLower >= l.tickUpper) revert BadParams("range");

        PoolKey memory key = l.key;
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(startTick));
        poolManager.unlock(abi.encode(Action.Seed, abi.encode(key, l.tickLower, l.tickUpper, amount, tokenIs0, id)));
    }

    function _payCreator(Launch storage l, LaunchParams calldata p, uint256 amount) internal {
        if (amount == 0) return;
        if (p.kind == Kind.Bond) {
            ERC20(l.token).safeApprove(bondHook, amount);
            int24 floorTick = l.tokenIsCurrency0 ? -p.floorTick : p.floorTick;
            CreatorBondHook(bondHook)
                .bond(l.key, l.tokenIsCurrency0, uint128(amount), floorTick, p.vestDuration, p.grace, msg.sender);
        } else {
            ERC20(l.token).safeTransfer(msg.sender, amount);
        }
    }

    /// @notice Creator collects the swap fees earned by the locked launch liquidity.
    function collectFees(uint256 id) external returns (uint256 amount0, uint256 amount1) {
        Launch storage l = _get(id);
        if (msg.sender != l.creator) revert NotCreator();
        (amount0, amount1) = abi.decode(
            poolManager.unlock(abi.encode(Action.Collect, abi.encode(l.key, l.tickLower, l.tickUpper, id, l.creator))),
            (uint256, uint256)
        );
        emit FeesCollected(id, amount0, amount1);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (Action action, bytes memory inner) = abi.decode(data, (Action, bytes));
        return action == Action.Seed ? _seed(inner) : _collect(inner);
    }

    function _seed(bytes memory inner) internal returns (bytes memory) {
        (PoolKey memory key, int24 lower, int24 upper, uint256 amount, bool tokenIs0, uint256 id) =
            abi.decode(inner, (PoolKey, int24, int24, uint256, bool, uint256));
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(lower);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(upper);
        uint128 liquidity = tokenIs0
            ? LiquidityAmounts.getLiquidityForAmount0(sqrtLower, sqrtUpper, amount)
            : LiquidityAmounts.getLiquidityForAmount1(sqrtLower, sqrtUpper, amount);
        if (liquidity == 0) revert BadParams("liquidity");

        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: lower, tickUpper: upper, liquidityDelta: int256(uint256(liquidity)), salt: bytes32(id)
            }),
            ""
        );

        Currency token = tokenIs0 ? key.currency0 : key.currency1;
        int128 owed = tokenIs0 ? delta.amount0() : delta.amount1();
        poolManager.sync(token);
        ERC20(Currency.unwrap(token)).safeTransfer(address(poolManager), uint256(uint128(-owed)));
        poolManager.settle();
        return "";
    }

    function _collect(bytes memory inner) internal returns (bytes memory) {
        (PoolKey memory key, int24 lower, int24 upper, uint256 id, address to) =
            abi.decode(inner, (PoolKey, int24, int24, uint256, address));
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: 0, salt: bytes32(id)}), ""
        );
        uint256 a0 = delta.amount0() > 0 ? uint256(uint128(delta.amount0())) : 0;
        uint256 a1 = delta.amount1() > 0 ? uint256(uint128(delta.amount1())) : 0;
        if (a0 > 0) poolManager.take(key.currency0, to, a0);
        if (a1 > 0) poolManager.take(key.currency1, to, a1);
        return abi.encode(a0, a1);
    }

    // ------------------------------------------------------------------ views

    function launchCount() external view returns (uint256) {
        return _launches.length;
    }

    function getLaunch(uint256 id) external view returns (Launch memory) {
        return _get(id);
    }

    /// @notice Newest-first page of launches, with each pool's live price, for an indexer-free frontend.
    function getLaunches(uint256 offset, uint256 limit)
        external
        view
        returns (Launch[] memory page, uint160[] memory sqrtPrices, int24[] memory ticks)
    {
        uint256 n = _launches.length;
        if (offset >= n) return (page, sqrtPrices, ticks);
        uint256 count = n - offset < limit ? n - offset : limit;
        page = new Launch[](count);
        sqrtPrices = new uint160[](count);
        ticks = new int24[](count);
        for (uint256 i; i < count; ++i) {
            Launch storage l = _launches[n - 1 - offset - i];
            page[i] = l;
            (sqrtPrices[i], ticks[i],,) = poolManager.getSlot0(l.key.toId());
        }
    }

    function poolIdOf(uint256 id) external view returns (PoolId) {
        return _get(id).key.toId();
    }

    // ------------------------------------------------------------------ internal

    function _get(uint256 id) internal view returns (Launch storage) {
        if (id >= _launches.length) revert UnknownLaunch();
        return _launches[id];
    }

    function _hookFor(Kind k) internal view returns (address) {
        if (k == Kind.Patience) return patienceHook;
        if (k == Kind.Spring) return springHook;
        if (k == Kind.Bond) return bondHook;
        return sessionHook;
    }

    function _validate(LaunchParams calldata p) internal pure {
        uint256 nl = bytes(p.name).length;
        uint256 sl = bytes(p.symbol).length;
        if (nl == 0 || nl > 32) revert BadParams("name");
        if (sl == 0 || sl > 12) revert BadParams("symbol");
        if (bytes(p.imageURI).length > 256 || bytes(p.description).length > 512) revert BadParams("metadata");
        if (p.creatorBps > MAX_CREATOR_BPS) revert BadParams("creatorBps");
        if (p.startTick % TICK_SPACING != 0) revert BadParams("startTick");
        if (p.startTick <= TickMath.minUsableTick(TICK_SPACING) || p.startTick >= TickMath.maxUsableTick(TICK_SPACING))
        {
            revert BadParams("startTick");
        }
        if (p.kind == Kind.Bond && (p.creatorBps == 0 || p.vestDuration == 0)) revert BadParams("bond");
    }
}
