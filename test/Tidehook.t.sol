// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {PatienceHook} from "../src/PatienceHook.sol";
import {SpringHook} from "../src/SpringHook.sol";
import {CreatorBondHook} from "../src/CreatorBondHook.sol";
import {SessionHook} from "../src/SessionHook.sol";

contract TidehookTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for *;

    uint256 constant MONDAY = 1792972800; // 2026-10-26 00:00 UTC

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        vm.warp(MONDAY);
    }

    function _hookAddr(uint160 flags) internal pure returns (address) {
        return address(flags | (uint160(0x7175) << 144));
    }

    function _exactIn(bool zeroForOne, int256 amountIn) internal pure returns (SwapParams memory) {
        return SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -amountIn,
            sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
        });
    }

    function _swap(PoolKey memory k, SwapParams memory p, bytes memory hookData) internal returns (BalanceDelta) {
        return swapRouter.swap(k, p, PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}), hookData);
    }

    // ------------------------------------------------------------------ PatienceHook

    function _deployPatience() internal returns (PatienceHook hook) {
        address a = _hookAddr(uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG));
        deployCodeTo(
            "PatienceHook.sol:PatienceHook",
            abi.encode(manager, uint24(10_000), uint24(500), uint32(30), uint32(3600), uint32(1 days)),
            a
        );
        hook = PatienceHook(a);
    }

    function _patience() internal returns (PatienceHook hook, PoolKey memory k) {
        hook = _deployPatience();
        (k,) = initPoolAndAddLiquidity(
            currency0, currency1, IHooks(address(hook)), LPFeeLibrary.DYNAMIC_FEE_FLAG, SQRT_PRICE_1_1
        );
    }

    function test_patience_precommitBeforeLaunchDoesNotAge() public {
        PatienceHook hook = _deployPatience();
        // Pool ids are deterministic: a sniper can hash the launch swap before the pool exists.
        PoolKey memory k = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(address(hook)));
        SwapParams memory p = _exactIn(true, 1e15);
        bytes32 salt = keccak256("sniper");
        hook.commit(hook.commitmentOf(k, p, salt));

        vm.warp(block.timestamp + 12 hours);
        initPoolAndAddLiquidity(
            currency0, currency1, IHooks(address(hook)), LPFeeLibrary.DYNAMIC_FEE_FLAG, SQRT_PRICE_1_1
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeSwap.selector,
                abi.encodeWithSelector(PatienceHook.CommitmentTooYoung.selector, 0, 30),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        _swap(k, p, abi.encode(salt));
    }

    function test_patience_feeCurve() public {
        (PatienceHook hook,) = _patience();
        assertEq(hook.feeForAge(30), 10_000);
        assertEq(hook.feeForAge(30 + 1800), 5_250);
        assertEq(hook.feeForAge(30 + 3600), 500);
        assertEq(hook.feeForAge(1 days), 500);
        vm.expectRevert();
        hook.feeForAge(29);
        vm.expectRevert();
        hook.feeForAge(1 days + 1);
    }

    function test_patience_waitingPaysLess() public {
        (PatienceHook hook, PoolKey memory k) = _patience();
        SwapParams memory p = _exactIn(true, 1e15);
        bytes32 salt = keccak256("tide");

        uint256 snap = vm.snapshotState();
        int128 fastOut = _swap(k, p, ZERO_BYTES).amount1();
        vm.revertToState(snap);

        hook.commit(hook.commitmentOf(k, p, salt));
        vm.warp(block.timestamp + 2 hours);
        int128 slowOut = _swap(k, p, abi.encode(salt)).amount1();

        assertGt(slowOut, fastOut, "patient swap should receive more");
    }

    function test_patience_rejectsUnknownAndReused() public {
        (PatienceHook hook, PoolKey memory k) = _patience();
        SwapParams memory p = _exactIn(true, 1e15);
        bytes32 salt = keccak256("tide");

        vm.expectRevert();
        _swap(k, p, abi.encode(salt));

        hook.commit(hook.commitmentOf(k, p, salt));
        vm.warp(block.timestamp + 10);
        vm.expectRevert(); // too young
        _swap(k, p, abi.encode(salt));

        vm.warp(block.timestamp + 60);
        _swap(k, p, abi.encode(salt));
        vm.expectRevert(); // consumed
        _swap(k, p, abi.encode(salt));
    }

    // ------------------------------------------------------------------ SpringHook

    function test_spring_stretchCostsMoreRestoreCostsLess() public {
        address a =
            _hookAddr(uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG));
        deployCodeTo(
            "SpringHook.sol:SpringHook",
            abi.encode(manager, uint24(3000), uint24(500), uint24(50_000), uint24(50), uint24(20), uint32(1 hours)),
            a
        );
        SpringHook hook = SpringHook(a);
        (PoolKey memory k, PoolId id) =
            initPoolAndAddLiquidity(currency0, currency1, IHooks(a), LPFeeLibrary.DYNAMIC_FEE_FLAG, SQRT_PRICE_1_1);

        // Relaxed: base fee both ways.
        assertEq(hook.quoteFee(id, 0, true, MIN_PRICE_LIMIT), 3000);
        assertEq(hook.quoteFee(id, 0, false, MAX_PRICE_LIMIT), 3000);

        // Dump token0 hard in the same second; the rest point must not move.
        _swap(k, _exactIn(true, 1e17), ZERO_BYTES);
        (, int24 tick,,) = manager.getSlot0(id);
        (int24 rest,) = hook.springs(id);
        assertEq(rest, 0);
        assertLt(tick, -50);

        assertGt(hook.quoteFee(id, tick, true, MIN_PRICE_LIMIT), 3000, "selling further is surcharged");
        assertEq(hook.quoteFee(id, tick, false, hook.restLimit(id)), 500, "buying back to rest is discounted");
        assertEq(hook.quoteFee(id, tick, false, MAX_PRICE_LIMIT), 3000, "open-ended buy could overshoot: no discount");

        // A bounded restoring swap really executes at minFee and stops at rest.
        _swap(
            k,
            SwapParams({zeroForOne: false, amountSpecified: -1e18, sqrtPriceLimitX96: hook.restLimit(id)}),
            ZERO_BYTES
        );
        (, int24 after_,,) = manager.getSlot0(id);
        assertLe(after_, 0, "never overshoots rest");
    }

    // ------------------------------------------------------------------ CreatorBondHook

    function _bonded() internal returns (CreatorBondHook hook, PoolKey memory k, PoolId id) {
        address a = _hookAddr(uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG));
        deployCodeTo("CreatorBondHook.sol:CreatorBondHook", abi.encode(manager), a);
        hook = CreatorBondHook(a);
        (k, id) = initPoolAndAddLiquidity(currency0, currency1, IHooks(a), 3000, SQRT_PRICE_1_1);

        MockERC20(Currency.unwrap(currency0)).approve(a, type(uint256).max);
        hook.bond(k, true, 1_000e18, -100, 30 days, 1 days);
    }

    function test_bond_onlyLauncher() public {
        (CreatorBondHook hook, PoolKey memory k,) = _bonded();
        vm.prank(address(0xBEEF));
        vm.expectRevert(CreatorBondHook.NotLauncher.selector);
        hook.bond(k, true, 1, -100, 1, 1);
    }

    function test_bond_vestsAndClaims() public {
        (CreatorBondHook hook, PoolKey memory k, PoolId id) = _bonded();
        vm.warp(block.timestamp + 15 days);
        assertEq(hook.claimable(id), 500e18);
        uint256 before = currency0.balanceOf(address(this));
        hook.claim(k);
        assertEq(currency0.balanceOf(address(this)) - before, 500e18);
    }

    function test_bond_breachBlocksClaimThenSlashBurns() public {
        (CreatorBondHook hook, PoolKey memory k, PoolId id) = _bonded();
        vm.warp(block.timestamp + 10 days);

        _swap(k, _exactIn(true, 1e17), ZERO_BYTES); // dump below floor
        assertEq(hook.claimable(id), 0);
        vm.expectRevert(CreatorBondHook.BelowFloor.selector);
        hook.claim(k);

        vm.expectRevert(CreatorBondHook.NotSlashable.selector);
        hook.slash(k);

        vm.warp(block.timestamp + 1 days);
        vm.prank(address(0xCAFE));
        hook.slash(k);
        assertEq(currency0.balanceOf(hook.BURN()), 1_000e18);
    }

    function test_bond_recoveryRestoresClaim() public {
        (CreatorBondHook hook, PoolKey memory k, PoolId id) = _bonded();
        vm.warp(block.timestamp + 10 days);
        _swap(k, _exactIn(true, 1e17), ZERO_BYTES);
        assertEq(hook.claimable(id), 0);

        _swap(k, _exactIn(false, 2e17), ZERO_BYTES); // buy back above floor
        assertEq(hook.claimable(id), 0, "recovery must hold first");
        vm.warp(block.timestamp + 1 days);
        assertGt(hook.claimable(id), 0);
        hook.claim(k);
    }

    function test_bond_flashPumpCannotClaim() public {
        (CreatorBondHook hook, PoolKey memory k,) = _bonded();
        vm.warp(block.timestamp + 10 days);
        _swap(k, _exactIn(true, 1e17), ZERO_BYTES); // price falls below floor
        vm.warp(block.timestamp + 1 hours);

        // Same transaction: pump above floor, try to claim, dump.
        _swap(k, _exactIn(false, 2e17), ZERO_BYTES);
        vm.expectRevert(abi.encodeWithSelector(CreatorBondHook.FloorNotHeld.selector, 0, 1 days));
        hook.claim(k);
    }

    function test_bond_roundTripDoesNotResetSlashTimer() public {
        (CreatorBondHook hook, PoolKey memory k, PoolId id) = _bonded();
        _swap(k, _exactIn(true, 1e17), ZERO_BYTES); // breach at t
        vm.warp(block.timestamp + 12 hours);

        _swap(k, _exactIn(false, 2e17), ZERO_BYTES); // flash above...
        _swap(k, _exactIn(true, 3e17), ZERO_BYTES); // ...and back below in the same block
        vm.warp(block.timestamp + 12 hours);

        assertTrue(hook.slashable(id), "timer kept running from the original breach");
        hook.slash(k);
    }

    // ------------------------------------------------------------------ SessionHook

    function test_session_clock() public {
        address a = _hookAddr(uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG));
        deployCodeTo("SessionHook.sol:SessionHook", abi.encode(manager, address(this)), a);
        SessionHook hook = SessionHook(a);

        assertEq(uint256(hook.sessionAt(MONDAY + 3 hours)), uint256(SessionHook.Session.Closed));
        assertEq(uint256(hook.sessionAt(MONDAY + 9 hours)), uint256(SessionHook.Session.Extended));
        assertEq(uint256(hook.sessionAt(MONDAY + 14 hours)), uint256(SessionHook.Session.Regular));
        assertEq(uint256(hook.sessionAt(MONDAY + 21 hours)), uint256(SessionHook.Session.Extended));
        assertEq(uint256(hook.sessionAt(MONDAY - 1 days)), uint256(SessionHook.Session.Weekend)); // Sunday
        assertEq(uint256(hook.sessionAt(MONDAY - 2 days + 14 hours)), uint256(SessionHook.Session.Weekend)); // Sat

        uint256[] memory thanksgiving = new uint256[](1);
        thanksgiving[0] = 1795651200 / 1 days; // 2026-11-26
        hook.setHolidays(thanksgiving, true);
        assertEq(uint256(hook.sessionAt(1795651200 + 14 hours)), uint256(SessionHook.Session.Weekend));

        // Fee actually applied to a swap.
        (PoolKey memory k,) =
            initPoolAndAddLiquidity(currency0, currency1, IHooks(a), LPFeeLibrary.DYNAMIC_FEE_FLAG, SQRT_PRICE_1_1);
        vm.warp(MONDAY + 14 hours);
        uint256 snap = vm.snapshotState();
        int128 regularOut = _swap(k, _exactIn(true, 1e15), ZERO_BYTES).amount1();
        vm.revertToState(snap);
        vm.warp(MONDAY - 1 days);
        int128 weekendOut = _swap(k, _exactIn(true, 1e15), ZERO_BYTES).amount1();
        assertGt(regularOut, weekendOut);
    }

    // ------------------------------------------------------------------ invariants (fuzz)

    function testFuzz_patience_feeMonotonicAndBounded(uint256 a, uint256 b) public {
        (PatienceHook hook,) = _patience();
        a = bound(a, 30, 1 days);
        b = bound(b, a, 1 days);
        uint24 fa = hook.feeForAge(a);
        uint24 fb = hook.feeForAge(b);
        assertLe(fb, fa, "older commitments never pay more");
        assertGe(fb, 500);
        assertLe(fa, 10_000);
    }

    function testFuzz_spring_feeBounded(int24 tick, bool zeroForOne, uint160 limit) public {
        address a =
            _hookAddr(uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG));
        deployCodeTo(
            "SpringHook.sol:SpringHook",
            abi.encode(manager, uint24(3000), uint24(500), uint24(50_000), uint24(50), uint24(20), uint32(1 hours)),
            a
        );
        (, PoolId id) = initPool(currency0, currency1, IHooks(a), LPFeeLibrary.DYNAMIC_FEE_FLAG, SQRT_PRICE_1_1);
        tick = int24(bound(tick, TickMath.MIN_TICK, TickMath.MAX_TICK));
        uint24 fee = SpringHook(a).quoteFee(id, tick, zeroForOne, limit);
        assertGe(fee, 500);
        assertLe(fee, 50_000);
    }

    function testFuzz_session_alwaysAKnownFee(uint256 t) public {
        address a = _hookAddr(uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG));
        deployCodeTo("SessionHook.sol:SessionHook", abi.encode(manager, address(this)), a);
        t = bound(t, 0, type(uint40).max);
        vm.warp(t);
        uint24 fee = SessionHook(a).currentFee();
        assertTrue(fee == 500 || fee == 3000 || fee == 10_000 || fee == 20_000);
    }
}
