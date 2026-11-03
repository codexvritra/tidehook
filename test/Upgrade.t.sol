// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";

import {TideStack} from "./Launch.t.sol";
import {TideLauncherBase} from "../src/TideLauncherBase.sol";
import {TideMigrator} from "../src/TideMigrator.sol";
import {TideRouter} from "../src/TideRouter.sol";
import {TideToken} from "../src/TideToken.sol";

/// @notice Rename, hook upgrade and pair change after launch, plus every guardrail around them.
contract UpgradeTest is TideStack {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    MockERC20 usdc;
    PoolKey route; // ETH/USDC, 1 ETH = 3000 USDC

    function setUp() public {
        deployFreshManagerAndRouters();
        _deployStack(manager);
        vm.deal(address(this), 10_000 ether);
        vm.warp(1792972800 + 14 hours);

        // A deep ETH/USDC route pool for pair migrations.
        usdc = new MockERC20("USD Coin", "USDC", 6);
        usdc.mint(address(this), 1e18);
        usdc.approve(address(modifyLiquidityRouter), type(uint256).max);
        usdc.approve(address(router), type(uint256).max);
        route = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(usdc)), 500, 10, IHooks(address(0)));
        // raw USDC per raw wei = 3000e6 / 1e18 = 3e-9  ->  tick = log1.0001(3e-9) ≈ -195,351
        manager.initialize(route, TickMath.getSqrtPriceAtTick(-195_350));
        modifyLiquidityRouter.modifyLiquidity{value: 5_000 ether}(
            route, ModifyLiquidityParams({tickLower: -230_000, tickUpper: -160_000, liquidityDelta: 2e17, salt: 0}), ""
        );

        vm.startPrank(launcher.admin());
        launcher.setQuoteAllowed(address(usdc), true);
        launcher.setRoute(route);
        vm.stopPrank();
    }

    function _launch(TideLauncherBase.Kind kind) internal returns (uint256 id, address token) {
        (id, token) = launcher.launch(_params(kind, address(0), ETH_START, 500));
    }

    function _tokenPriceInQuote(TideLauncherBase.Launch memory l) internal view returns (uint256 tokensPerQuoteX) {
        (, int24 tick,,) = manager.getSlot0(l.key.toId());
        // normalized tick: raw tokens per raw quote
        tokensPerQuoteX = uint256(int256(l.tokenIsCurrency0 ? -tick : tick));
    }

    // ------------------------------------------------------------------ rename

    function test_rename_changesErc20AndListing_withCooldown() public {
        (uint256 id, address token) = _launch(TideLauncherBase.Kind.Patience);
        launcher.updateMetadata(id, "Renamed Tide", "RNMD", "https://x/y.png", "new story");
        assertEq(ERC20(token).name(), "Renamed Tide");
        assertEq(ERC20(token).symbol(), "RNMD");
        TideLauncherBase.Launch memory l = launcher.getLaunch(id);
        assertEq(l.name, "Renamed Tide");
        assertEq(l.description, "new story");

        vm.expectRevert(abi.encodeWithSelector(TideLauncherBase.RenameCooldown.selector, block.timestamp + 1 days));
        launcher.updateMetadata(id, "Again", "AGN", "", "");

        vm.warp(block.timestamp + 1 days);
        launcher.updateMetadata(id, "Again", "AGN", "", "");
        assertEq(ERC20(token).symbol(), "AGN");

        vm.prank(address(0xBAD));
        vm.expectRevert(TideLauncherBase.NotCreator.selector);
        launcher.updateMetadata(id, "Hijack", "HJK", "", "");

        vm.expectRevert(TideToken.NotLauncher.selector);
        TideToken(token).setMetadata("Direct", "DIR");
    }

    // ------------------------------------------------------------------ hook upgrade (same pair)

    function test_migrate_upgradeHook_keepsPriceAndValue() public {
        (uint256 id, address token) = _launch(TideLauncherBase.Kind.Patience);
        TideLauncherBase.Launch memory before = launcher.getLaunch(id);
        uint256 bought = _buy(before.key, 5 ether, "");
        vm.warp(block.timestamp + 60);
        _sell(before.key, token, uint128(bought / 4));
        (, int24 oldTick,,) = manager.getSlot0(before.key.toId());

        launcher.proposeMigration(id, TideLauncherBase.Kind.Spring, address(0));
        vm.expectRevert(abi.encodeWithSelector(TideLauncherBase.MigrationNotReady.selector, block.timestamp + 1 days));
        launcher.executeMigration(id, 0);

        vm.warp(block.timestamp + 1 days);
        address platform = launcher.feeRecipient();
        uint256 platformEthBefore = platform.balance;
        launcher.executeMigration(id, 0);

        TideLauncherBase.Launch memory l = launcher.getLaunch(id);
        assertEq(uint8(l.kind), uint8(TideLauncherBase.Kind.Spring));
        assertEq(address(l.key.hooks), address(spring));
        assertEq(l.migrations, 1);
        assertTrue(l.bidLower != l.bidUpper, "ETH from buyers re-added as bid liquidity");

        // Same price (within one tick-spacing of rounding), old pool emptied.
        (, int24 newTick,,) = manager.getSlot0(l.key.toId());
        assertApproxEqAbs(int256(newTick), int256(oldTick), 200);
        assertEq(manager.getLiquidity(before.key.toId()), 0, "old pool fully drained into the new one");
        assertEq(platform.balance, platformEthBefore, "no LP fees exist: launchpad pools charge only the 2% tax");
        assertEq(PoolId.unwrap(launcher.pastPools(id)[0]), PoolId.unwrap(before.key.toId()));
        assertEq(ERC20(token).balanceOf(address(launcher)), 0);

        // The new pool trades both ways and keeps earning for the creator.
        uint256 out = _buy(l.key, 1 ether, "");
        assertGt(out, 0);
        vm.warp(block.timestamp + 60);
        assertGt(_sell(l.key, token, uint128(out / 2)), 0);
    }

    // ------------------------------------------------------------------ pair change

    function test_migrate_changePair_ethToUsdc() public {
        (uint256 id, address token) = _launch(TideLauncherBase.Kind.Patience);
        TideLauncherBase.Launch memory before = launcher.getLaunch(id);
        _buy(before.key, 3 ether, "");
        (, int24 oldTick,,) = manager.getSlot0(before.key.toId());
        int256 tnOld = before.tokenIsCurrency0 ? -int256(oldTick) : int256(oldTick);

        launcher.proposeMigration(id, TideLauncherBase.Kind.Patience, address(usdc));
        vm.warp(block.timestamp + 1 days);
        launcher.executeMigration(id, 1);

        TideLauncherBase.Launch memory l = launcher.getLaunch(id);
        address quote = Currency.unwrap(l.tokenIsCurrency0 ? l.key.currency1 : l.key.currency0);
        assertEq(quote, address(usdc), "now paired with USDC");

        // Price in USDC = price in ETH x 3000: in normalized ticks, tnNew = tnOld - log1.0001(3e-9).
        (, int24 newTick,,) = manager.getSlot0(l.key.toId());
        int256 tnNew = l.tokenIsCurrency0 ? -int256(newTick) : int256(newTick);
        assertApproxEqAbs(tnNew, tnOld + 195_350, 400, "same value, re-expressed in USDC");
        assertGt(usdc.balanceOf(address(manager)), 0);
        assertTrue(l.bidLower != l.bidUpper, "converted ETH is now USDC bid liquidity");

        // Trading works with USDC.
        bool buyDir = !l.tokenIsCurrency0;
        uint256 balBefore = ERC20(token).balanceOf(address(this));
        router.swapExactIn(TideRouter.Swap(l.key, buyDir, 100e6, 0, 0, ""), address(this), block.timestamp);
        assertGt(ERC20(token).balanceOf(address(this)), balBefore);
    }

    // ------------------------------------------------------------------ guardrails

    function test_migrate_guardrails() public {
        (uint256 id,) = _launch(TideLauncherBase.Kind.Patience);

        vm.prank(address(0xBAD));
        vm.expectRevert(TideLauncherBase.NotCreator.selector);
        launcher.proposeMigration(id, TideLauncherBase.Kind.Spring, address(0));

        vm.expectRevert(abi.encodeWithSelector(TideLauncherBase.BadParams.selector, "same pool"));
        launcher.proposeMigration(id, TideLauncherBase.Kind.Patience, address(0));

        MockERC20 junk = new MockERC20("Junk", "JUNK", 18);
        vm.expectRevert(abi.encodeWithSelector(TideLauncherBase.BadParams.selector, "quote not allowed"));
        launcher.proposeMigration(id, TideLauncherBase.Kind.Patience, address(junk));

        vm.expectRevert(abi.encodeWithSelector(TideLauncherBase.BadParams.selector, "bond"));
        launcher.proposeMigration(id, TideLauncherBase.Kind.Bond, address(0));

        (uint256 bondId,) = _launch(TideLauncherBase.Kind.Bond);
        vm.expectRevert(abi.encodeWithSelector(TideLauncherBase.BadParams.selector, "bond"));
        launcher.proposeMigration(bondId, TideLauncherBase.Kind.Spring, address(0));

        // Expiry: a proposal left too long can't be executed.
        launcher.proposeMigration(id, TideLauncherBase.Kind.Spring, address(0));
        vm.warp(block.timestamp + 5 days);
        vm.expectRevert(TideLauncherBase.MigrationExpired.selector);
        launcher.executeMigration(id, 0);

        // Cancel clears it.
        launcher.proposeMigration(id, TideLauncherBase.Kind.Spring, address(0));
        launcher.cancelMigration(id);
        vm.expectRevert(TideLauncherBase.NoMigration.selector);
        launcher.executeMigration(id, 0);
    }

    function test_migrate_routeManipulation_reverts() public {
        (uint256 id,) = _launch(TideLauncherBase.Kind.Patience);
        _buy(launcher.getLaunch(id).key, 2 ether, "");
        launcher.proposeMigration(id, TideLauncherBase.Kind.Patience, address(usdc));
        vm.warp(block.timestamp + 1 days);

        // Someone dumps ETH into the route right before execution, moving it far more than 5%.
        router.swapExactIn{value: 1_500 ether}(
            TideRouter.Swap(route, true, 1_500 ether, 0, 0, ""), address(this), block.timestamp
        );
        vm.expectRevert();
        launcher.executeMigration(id, 1);
    }

    function test_migrate_routeSwappedByAdmin_reverts() public {
        (uint256 id,) = _launch(TideLauncherBase.Kind.Patience);
        _buy(launcher.getLaunch(id).key, 1 ether, "");
        launcher.proposeMigration(id, TideLauncherBase.Kind.Patience, address(usdc));

        // After the proposal, the admin points ETH/USDC at a different (thin) pool.
        PoolKey memory other =
            PoolKey(Currency.wrap(address(0)), Currency.wrap(address(usdc)), 3000, 60, IHooks(address(0)));
        manager.initialize(other, TickMath.getSqrtPriceAtTick(-195_360));
        vm.prank(launcher.admin());
        launcher.setRoute(other);

        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(abi.encodeWithSelector(TideLauncherBase.BadParams.selector, "route changed"));
        launcher.executeMigration(id, 1);
    }

    function test_migrate_minQuoteOut_enforced() public {
        (uint256 id,) = _launch(TideLauncherBase.Kind.Patience);
        _buy(launcher.getLaunch(id).key, 1 ether, "");
        launcher.proposeMigration(id, TideLauncherBase.Kind.Patience, address(usdc));
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert();
        launcher.executeMigration(id, 1e30);
    }

    function test_migrate_targetPoolGriefed_failsSafe() public {
        (uint256 id, address token) = _launch(TideLauncherBase.Kind.Patience);
        launcher.proposeMigration(id, TideLauncherBase.Kind.Spring, address(0));
        // A griefer initializes the exact target pool first: migration reverts instead of using it.
        PoolKey memory target =
            PoolKey(Currency.wrap(address(0)), Currency.wrap(token), 0x800000, 200, IHooks(address(spring)));
        manager.initialize(target, TickMath.getSqrtPriceAtTick(0));
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(TideLauncherBase.PoolExists.selector);
        launcher.executeMigration(id, 0);
        // Funds untouched: the whole public supply is still in the original pool.
        assertEq(PoolId.unwrap(launcher.getLaunch(id).key.toId()) != PoolId.unwrap(target.toId()), true);
        assertGt(ERC20(token).balanceOf(address(manager)), 900_000_000e18);
    }

    function test_migrator_cannotBeCalledDirectly() public {
        TideMigrator m = launcher.migrator();
        vm.expectRevert(TideMigrator.NotDelegated.selector);
        m.migrate(0, TideLauncherBase.Migration(TideLauncherBase.Kind.Spring, address(0), 1, 0, PoolId.wrap(0)), 0);
    }

    function test_noCap_buyAllTheWayUp() public {
        (uint256 id, address token) = _launch(TideLauncherBase.Kind.Spring);
        TideLauncherBase.Launch memory l = launcher.getLaunch(id);
        // A huge buy keeps filling: liquidity reaches the v4 max price, there is no market-cap ceiling.
        uint256 out = _buy(l.key, 5_000 ether, "");
        assertGt(out, 900_000_000e18, "nearly the whole public supply is buyable");
        assertLe(ERC20(token).balanceOf(address(manager)), 50_000_000e18 + 1e18);
    }
}
