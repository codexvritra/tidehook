// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";

import {TideStack} from "./Launch.t.sol";
import {TideLauncherBase} from "../src/TideLauncherBase.sol";
import {TideRouter} from "../src/TideRouter.sol";
import {TidePotHook} from "../src/TidePotHook.sol";
import {TideFeeHook} from "../src/base/TideFeeHook.sol";

/// @notice Tide Pot: the creator's 1% of buys fills a pot; the last qualifying buyer before the timer ends wins 80%.
contract PotTest is TideStack {
    using PoolIdLibrary for PoolKey;

    Currency constant ETH = Currency.wrap(address(0));
    address constant CREATOR = address(0xC4EA);
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);

    uint256 id;
    address token;
    PoolKey lkey;
    PoolId pid;

    function setUp() public {
        deployFreshManagerAndRouters();
        _deployStack(manager);
        vm.warp(1792972800 + 14 hours);
        vm.deal(ALICE, 100 ether);
        vm.deal(BOB, 100 ether);
        vm.prank(CREATOR);
        (id, token) = launcher.launch(_params(TideLauncherBase.Kind.Pot, address(0), ETH_START, 0));
        lkey = launcher.getLaunch(id).key;
        pid = lkey.toId();
    }

    function _buyAs(address who, uint256 eth) internal returns (uint256 got) {
        vm.prank(who, who); // msg.sender and tx.origin: the pot leader is the signing wallet
        (, got) =
            router.swapExactIn{value: eth}(TideRouter.Swap(lkey, true, uint128(eth), 0, 0, ""), who, block.timestamp);
    }

    function test_launch_usesPotHook_noLpFee() public view {
        assertEq(address(lkey.hooks), address(pot));
        assertEq(lkey.fee, 0);
    }

    function test_creatorFee_goesToPot_tradeStillCosts2pct() public {
        _buyAs(ALICE, 1 ether);
        (uint256 amount, address leader, uint64 deadline, uint32 round,) = pot.potOf(pid);
        assertEq(amount, 0.01 ether, "creator's 1% is in the pot");
        assertEq(pot.owed(CREATOR, ETH), 0, "creator earns nothing on a pot coin");
        assertEq(pot.owed(address(launcher), ETH), 0.01 ether, "platform still gets its 1%");
        assertEq(leader, ALICE);
        assertEq(deadline, block.timestamp + 1 hours);
        assertEq(round, 0);
    }

    function test_lastBuyerWins_80pct_rest_carries() public {
        _buyAs(ALICE, 1 ether);
        vm.warp(block.timestamp + 30 minutes);
        _buyAs(BOB, 1 ether); // Bob takes the lead and resets the timer
        (uint256 amount, address leader,,,) = pot.potOf(pid);
        assertEq(amount, 0.02 ether);
        assertEq(leader, BOB);

        vm.warp(block.timestamp + 1 hours + 1);
        pot.settle(lkey);
        assertEq(pot.owed(BOB, ETH), 0.016 ether, "80% to the last buyer");
        (uint256 left,, uint64 deadline, uint32 round,) = pot.potOf(pid);
        assertEq(left, 0.004 ether, "20% seeds the next round");
        assertEq(deadline, 0);
        assertEq(round, 1);

        uint256 b0 = BOB.balance;
        vm.prank(BOB);
        pot.claim(ETH);
        assertEq(BOB.balance - b0, 0.016 ether, "prize paid in ETH");
    }

    function test_smallBuy_cannotStealTheLead() public {
        _buyAs(ALICE, 10 ether); // pot 0.1 ETH: leading now needs a buy >= 2% of it = 0.002 ETH
        (,,,, uint256 minBuy) = pot.potOf(pid);
        assertEq(minBuy, 0.002 ether);
        _buyAs(BOB, 0.001 ether);
        (, address leader,,,) = pot.potOf(pid);
        assertEq(leader, ALICE, "a dust buy doesn't take the lead or reset the clock");
    }

    function test_roundSettlesOnNextSwap() public {
        _buyAs(ALICE, 1 ether);
        vm.warp(block.timestamp + 2 hours);
        _buyAs(BOB, 1 ether); // settles Alice's round first, then Bob starts the next one
        assertEq(pot.owed(ALICE, ETH), 0.008 ether, "Alice won 80% of 0.01");
        (uint256 amount, address leader,, uint32 round,) = pot.potOf(pid);
        assertEq(leader, BOB);
        assertEq(round, 1);
        assertEq(amount, 0.002 ether + 0.01 ether, "carry + Bob's contribution");
    }

    function test_settle_revertsWhileRunning() public {
        _buyAs(ALICE, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(TidePotHook.RoundRunning.selector, uint64(block.timestamp + 1 hours)));
        pot.settle(lkey);
    }

    function test_sells_doNotTouchThePot() public {
        uint256 got = _buyAs(ALICE, 1 ether);
        (uint256 before,, uint64 deadline,,) = pot.potOf(pid);
        vm.warp(block.timestamp + 60);
        vm.startPrank(ALICE, ALICE);
        ERC20(token).approve(address(router), got);
        router.swapExactIn(TideRouter.Swap(lkey, false, uint128(got / 2), 0, 0, ""), ALICE, block.timestamp);
        vm.stopPrank();
        (uint256 amount,, uint64 deadline2,,) = pot.potOf(pid);
        assertEq(amount, before, "sell fees go to the platform, not the pot");
        assertEq(deadline2, deadline, "a sell doesn't reset the clock");
    }

    function test_hookData_namesTheLeader() public {
        address smartWallet = address(0x5A11E7);
        vm.prank(ALICE, address(0xB0DD1E5)); // e.g. a 4337 bundler signs the transaction
        router.swapExactIn{value: 1 ether}(
            TideRouter.Swap(lkey, true, 1 ether, 0, 0, abi.encode(smartWallet)), smartWallet, block.timestamp
        );
        (, address leader,,,) = pot.potOf(pid);
        assertEq(leader, smartWallet, "the wallet named in hookData leads, not the bundler");
    }

    function test_potCoins_cannotMigrate() public {
        vm.prank(CREATOR);
        vm.expectRevert(abi.encodeWithSelector(TideLauncherBase.BadParams.selector, "pot"));
        launcher.proposeMigration(id, TideLauncherBase.Kind.Spring, address(0));
    }

    function test_potHook_rejectsDynamicFeePools() public {
        TideFeeHook(address(pot)); // compiles against the shared fee interface
        PoolKey memory k = PoolKey(lkey.currency0, lkey.currency1, 0x800000, 200, lkey.hooks);
        vm.expectRevert();
        manager.initialize(k, 79228162514264337593543950336);
    }
}
