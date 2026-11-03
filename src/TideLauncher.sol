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
import {TideLauncherBase} from "./TideLauncherBase.sol";
import {TideMigrator} from "./TideMigrator.sol";
import {CreatorBondHook} from "./CreatorBondHook.sol";

/// @title TideLauncher
/// @notice One transaction launches a token on Uniswap v4 behind a tidehook:
///         1. deploys a fixed-supply TideToken (1B, 18 decimals),
///         2. initializes its pool against ETH or any ERC20 at the creator's start price,
///         3. seeds the whole public supply as single-sided liquidity reaching the v4 maximum price
///            (no market-cap ceiling, no graduation step, nothing to get stuck on), held here forever,
///         4. bonds the creator's allocation (optional, Bond launches only) in CreatorBondHook, vesting >= 30 days.
///
///         After launch the creator can:
///         - claim 1% of every buy in ETH from the hook (trades pay exactly the 2% launchpad tax, no LP fee),
///         - hand the launch to a new wallet (two-step),
///         - rename the token (name, symbol, image, description), at most once per RENAME_COOLDOWN,
///         - migrate the locked liquidity to a new pool with a different hook and/or pair. A v4 pool's
///           hook and currencies are fixed in its PoolKey, so "upgrading" either means moving liquidity.
///           Migration is announced on-chain and executable only after MIGRATION_DELAY, keeps the price,
///           and may only switch to admin-allowlisted quote assets through admin-registered route pools.
///           Bond launches can't migrate: their escrow is tied to the original pool's price.
contract TideLauncher is TideLauncherBase, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeTransferLib for ERC20;

    TideTokenFactory public immutable tokenFactory;
    TideMigrator public immutable migrator;

    constructor(
        IPoolManager _poolManager,
        TideTokenFactory _factory,
        TideMigrator _migrator,
        address _patience,
        address _spring,
        address _bond,
        address _session
    ) TideLauncherBase(_poolManager, _patience, _spring, _bond, _session) {
        tokenFactory = _factory;
        migrator = _migrator;
        // The deploying EOA administers routes; keeps the CREATE2 init code independent of who deploys.
        admin = tx.origin;
        feeRecipient = tx.origin;
        launchFee = 0.001 ether;
        quoteAllowed[address(0)] = true;
    }

    /// @notice Pay `launchFee` in ETH; anything sent above it is refunded.
    function launch(LaunchParams calldata p) external payable returns (uint256 id, address token) {
        if (msg.value < launchFee) revert LaunchFeeUnpaid(launchFee);
        _validate(p);

        token = tokenFactory.create(p.name, p.symbol, SUPPLY, address(this));
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
        _sendEth(feeRecipient, launchFee);
        if (msg.value > launchFee) _sendEth(msg.sender, msg.value - launchFee);

        // Rounding dust from the liquidity math is burned, never kept.
        uint256 dust = ERC20(token).balanceOf(address(this));
        if (dust > 0) ERC20(token).safeTransfer(BURN, dust);

        emit Launched(id, token, msg.sender, p.kind, l.key.toId(), p.quote, startTick, creatorAmount);
    }

    /// @dev Builds the key, initializes at the start price and seeds `amount` tokens as single-sided liquidity.
    function _openPool(Launch storage l, address quote, int24 startTick, uint256 amount, uint256 id) internal {
        bool tokenIs0 = l.token < quote;
        l.tokenIsCurrency0 = tokenIs0;
        l.key = _keyFor(l.token, quote, l.kind);
        (l.tickLower, l.tickUpper) = tokenIs0
            ? (startTick, TickMath.maxUsableTick(TICK_SPACING))
            : (TickMath.minUsableTick(TICK_SPACING), startTick);
        if (l.tickLower >= l.tickUpper) revert BadParams("range");

        PoolKey memory key = l.key;
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(startTick));
        _registerFees(key, l.creator, tokenIs0);
        poolManager.unlock(abi.encode(Action.Seed, abi.encode(key, l.tickLower, l.tickUpper, amount, tokenIs0, id)));
    }

    function _payCreator(Launch storage l, LaunchParams calldata p, uint256 amount) internal {
        if (amount == 0) return;
        // _validate allows an allocation only on Bond launches: it vests and is slashable, never paid out liquid.
        ERC20(l.token).safeApprove(bondHook, amount);
        int24 floorTick = l.tokenIsCurrency0 ? -p.floorTick : p.floorTick;
        CreatorBondHook(bondHook)
            .bond(l.key, l.tokenIsCurrency0, uint128(amount), floorTick, p.vestDuration, p.grace, msg.sender);
    }

    /// @notice Rename the token and update its listing. The ERC20 `name()`/`symbol()` change on-chain.
    function updateMetadata(
        uint256 id,
        string calldata name,
        string calldata symbol,
        string calldata imageURI,
        string calldata description
    ) external {
        Launch storage l = _creatorOf(id);
        _validateMeta(name, symbol, imageURI, description);
        if (l.renamedAt != 0 && block.timestamp < l.renamedAt + RENAME_COOLDOWN) {
            revert RenameCooldown(l.renamedAt + RENAME_COOLDOWN);
        }
        l.renamedAt = uint64(block.timestamp);
        l.name = name;
        l.symbol = symbol;
        l.imageURI = imageURI;
        l.description = description;
        TideToken(l.token).setMetadata(name, symbol);
        emit MetadataUpdated(id, name, symbol, imageURI, description);
    }

    /// @notice Announce a move of the locked liquidity to a new hook and/or pair. Executable after the delay.
    function proposeMigration(uint256 id, Kind kind, address quote) external {
        Launch storage l = _creatorOf(id);
        if (l.kind == Kind.Bond || kind == Kind.Bond) revert BadParams("bond");
        address oldQuote = _quoteOf(l);
        if (kind == l.kind && quote == oldQuote) revert BadParams("same pool");
        if (quote == l.token) revert BadParams("quote");

        int24 routeTick;
        PoolId routeId;
        if (quote != oldQuote) {
            if (!quoteAllowed[quote]) revert BadParams("quote not allowed");
            routeTick = _routeRate(oldQuote, quote);
            routeId = _routes[_pairKey(oldQuote, quote)].toId();
        }
        uint64 readyAt = uint64(block.timestamp + MIGRATION_DELAY);
        pendingMigration[id] =
            Migration({kind: kind, quote: quote, readyAt: readyAt, routeTick: routeTick, routeId: routeId});
        emit MigrationProposed(id, kind, quote, readyAt);
    }

    function cancelMigration(uint256 id) external {
        _creatorOf(id);
        if (pendingMigration[id].readyAt == 0) revert NoMigration();
        delete pendingMigration[id];
        emit MigrationCancelled(id);
    }

    /// @param minQuoteOut Floor on the new quote asset received when converting the pool's old quote holdings.
    function executeMigration(uint256 id, uint256 minQuoteOut) external {
        _creatorOf(id);
        Migration memory m = pendingMigration[id];
        if (m.readyAt == 0) revert NoMigration();
        if (block.timestamp < m.readyAt) revert MigrationNotReady(m.readyAt);
        if (block.timestamp > m.readyAt + MIGRATION_WINDOW) revert MigrationExpired();
        delete pendingMigration[id];
        poolManager.unlock(abi.encode(Action.Migrate, abi.encode(id, m, minQuoteOut)));
    }

    function setQuoteAllowed(address quote, bool allowed) external {
        _onlyAdmin();
        quoteAllowed[quote] = allowed;
        emit QuoteAllowed(quote, allowed);
    }

    /// @notice Register the canonical v4 pool used to convert between its two currencies during migrations.
    function setRoute(PoolKey calldata key) external {
        _onlyAdmin();
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        if (sqrtPriceX96 == 0) revert BadParams("route not initialized");
        _routes[_pairKey(Currency.unwrap(key.currency0), Currency.unwrap(key.currency1))] = key;
        emit RouteSet(Currency.unwrap(key.currency0), Currency.unwrap(key.currency1), key.toId());
    }

    /// @notice Announce a new platform wallet. Anyone can apply it after GOVERNANCE_DELAY; re-proposing replaces
    ///         the pending one. A leaked admin key can't silently redirect fees: the switch is public for 2 days.
    function proposeFeeRecipient(address wallet) external {
        _onlyAdmin();
        if (wallet == address(0)) revert BadParams("wallet");
        pendingFeeRecipient = wallet;
        uint64 readyAt = uint64(block.timestamp + GOVERNANCE_DELAY);
        pendingFeeRecipientReadyAt = readyAt;
        emit FeeRecipientProposed(wallet, readyAt);
    }

    function applyFeeRecipient() external {
        address wallet = pendingFeeRecipient;
        if (wallet == address(0)) revert BadParams("none");
        _ready(pendingFeeRecipientReadyAt);
        feeRecipient = wallet;
        delete pendingFeeRecipient;
        delete pendingFeeRecipientReadyAt;
        emit FeeRecipientSet(wallet);
    }

    function setLaunchFee(uint256 fee) external {
        _onlyAdmin();
        if (fee > MAX_LAUNCH_FEE) revert BadParams("fee");
        launchFee = fee;
        emit LaunchFeeSet(fee);
    }

    function _sendEth(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }

    /// @notice Two-step, delayed admin handover: the new admin accepts after GOVERNANCE_DELAY
    ///         (a typo can't brick the admin, a leaked key can't take over unseen). address(0) cancels.
    function proposeAdmin(address newAdmin) external {
        _onlyAdmin();
        pendingAdmin = newAdmin;
        uint64 readyAt = uint64(block.timestamp + GOVERNANCE_DELAY);
        pendingAdminReadyAt = readyAt;
        emit AdminProposed(newAdmin, readyAt);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotAdmin();
        _ready(pendingAdminReadyAt);
        admin = msg.sender;
        delete pendingAdmin;
        delete pendingAdminReadyAt;
        emit AdminSet(msg.sender);
    }

    /// @notice Creator: hand the launch (fee rights, rename, migration) to a new wallet, which must accept.
    ///         address(0) cancels. Lets a creator move off a compromised or shared wallet.
    function transferCreator(uint256 id, address to) external {
        _creatorOf(id);
        pendingCreator[id] = to;
        emit CreatorTransferProposed(id, to);
    }

    function acceptCreator(uint256 id) external {
        Launch storage l = _get(id);
        if (msg.sender != pendingCreator[id]) revert NotCreator();
        address from = l.creator;
        delete pendingCreator[id];
        delete pendingMigration[id]; // the old creator's pending migration does not carry over
        l.creator = msg.sender;
        _registerFees(l.key, msg.sender, l.tokenIsCurrency0); // future 1% buy fees go to the new creator
        emit CreatorTransferred(id, from, msg.sender);
    }

    function _onlyAdmin() internal view {
        if (msg.sender != admin) revert NotAdmin();
    }

    function _ready(uint256 readyAt) internal view {
        if (block.timestamp < readyAt) revert NotReady(readyAt);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (Action action, bytes memory inner) = abi.decode(data, (Action, bytes));
        if (action == Action.Seed) return _seed(inner);
        (uint256 id, Migration memory m, uint256 minQuoteOut) = abi.decode(inner, (uint256, Migration, uint256));
        (bool ok, bytes memory ret) =
            address(migrator).delegatecall(abi.encodeCall(TideMigrator.migrate, (id, m, minQuoteOut)));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        return "";
    }

    function _seed(bytes memory inner) internal returns (bytes memory) {
        (PoolKey memory key, int24 lower, int24 upper, uint256 amount, bool tokenIs0, uint256 id) =
            abi.decode(inner, (PoolKey, int24, int24, uint256, bool, uint256));
        uint256 owed = _addLiquidity(key, lower, upper, amount, tokenIs0, _saltA(id));
        if (owed == 0) revert BadParams("liquidity");
        Currency token = tokenIs0 ? key.currency0 : key.currency1;
        poolManager.sync(token);
        ERC20(Currency.unwrap(token)).safeTransfer(address(poolManager), owed);
        poolManager.settle();
        return "";
    }

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

    /// @notice Pools this launch has migrated away from, oldest first.
    function pastPools(uint256 id) external view returns (PoolId[] memory) {
        return _pastPools[id];
    }

    function routeFor(address a, address b) external view returns (PoolKey memory) {
        return _routes[_pairKey(a, b)];
    }

    function _creatorOf(uint256 id) internal view returns (Launch storage l) {
        l = _get(id);
        if (msg.sender != l.creator) revert NotCreator();
    }

    function _validate(LaunchParams calldata p) internal pure {
        _validateMeta(p.name, p.symbol, p.imageURI, p.description);
        if (p.creatorBps > MAX_CREATOR_BPS) revert BadParams("creatorBps");
        if (p.startTick % TICK_SPACING != 0) revert BadParams("startTick");
        if (p.startTick <= TickMath.minUsableTick(TICK_SPACING) || p.startTick >= TickMath.maxUsableTick(TICK_SPACING))
        {
            revert BadParams("startTick");
        }
        if (p.kind == Kind.Bond) {
            if (p.creatorBps == 0 || p.vestDuration < MIN_CREATOR_VEST) revert BadParams("bond");
        } else if (p.creatorBps != 0) {
            revert BadParams("creatorBps"); // creator allocations must be bonded and vested
        }
    }

    function _validateMeta(
        string calldata name,
        string calldata symbol,
        string calldata imageURI,
        string calldata description
    ) internal pure {
        uint256 nl = bytes(name).length;
        uint256 sl = bytes(symbol).length;
        if (nl == 0 || nl > 32) revert BadParams("name");
        if (sl == 0 || sl > 12) revert BadParams("symbol");
        if (bytes(imageURI).length > 256 || bytes(description).length > 512) revert BadParams("metadata");
    }
}
