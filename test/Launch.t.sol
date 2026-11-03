// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";

import {PatienceHook} from "../src/PatienceHook.sol";
import {SpringHook} from "../src/SpringHook.sol";
import {CreatorBondHook} from "../src/CreatorBondHook.sol";
import {SessionHook} from "../src/SessionHook.sol";
import {TidePotHook} from "../src/TidePotHook.sol";
import {TideLauncher} from "../src/TideLauncher.sol";
import {TideLauncherBase} from "../src/TideLauncherBase.sol";
import {TideRouter} from "../src/TideRouter.sol";
import {TideTokenFactory} from "../src/TideToken.sol";
import {TideMigrator} from "../src/TideMigrator.sol";

/// @notice Shared setup: all four hooks at flag-correct addresses, plus launcher and router.
abstract contract TideStack is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    PatienceHook patience;
    SpringHook spring;
    CreatorBondHook bondHook;
    SessionHook session;
    TidePotHook pot;
    TideLauncher launcher;
    TideRouter router;

    // ~3.3e8 tokens per ETH: 1B supply starts at ~3 ETH market cap.
    int24 constant ETH_START = 196_000;

    function _deployStack(IPoolManager pm) internal {
        uint160 base = uint160(0x7175) << 144;
        address p = address(
            base
                | uint160(
                    Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
                ) | (1 << 20)
        );
        address s = address(
            base
                | uint160(
                    Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG
                        | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
                        | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
                ) | (2 << 20)
        );
        address b = address(
            base
                | uint160(
                    Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
                ) | (3 << 20)
        );
        address c = address(
            base
                | uint160(
                    Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
                ) | (4 << 20)
        );
        address t = address(
            base
                | uint160(
                    Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
                ) | (5 << 20)
        );
        deployCodeTo("TidePotHook.sol:TidePotHook", abi.encode(pm), t);
        pot = TidePotHook(t);
        deployCodeTo(
            "PatienceHook.sol:PatienceHook",
            abi.encode(pm, uint24(10_000), uint24(500), uint32(30), uint32(1 hours), uint32(1 days)),
            p
        );
        deployCodeTo(
            "SpringHook.sol:SpringHook",
            abi.encode(pm, uint24(3000), uint24(500), uint24(50_000), uint24(50), uint24(20), uint32(1 hours)),
            s
        );
        deployCodeTo("CreatorBondHook.sol:CreatorBondHook", abi.encode(pm), b);
        deployCodeTo("SessionHook.sol:SessionHook", abi.encode(pm, address(this)), c);
        patience = PatienceHook(p);
        spring = SpringHook(s);
        bondHook = CreatorBondHook(b);
        session = SessionHook(c);
        launcher = new TideLauncher(pm, new TideTokenFactory(), new TideMigrator(pm, p, s, b, c, t), p, s, b, c, t);
        router = new TideRouter(pm);
        vm.prank(launcher.admin());
        launcher.setLaunchFee(0);
    }

    function _params(TideLauncherBase.Kind kind, address quote, int24 startTick, uint16 bps)
        internal
        pure
        returns (TideLauncherBase.LaunchParams memory)
    {
        return TideLauncherBase.LaunchParams({
            name: "Tide Test",
            symbol: "TIDE",
            imageURI: "https://example.com/tide.png",
            description: "test launch",
            kind: kind,
            quote: quote,
            startTick: startTick,
            creatorBps: kind == TideLauncherBase.Kind.Bond ? bps : 0, // only Bond launches may allocate
            floorTick: startTick - 6932, // 2x the launch price for an ETH-quoted token (token is currency1)
            vestDuration: 30 days,
            grace: 1 days
        });
    }

    function _buy(PoolKey memory k, uint128 ethIn, bytes memory hookData) internal returns (uint256 out) {
        (, out) = router.swapExactIn{value: ethIn}(
            TideRouter.Swap(k, true, ethIn, 0, TickMath.MIN_SQRT_PRICE + 1, hookData), address(this), block.timestamp
        );
    }

    function _sell(PoolKey memory k, address token, uint128 amount) internal returns (uint256 out) {
        ERC20(token).approve(address(router), amount);
        (, out) = router.swapExactIn(TideRouter.Swap(k, false, amount, 0, 0, ""), address(this), block.timestamp);
    }
}

