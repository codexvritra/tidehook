// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";

import {TideStack} from "./Launch.t.sol";
import {TideLauncherBase} from "../src/TideLauncherBase.sol";
import {TideOrders} from "../src/TideOrders.sol";
import {TideFeeHook} from "../src/base/TideFeeHook.sol";
import {TideRouter} from "../src/TideRouter.sol";

/// @notice Limit orders (range orders) and DCA on a launch pool. ETH is currency0, the token currency1, so
///         buying the token moves the tick down and selling moves it up.
contract OrdersTest is TideStack {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address constant CREATOR = address(0xC4EA);
    address constant MAKER = address(0x3A4E);
    address constant TAKER = address(0x7A4E);
    address constant STRANGER = address(0x5757);

    TideOrders orders;
    address token;
    PoolKey lkey;

    function setUp() public {
        deployFreshManagerAndRouters();
        _deployStack(manager);
        orders = new TideOrders(manager);
        vm.warp(1792972800 + 14 hours);
        vm.deal(address(this), 1_000 ether);
        vm.deal(MAKER, 100 ether);
        vm.deal(TAKER, 100 ether);
        vm.prank(CREATOR);
        uint256 id;
        (id, token) = launcher.launch(_params(TideLauncherBase.Kind.Patience, address(0), ETH_START, 0));
        lkey = launcher.getLaunch(id).key;
    }

    function _tick() internal view returns (int24 t) {
        (, t,,) = manager.getSlot0(lkey.toId());
    }

    function _align(int24 t) internal view returns (int24) {
        return (t / lkey.tickSpacing) * lkey.tickSpacing;
    }

    function _buyAs(address who, uint256 eth) internal returns (uint256 got) {
        vm.prank(who);
        (, got) = router.swapExactIn{value: eth}(_swap(true, uint128(eth)), who, block.timestamp);
    }

    function _sellAs(address who, uint256 amount) internal returns (uint256 got) {
        vm.startPrank(who);
        ERC20(token).approve(address(router), amount);
        (, got) = router.swapExactIn(_swap(false, uint128(amount)), who, block.timestamp);
        vm.stopPrank();
    }

    function _swap(bool zeroForOne, uint128 amountIn) internal view returns (TideRouter.Swap memory s) {
        s = TideRouter.Swap(lkey, zeroForOne, amountIn, 0, 0, "");
    }

    // ------------------------------------------------------------------ limit sell (take profit)

    function test_limitSell_fillsWhenBuyersPushThrough_paysEth() public {
        uint256 bag = _buyAs(MAKER, 1 ether);
        // Sell half the bag ~20% above the current price: token is currency1, so the range sits below the tick.
        int24 upper = _align(_tick()) - 2 * lkey.tickSpacing;
        int24 lower = upper - lkey.tickSpacing;
        vm.startPrank(MAKER);
        ERC20(token).approve(address(orders), type(uint256).max);
        uint256 oid = orders.placeLimit(lkey, false, lower, uint128(bag / 2));
        vm.stopPrank();
        assertFalse(orders.isFillable(oid));
        assertApproxEqAbs(
            ERC20(token).balanceOf(MAKER),
            bag - bag / 2,
            1e6,
            "half the bag escrowed (liquidity rounds down a few wei in the maker's favour)"
        );

        _buyAs(TAKER, 20 ether); // big buy pushes the price through the order
        assertTrue(orders.isFillable(oid), "price moved fully through the range");

        uint256 eth0 = MAKER.balance;
        vm.prank(STRANGER); // anyone can lock the fill in
        orders.fill(oid);
        assertGt(MAKER.balance - eth0, 0, "maker got ETH");
        assertFalse(orders.getLimit(oid).open);

        vm.expectRevert(TideOrders.NotFilled.selector);
        orders.fill(oid);
    }

    // ------------------------------------------------------------------ limit buy (buy the dip)

    function test_limitBuy_fillsWhenSellersPushThrough_paysTokens() public {
        uint256 bag = _buyAs(TAKER, 10 ether);
        int24 lower = _align(_tick()) + 2 * lkey.tickSpacing; // ETH (currency0) order above the tick
        vm.prank(MAKER);
        uint256 oid = orders.placeLimit{value: 1 ether}(lkey, true, lower, 1 ether);
        assertLt(MAKER.balance, 100 ether - 0.99 ether, "ETH escrowed");
        assertGt(MAKER.balance, 100 ether - 1.01 ether, "rounding dust refunded");

        _sellAs(TAKER, bag); // dump pushes the price down through the order
        assertTrue(orders.isFillable(oid));
        orders.fill(oid);
        assertGt(ERC20(token).balanceOf(MAKER), 0, "maker bought the dip");
    }

    function test_limit_cancelBeforeFill_returnsFunds() public {
        _buyAs(TAKER, 1 ether);
        int24 lower = _align(_tick()) + 2 * lkey.tickSpacing;
        uint256 before = MAKER.balance;
        vm.prank(MAKER);
        uint256 oid = orders.placeLimit{value: 1 ether}(lkey, true, lower, 1 ether);
        vm.prank(STRANGER);
        vm.expectRevert(TideOrders.NotOwner.selector);
        orders.cancelLimit(oid);
        vm.prank(MAKER);
        orders.cancelLimit(oid);
        assertApproxEqAbs(MAKER.balance, before, 2, "all ETH back (minus wei rounding)");
    }

    function test_limit_wrongSideOfPrice_reverts() public {
        int24 t = _align(_tick());
        vm.prank(MAKER);
        vm.expectRevert(TideOrders.BadRange.selector);
        orders.placeLimit{value: 1 ether}(lkey, true, t - 2 * lkey.tickSpacing, 1 ether); // ETH order below price
        vm.prank(MAKER);
        vm.expectRevert(TideOrders.BadRange.selector);
        orders.placeLimit{value: 1 ether}(lkey, true, t + 7, 1 ether); // unaligned
    }

    // ------------------------------------------------------------------ DCA

    function test_dca_buySlices_onSchedule_withFees_andRefund() public {
        TideFeeHook hook = TideFeeHook(address(lkey.hooks));
        uint256 creatorOwed0 = hook.owed(CREATOR, Currency.wrap(address(0)));

        vm.prank(MAKER);
        uint256 did = orders.createDca{value: 0.3 ether}(lkey, true, 0.1 ether, 3, 1 hours, 0);
        assertTrue(orders.isDue(did), "first slice is due immediately");

        vm.prank(STRANGER);
        orders.execute(did);
        uint256 got1 = ERC20(token).balanceOf(MAKER);
        assertGt(got1, 0, "slice 1 bought tokens for the maker");
        assertEq(
            hook.owed(CREATOR, Currency.wrap(address(0))) - creatorOwed0, 0.001 ether, "1% creator fee still applies"
        );

        vm.expectRevert(abi.encodeWithSelector(TideOrders.NotDue.selector, uint64(block.timestamp + 1 hours)));
        orders.execute(did);

        vm.warp(block.timestamp + 1 hours);
        orders.execute(did);
        assertGt(ERC20(token).balanceOf(MAKER), got1, "slice 2");

        uint256 eth0 = MAKER.balance;
        vm.prank(MAKER);
        orders.cancelDca(did);
        assertEq(MAKER.balance - eth0, 0.1 ether, "unspent slice refunded");
        assertEq(address(orders).balance, 0, "nothing left behind");
    }

    function test_dca_sellToken_inSlices() public {
        uint256 bag = _buyAs(MAKER, 2 ether);
        uint128 slice = uint128(bag / 4);
        vm.startPrank(MAKER);
        ERC20(token).approve(address(orders), type(uint256).max);
        uint256 did = orders.createDca(lkey, false, slice, 4, 1 days, 0);
        vm.stopPrank();
        uint256 eth0 = MAKER.balance;
        orders.execute(did);
        assertGt(MAKER.balance - eth0, 0, "sold a quarter for ETH");
    }

    function test_dca_priceLimit_makesSliceWait() public {
        // Limit at (almost) the current price: a 0.5 ETH slice can't fill in full, so it reverts and waits.
        (uint160 sqrtP,,,) = manager.getSlot0(lkey.toId());
        vm.prank(MAKER);
        uint256 did = orders.createDca{value: 1 ether}(lkey, true, 0.5 ether, 2, 1 hours, sqrtP - 1);
        vm.expectRevert();
        orders.execute(did);
        assertTrue(orders.isDue(did), "still due: nothing was spent");
        assertEq(address(orders).balance, 1 ether);
    }

    function test_dca_validation() public {
        vm.prank(MAKER);
        vm.expectRevert(TideOrders.BadAmount.selector);
        orders.createDca{value: 1 ether}(lkey, true, 0.5 ether, 3, 1 hours, 0); // wrong total
        vm.prank(MAKER);
        vm.expectRevert(TideOrders.BadAmount.selector);
        orders.createDca{value: 1 ether}(lkey, true, 0.5 ether, 2, 30, 0); // interval under a minute
    }
}

