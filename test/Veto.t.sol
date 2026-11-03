// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";

import {TideStack} from "./Launch.t.sol";
import {TideLauncherBase} from "../src/TideLauncherBase.sol";
import {TideVeto} from "../src/TideVeto.sol";

/// @notice Holders can block a pending hook/pair migration by locking >= 10% of the circulating supply.
contract VetoTest is TideStack {
    address constant CREATOR = address(0xC4EA);
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);

    TideVeto veto;
    uint256 id;
    address token;
    PoolKey lkey;

    function setUp() public {
        deployFreshManagerAndRouters();
        _deployStack(manager);
        veto = launcher.veto();
        vm.warp(1792972800 + 14 hours);
        vm.deal(address(this), 1_000 ether);
        vm.prank(CREATOR);
        (id, token) = launcher.launch(_params(TideLauncherBase.Kind.Patience, address(0), ETH_START, 0));
        lkey = launcher.getLaunch(id).key;
        // Alice buys a lot, Bob a little; they are the circulating supply.
        uint256 a = _buy(lkey, 3 ether, "");
        ERC20(token).transfer(ALICE, a);
        vm.warp(block.timestamp + 60);
        uint256 b = _buy(lkey, 0.2 ether, "");
        ERC20(token).transfer(BOB, b);
        vm.prank(ALICE);
        ERC20(token).approve(address(veto), type(uint256).max);
        vm.prank(BOB);
        ERC20(token).approve(address(veto), type(uint256).max);
    }

    function _propose() internal {
        vm.prank(CREATOR);
        launcher.proposeMigration(id, TideLauncherBase.Kind.Spring, address(0));
    }

    function test_veto_wiredToLauncher() public view {
        assertEq(address(veto.launcher()), address(launcher));
        assertEq(launcher.tokenOf(id), token);
    }

    function test_noVote_withoutPendingMigration() public {
        vm.prank(ALICE);
        vm.expectRevert(TideVeto.NothingToVeto.selector);
        veto.lock(id, 1e18);
    }

    function test_holdersBlockMigration() public {
        _propose();
        uint256 circ = veto.circulating(id);
        assertEq(circ, ERC20(token).balanceOf(ALICE) + ERC20(token).balanceOf(BOB), "circulating = holders' tokens");

        uint256 aliceBal = ERC20(token).balanceOf(ALICE);
        vm.prank(ALICE);
        veto.lock(id, aliceBal);
        (uint256 locked, uint256 needed, bool blocked) = veto.status(id);
        assertGe(locked, needed);
        assertTrue(blocked);

        vm.warp(block.timestamp + 1 days);
        vm.prank(CREATOR);
        vm.expectRevert(TideLauncherBase.Vetoed.selector);
        launcher.executeMigration(id, 0);
        assertEq(address(launcher.getLaunch(id).key.hooks), address(patience), "hook unchanged");
    }

    function test_smallHolder_belowThreshold_doesNotBlock() public {
        _propose();
        uint256 bobBal = ERC20(token).balanceOf(BOB);
        assertLt(bobBal * 10_000, veto.circulating(id) * 1_000, "Bob holds < 10%");
        vm.prank(BOB);
        veto.lock(id, bobBal);
        assertFalse(veto.isVetoed(id));
        vm.warp(block.timestamp + 1 days);
        vm.prank(CREATOR);
        launcher.executeMigration(id, 0);
        assertEq(address(launcher.getLaunch(id).key.hooks), address(spring), "migrated");
    }

    function test_unlock_returnsTokens_andWithdrawsVote() public {
        _propose();
        uint256 bal = ERC20(token).balanceOf(ALICE);
        vm.prank(ALICE);
        veto.lock(id, bal);
        assertTrue(veto.isVetoed(id));
        vm.prank(ALICE);
        veto.unlock(id);
        assertEq(ERC20(token).balanceOf(ALICE), bal, "all tokens back");
        assertFalse(veto.isVetoed(id));
    }

    function test_votingClosesAtReadyAt() public {
        _propose();
        vm.warp(block.timestamp + 1 days);
        vm.prank(ALICE);
        vm.expectRevert(TideVeto.VotingClosed.selector);
        veto.lock(id, 1e18);
    }

    function test_newProposal_startsFreshTally() public {
        _propose();
        uint256 aliceBal = ERC20(token).balanceOf(ALICE);
        vm.prank(ALICE);
        veto.lock(id, aliceBal);
        assertTrue(veto.isVetoed(id));

        // Creator cancels and re-proposes: the old votes don't count, Alice must unlock and vote again.
        vm.prank(CREATOR);
        launcher.cancelMigration(id);
        _propose();
        assertFalse(veto.isVetoed(id), "old round does not carry over");
        vm.prank(ALICE);
        vm.expectRevert(TideVeto.UnlockFirst.selector);
        veto.lock(id, 1);

        vm.prank(ALICE);
        veto.unlock(id);
        aliceBal = ERC20(token).balanceOf(ALICE);
        vm.prank(ALICE);
        veto.lock(id, aliceBal);
        assertTrue(veto.isVetoed(id), "re-vote counts in the new round");
    }

    function test_lockedTokensNotCountedAgainstThem_poolAndBurnExcluded() public {
        _propose();
        uint256 before = veto.circulating(id);
        vm.prank(ALICE);
        veto.lock(id, 1e18);
        assertEq(veto.circulating(id), before, "locking does not change circulating supply");
    }
}
