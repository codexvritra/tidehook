// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";

import {TideStack} from "./Launch.t.sol";
import {TideLauncherBase} from "../src/TideLauncherBase.sol";
import {TideFeeHook} from "../src/base/TideFeeHook.sol";
import {TideRouter} from "../src/TideRouter.sol";

/// @notice Launch fee and trading fees: buy 1% creator + 1% platform, sell 2% platform, always in the quote (ETH).
contract FeesTest is TideStack {
    Currency constant ETH = Currency.wrap(address(0));
    address constant CREATOR = address(0xC4EA);
    PoolSwapTest.TestSettings settings = PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});

    function setUp() public {
        deployFreshManagerAndRouters();
        _deployStack(manager);
        vm.deal(address(this), 1_000 ether);
        vm.deal(CREATOR, 1 ether);
        vm.warp(1792972800 + 14 hours);
    }

    function _launchAs(TideLauncherBase.Kind kind) internal returns (uint256 id, address token, PoolKey memory key) {
        vm.prank(CREATOR);
        (id, token) = launcher.launch(_params(kind, address(0), ETH_START, 0));
        key = launcher.getLaunch(id).key;
    }

    function _hook(PoolKey memory key) internal pure returns (TideFeeHook) {
        return TideFeeHook(address(key.hooks));
    }

    // ------------------------------------------------------------------ launch fee

    function test_launchFee_paidToPlatform_excessRefunded() public {
        vm.prank(launcher.admin());
        launcher.setLaunchFee(0.001 ether);
        address platform = launcher.feeRecipient();

        vm.expectRevert(abi.encodeWithSelector(TideLauncherBase.LaunchFeeUnpaid.selector, 0.001 ether));
        launcher.launch(_params(TideLauncherBase.Kind.Spring, address(0), ETH_START, 0));

        uint256 p0 = platform.balance;
        uint256 me0 = address(this).balance;
        launcher.launch{value: 0.005 ether}(_params(TideLauncherBase.Kind.Spring, address(0), ETH_START, 0));
        assertEq(platform.balance - p0, 0.001 ether, "launch fee to the platform wallet");
        assertEq(me0 - address(this).balance, 0.001 ether, "excess refunded");
        assertEq(address(launcher).balance, 0);
    }

    function test_launchFee_onlyAdmin() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(TideLauncherBase.NotAdmin.selector);
        launcher.setLaunchFee(0);
        vm.prank(address(0xBAD));
        vm.expectRevert(TideLauncherBase.NotAdmin.selector);
        launcher.setFeeRecipient(address(0xBAD));
    }

    // ------------------------------------------------------------------ trading fees

    function test_buy_exactIn_1pctCreator_1pctPlatform_inEth() public {
        (, address token, PoolKey memory key) = _launchAs(TideLauncherBase.Kind.Patience);
        TideFeeHook hook = _hook(key);
        _buy(key, 1 ether, "");
        assertEq(hook.owed(CREATOR, ETH), 0.01 ether, "creator: 1% of the buy");
        assertEq(hook.owed(address(launcher), ETH), 0.01 ether, "platform: 1% of the buy");
        assertEq(hook.owed(CREATOR, Currency.wrap(token)), 0, "never paid in the token");
        assertEq(hook.owed(address(launcher), Currency.wrap(token)), 0);
    }

    function test_sell_exactIn_2pctPlatform_inEth() public {
        (, address token, PoolKey memory key) = _launchAs(TideLauncherBase.Kind.Spring);
        TideFeeHook hook = _hook(key);
        uint256 bought = _buy(key, 1 ether, "");
        uint256 platformBefore = hook.owed(address(launcher), ETH);
        uint256 creatorBefore = hook.owed(CREATOR, ETH);

        vm.warp(block.timestamp + 60);
        uint256 received = _sell(key, token, uint128(bought / 2));
        uint256 fee = hook.owed(address(launcher), ETH) - platformBefore;
        assertApproxEqAbs(fee, ((received + fee) * 200) / 10_000, 1, "platform: 2% of the gross ETH out");
        assertEq(hook.owed(CREATOR, ETH), creatorBefore, "creator earns nothing on sells");
        assertEq(hook.owed(address(launcher), Currency.wrap(token)), 0, "never paid in the token");
    }

    function test_exactOutput_buyAndSell_alsoPayInEth() public {
        (, address token, PoolKey memory key) = _launchAs(TideLauncherBase.Kind.Session);
        TideFeeHook hook = _hook(key);

        // Exact-output buy: ask for tokens, pay ETH. Fee charged on the ETH input in afterSwap.
        uint256 ethBefore = address(this).balance;
        swapRouter.swap{value: 2 ether}(key, SwapParams(true, 1_000_000e18, TickMath.MIN_SQRT_PRICE + 1), settings, "");
        assertEq(ERC20(token).balanceOf(address(this)), 1_000_000e18, "got exactly the tokens asked for");
        assertGt(hook.owed(CREATOR, ETH), 0);
        assertEq(hook.owed(CREATOR, ETH), hook.owed(address(launcher), ETH), "1% / 1% split");
        assertLt(ethBefore - address(this).balance, 2 ether + 1);

        // Exact-output sell: ask for ETH, pay tokens. Fee charged on the ETH output in beforeSwap.
        ERC20(token).approve(address(swapRouter), type(uint256).max);
        uint256 platformBefore = hook.owed(address(launcher), ETH);
        uint256 creatorBefore = hook.owed(CREATOR, ETH);
        uint256 ethMid = address(this).balance;
        vm.warp(block.timestamp + 60);
        swapRouter.swap(key, SwapParams(false, 0.0001 ether, TickMath.MAX_SQRT_PRICE - 1), settings, "");
        assertEq(address(this).balance - ethMid, 0.0001 ether, "received exactly the ETH asked for");
        assertEq(hook.owed(address(launcher), ETH) - platformBefore, 0.000002 ether, "2% of the ETH out");
        assertEq(hook.owed(CREATOR, ETH), creatorBefore);
        assertEq(hook.owed(CREATOR, Currency.wrap(token)), 0);
    }

    function test_quote_includesFees() public {
        (,, PoolKey memory key) = _launchAs(TideLauncherBase.Kind.Spring);
        TideRouter.Swap memory s = TideRouter.Swap(key, true, 1 ether, 0, 0, "");
        (, uint256 quoted) = router.quoteExactIn(s);
        (, uint256 out) = router.swapExactIn{value: 1 ether}(s, address(this), block.timestamp);
        assertEq(out, quoted, "on-chain quote already nets out the launchpad fee");
    }

    // ------------------------------------------------------------------ claims

    function test_claims_payEth() public {
        (,, PoolKey memory key) = _launchAs(TideLauncherBase.Kind.Patience);
        TideFeeHook hook = _hook(key);
        _buy(key, 2 ether, "");

        uint256 c0 = CREATOR.balance;
        vm.prank(CREATOR);
        hook.claim(ETH);
        assertEq(CREATOR.balance - c0, 0.02 ether, "creator withdraws 1% in ETH");
        assertEq(hook.owed(CREATOR, ETH), 0);

        address platform = launcher.feeRecipient();
        uint256 p0 = platform.balance;
        vm.prank(address(0xA11CE)); // anyone can push platform fees to the platform wallet
        hook.claimPlatform(address(launcher), ETH);
        assertEq(platform.balance - p0, 0.02 ether, "platform wallet receives its 1% in ETH");

        vm.prank(CREATOR);
        vm.expectRevert(TideFeeHook.NothingToClaim.selector);
        hook.claim(ETH);
    }

    function test_platformWallet_changeable() public {
        (,, PoolKey memory key) = _launchAs(TideLauncherBase.Kind.Patience);
        _buy(key, 1 ether, "");
        address newWallet = address(0x9A7F);
        vm.prank(launcher.admin());
        launcher.setFeeRecipient(newWallet);
        _hook(key).claimPlatform(address(launcher), ETH);
        assertEq(newWallet.balance, 0.01 ether);
    }

    // ------------------------------------------------------------------ scope

    function test_unregisteredPool_paysNoLaunchpadFees() public {
        // Someone else uses our hook for their own pool: no launchpad fees apply.
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        other.mint(address(this), 1e27);
        other.approve(address(modifyLiquidityRouter), type(uint256).max);
        PoolKey memory k = PoolKey(ETH, Currency.wrap(address(other)), 0x800000, 60, IHooks(address(spring)));
        manager.initialize(k, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity{value: 10 ether}(k, LIQUIDITY_PARAMS, "");
        swapRouter.swap{value: 0.1 ether}(k, SwapParams(true, -0.1 ether, TickMath.MIN_SQRT_PRICE + 1), settings, "");
        assertEq(spring.owed(address(this), ETH), 0);
        (address creator,,) = spring.feeConfig(PoolId.wrap(_id(k)));
        assertEq(creator, address(0));
    }

    function test_onlyInitializerCanRegister() public {
        (,, PoolKey memory key) = _launchAs(TideLauncherBase.Kind.Spring);
        vm.expectRevert(TideFeeHook.NotInitializer.selector);
        spring.registerFees(key, address(0xBAD), true);
    }

    function test_erc20Quote_feesInQuoteNotToken() public {
        MockERC20 usd = new MockERC20("USD", "USD", 18);
        usd.mint(address(this), 1e30);
        usd.approve(address(router), type(uint256).max);
        vm.prank(CREATOR);
        (uint256 id, address token) =
            launcher.launch(_params(TideLauncherBase.Kind.Session, address(usd), ETH_START, 0));
        TideLauncherBase.Launch memory l = launcher.getLaunch(id);
        router.swapExactIn(
            TideRouter.Swap(l.key, !l.tokenIsCurrency0, 100e18, 0, 0, ""), address(this), block.timestamp
        );
        TideFeeHook hook = _hook(l.key);
        assertEq(hook.owed(CREATOR, Currency.wrap(address(usd))), 1e18, "1% of a 100 USD buy, paid in USD");
        assertEq(hook.owed(CREATOR, Currency.wrap(token)), 0);
    }

    function test_migratedPool_keepsChargingFees() public {
        (uint256 id,, PoolKey memory key) = _launchAs(TideLauncherBase.Kind.Patience);
        _buy(key, 1 ether, "");
        vm.prank(CREATOR);
        launcher.proposeMigration(id, TideLauncherBase.Kind.Spring, address(0));
        vm.warp(block.timestamp + 1 days);
        vm.prank(CREATOR);
        launcher.executeMigration(id, 0);

        PoolKey memory newKey = launcher.getLaunch(id).key;
        _buy(newKey, 1 ether, "");
        assertEq(spring.owed(CREATOR, ETH), 0.01 ether, "creator still earns 1% after the hook upgrade");
    }

    function _id(PoolKey memory k) internal pure returns (bytes32) {
        return keccak256(abi.encode(k));
    }
}