contract LaunchTest is TideStack {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function setUp() public {
        deployFreshManagerAndRouters();
        _deployStack(manager);
        vm.deal(address(this), 1_000 ether);
        vm.warp(1792972800 + 14 hours); // a Monday, regular session
    }

    function test_launch_seedsLockedSingleSidedLiquidity() public {
        (uint256 id, address token) =
            launcher.launch(_params(TideLauncherBase.Kind.Patience, address(0), ETH_START, 500));
        TideLauncherBase.Launch memory l = launcher.getLaunch(id);
        assertEq(l.token, token);
        assertEq(l.creator, address(this));
        assertFalse(l.tokenIsCurrency0, "ETH is always currency0");

        // No liquid dev bag: the creator gets nothing, the launcher keeps nothing, the pool holds the supply.
        assertEq(ERC20(token).balanceOf(address(this)), 0);
        assertEq(ERC20(token).balanceOf(address(launcher)), 0);
        assertApproxEqRel(ERC20(token).balanceOf(address(manager)), 1_000_000_000e18, 1e12);

        (, int24 tick,,) = manager.getSlot0(l.key.toId());
        assertEq(tick, ETH_START);
        assertEq(launcher.launchCount(), 1);
        assertEq(launcher.launchIdPlusOne(token), 1);
    }

    function test_router_quoteMatchesSwap_buyAndSell() public {
        (uint256 id, address token) = launcher.launch(_params(TideLauncherBase.Kind.Spring, address(0), ETH_START, 0));
        PoolKey memory k = launcher.getLaunch(id).key;

        TideRouter.Swap memory s = TideRouter.Swap(k, true, 0.5 ether, 0, 0, "");
        (uint256 qIn, uint256 qOut) = router.quoteExactIn(s);
        uint256 before = address(this).balance;
        (uint256 aIn, uint256 aOut) = router.swapExactIn{value: 0.5 ether}(s, address(this), block.timestamp);
        assertEq(aIn, qIn);
        assertEq(aOut, qOut, "quote == execution");
        assertEq(before - address(this).balance, aIn);
        assertEq(ERC20(token).balanceOf(address(this)), aOut);

        vm.warp(block.timestamp + 1);
        uint256 ethBack = _sell(k, token, uint128(aOut / 2));
        assertGt(ethBack, 0);
        assertLt(ethBack, 0.5 ether);
    }

    function test_router_refundsExcessEth_andGuards() public {
        (uint256 id,) = launcher.launch(_params(TideLauncherBase.Kind.Spring, address(0), ETH_START, 0));
        PoolKey memory k = launcher.getLaunch(id).key;

        uint256 before = address(this).balance;
        router.swapExactIn{value: 2 ether}(TideRouter.Swap(k, true, 1 ether, 0, 0, ""), address(this), block.timestamp);
        assertEq(before - address(this).balance, 1 ether, "excess refunded");

        vm.expectRevert(TideRouter.Expired.selector);
        router.swapExactIn{value: 1 ether}(
            TideRouter.Swap(k, true, 1 ether, 0, 0, ""), address(this), block.timestamp - 1
        );

        vm.expectRevert();
        router.swapExactIn{value: 1 ether}(
            TideRouter.Swap(k, true, 1 ether, type(uint128).max, 0, ""), address(this), block.timestamp
        );

        vm.expectRevert(TideRouter.BadValue.selector);
        router.swapExactIn{value: 0.5 ether}(
            TideRouter.Swap(k, true, 1 ether, 0, 0, ""), address(this), block.timestamp
        );
    }

    function test_patience_slowLaneThroughRouter_sameFlat2pct() public {
        (uint256 id,) = launcher.launch(_params(TideLauncherBase.Kind.Patience, address(0), ETH_START, 0));
        PoolKey memory k = launcher.getLaunch(id).key;
        uint128 amount = 1 ether;
        bytes32 salt = keccak256("patient");

        SwapParams memory sp = SwapParams(true, -int256(uint256(amount)), TickMath.MIN_SQRT_PRICE + 1);
        patience.commit(patience.commitmentOf(k, sp, salt));
        vm.warp(block.timestamp + 2 hours);

        uint256 snap = vm.snapshotState();
        uint256 fast = _buy(k, amount, "");
        vm.revertToState(snap);
        uint256 slow = _buy(k, amount, abi.encode(salt));
        // Launchpad pools charge no LP fee, so both lanes pay exactly the 2% tax; the reveal path still works.
        assertEq(slow, fast, "flat 2% for everyone");
    }

    function test_bond_creatorAllocationEscrowed_claimAfterFloorHolds() public {
        address creator = address(0xC0FFEE);
        vm.prank(creator);
        (uint256 id, address token) = launcher.launch(_params(TideLauncherBase.Kind.Bond, address(0), ETH_START, 1_000));
        TideLauncherBase.Launch memory l = launcher.getLaunch(id);
        PoolId pid = l.key.toId();

        address bonded = bondHook.getBond(pid).creator;
        assertEq(bonded, creator, "bond belongs to the human creator, not the launcher");
        assertEq(ERC20(token).balanceOf(address(bondHook)), 100_000_000e18);
        assertEq(ERC20(token).balanceOf(creator), 0);
        assertEq(bondHook.claimable(pid), 0, "launch price is below the 2x floor");

        // Buyers push the price past 2x; the floor must then hold for the grace period.
        _buy(l.key, 20 ether, "");
        vm.warp(block.timestamp + 15 days);
        assertGt(bondHook.claimable(pid), 0);
        vm.prank(creator);
        bondHook.claim(l.key);
        assertGt(ERC20(token).balanceOf(creator), 0);
    }

    function test_bond_launchedUnderFloor_cannotBeSlashedUntilArmed() public {
        (uint256 id,) = launcher.launch(_params(TideLauncherBase.Kind.Bond, address(0), ETH_START, 1_000));
        TideLauncherBase.Launch memory l = launcher.getLaunch(id);
        PoolId pid = l.key.toId();

        // No trading for a week: below the 2x floor the whole time, but never armed.
        vm.warp(block.timestamp + 7 days);
        assertFalse(bondHook.slashable(pid), "a floor never reached can't be slashed");
        vm.expectRevert(CreatorBondHook.NotSlashable.selector);
        bondHook.slash(l.key);

        // Price reaches the floor (arms), then falls back below it for the grace period: now slashable.
        uint256 bought = _buy(l.key, 20 ether, "");
        vm.warp(block.timestamp + 1 hours);
        _sell(l.key, l.token, uint128(bought));
        assertFalse(bondHook.slashable(pid));
        vm.warp(block.timestamp + 1 days);
        assertTrue(bondHook.slashable(pid), "armed floor lost for the full grace period");
        bondHook.slash(l.key);
    }

    function test_noLpFee_tradesPayOnlyTheLaunchpadTax() public {
        for (uint8 k; k < 4; ++k) {
            uint16 bps = k == uint8(TideLauncherBase.Kind.Bond) ? 500 : 0;
            (uint256 id, address token) = launcher.launch(_params(TideLauncherBase.Kind(k), address(0), ETH_START, bps));
            PoolKey memory key = launcher.getLaunch(id).key;
            uint256 bought = _buy(key, 5 ether, "");
            vm.warp(block.timestamp + 60);
            _sell(key, token, uint128(bought / 2));
            (uint256 g0, uint256 g1) = manager.getFeeGrowthGlobals(key.toId());
            assertEq(g0 + g1, 0, "no LP fee on top of the 2% launchpad tax");
        }
    }

    function test_session_erc20QuotedLaunch_bothOrientations() public {
        MockERC20 stock = new MockERC20("Tokenized Stock", "xSTK", 18);
        stock.mint(address(this), 1e30);
        stock.approve(address(router), type(uint256).max);

        // Launch twice so both token/quote orderings are exercised whatever the addresses.
        for (uint256 i; i < 2; ++i) {
            address factory = address(launcher.tokenFactory());
            address predicted = vm.computeCreateAddress(factory, vm.getNonce(factory));
            bool tokenIs0 = predicted < address(stock);
            (uint256 id, address token) =
                launcher.launch(_params(TideLauncherBase.Kind.Session, address(stock), ETH_START, 0));
            TideLauncherBase.Launch memory l = launcher.getLaunch(id);
            assertEq(token, predicted);
            assertEq(l.tokenIsCurrency0, tokenIs0);
            // The caller passed one orientation; the pool tick is flipped when the token sorts first.
            (, int24 tick,,) = manager.getSlot0(l.key.toId());
            assertEq(tick, tokenIs0 ? -ETH_START : ETH_START);

            bool buyDir = !tokenIs0; // spend the stock token to receive the launch token
            uint256 beforeBal = ERC20(token).balanceOf(address(this));
            (, uint256 got) =
                router.swapExactIn(TideRouter.Swap(l.key, buyDir, 1e18, 0, 0, ""), address(this), block.timestamp);
            assertGt(got, 0);
            assertEq(ERC20(token).balanceOf(address(this)) - beforeBal, got);
        }
    }

    function test_getLaunches_newestFirstWithPrices() public {
        launcher.launch(_params(TideLauncherBase.Kind.Patience, address(0), ETH_START, 0));
        launcher.launch(_params(TideLauncherBase.Kind.Spring, address(0), ETH_START + 200, 0));
        (TideLauncherBase.Launch[] memory page,, int24[] memory ticks) = launcher.getLaunches(0, 10);
        assertEq(page.length, 2);
        assertEq(uint8(page[0].kind), uint8(TideLauncherBase.Kind.Spring));
        assertEq(ticks[0], ETH_START + 200);
        (page,,) = launcher.getLaunches(5, 10);
        assertEq(page.length, 0);
    }

    function test_validation() public {
        TideLauncherBase.LaunchParams memory p = _params(TideLauncherBase.Kind.Patience, address(0), ETH_START + 1, 0);
        vm.expectRevert(abi.encodeWithSelector(TideLauncherBase.BadParams.selector, "startTick"));
        launcher.launch(p);

        p = _params(TideLauncherBase.Kind.Bond, address(0), ETH_START, 2_001);
        vm.expectRevert(abi.encodeWithSelector(TideLauncherBase.BadParams.selector, "creatorBps"));
        launcher.launch(p);

        // A liquid creator allocation (the dev-wallet bag Ignition's team member dumped) is impossible:
        // allocations exist only on Bond launches, vesting at least 30 days.
        p = _params(TideLauncherBase.Kind.Patience, address(0), ETH_START, 0);
        p.creatorBps = 500;
        vm.expectRevert(abi.encodeWithSelector(TideLauncherBase.BadParams.selector, "creatorBps"));
        launcher.launch(p);

        p = _params(TideLauncherBase.Kind.Bond, address(0), ETH_START, 500);
        p.vestDuration = 29 days;
        vm.expectRevert(abi.encodeWithSelector(TideLauncherBase.BadParams.selector, "bond"));
        launcher.launch(p);

        p = _params(TideLauncherBase.Kind.Bond, address(0), ETH_START, 0);
        vm.expectRevert(abi.encodeWithSelector(TideLauncherBase.BadParams.selector, "bond"));
        launcher.launch(p);

        p = _params(TideLauncherBase.Kind.Patience, address(0), ETH_START, 0);
        p.name = "";
        vm.expectRevert(abi.encodeWithSelector(TideLauncherBase.BadParams.selector, "name"));
        launcher.launch(p);
    }
}
