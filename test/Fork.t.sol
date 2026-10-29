// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {PatienceHook} from "../src/PatienceHook.sol";
import {SpringHook} from "../src/SpringHook.sol";
import {CreatorBondHook} from "../src/CreatorBondHook.sol";
import {SessionHook} from "../src/SessionHook.sol";
import {TideStack} from "./Launch.t.sol";
import {TideLauncher} from "../src/TideLauncher.sol";
import {TideRouter} from "../src/TideRouter.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";

/// @notice Runs every hook against the live Uniswap v4 PoolManager on Robinhood Chain.
///         ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-contract Fork
contract ForkTest is Test, Deployers {
    IPoolManager constant ROBINHOOD_POOL_MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 4663);

        manager = ROBINHOOD_POOL_MANAGER;
        swapRouter = new PoolSwapTest(manager);
        modifyLiquidityRouter = new PoolModifyLiquidityTest(manager);
        MockERC20 a = new MockERC20("Tide A", "TA", 18);
        MockERC20 b = new MockERC20("Tide B", "TB", 18);
        for (uint256 i; i < 2; ++i) {
            MockERC20 t = i == 0 ? a : b;
            t.mint(address(this), 1e30);
            t.approve(address(swapRouter), type(uint256).max);
            t.approve(address(modifyLiquidityRouter), type(uint256).max);
        }
        (currency0, currency1) = address(a) < address(b)
            ? (Currency.wrap(address(a)), Currency.wrap(address(b)))
            : (Currency.wrap(address(b)), Currency.wrap(address(a)));
    }

    function _addr(uint160 flags, uint16 tag) internal pure returns (address) {
        return address(flags | (uint160(tag) << 144));
    }

    function _swapBothWays(PoolKey memory k) internal {
        PoolSwapTest.TestSettings memory t = PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
        swapRouter.swap(k, SwapParams(true, -1e15, MIN_PRICE_LIMIT), t, ZERO_BYTES);
        vm.warp(block.timestamp + 60);
        swapRouter.swap(k, SwapParams(false, -1e15, MAX_PRICE_LIMIT), t, ZERO_BYTES);
    }

    function test_fork_allHooksLiveOnRealPoolManager() public {
        address p = _addr(uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG), 0x71de);
        deployCodeTo(
            "PatienceHook.sol:PatienceHook",
            abi.encode(manager, uint24(10_000), uint24(500), uint32(30), uint32(1 hours), uint32(1 days)),
            p
        );
        (PoolKey memory k,) =
            initPoolAndAddLiquidity(currency0, currency1, IHooks(p), LPFeeLibrary.DYNAMIC_FEE_FLAG, SQRT_PRICE_1_1);
        _swapBothWays(k);

        address s =
            _addr(uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG), 0x71df);
        deployCodeTo(
            "SpringHook.sol:SpringHook",
            abi.encode(manager, uint24(3000), uint24(500), uint24(50_000), uint24(50), uint24(20), uint32(1 hours)),
            s
        );
        (k,) = initPoolAndAddLiquidity(currency0, currency1, IHooks(s), LPFeeLibrary.DYNAMIC_FEE_FLAG, SQRT_PRICE_1_1);
        _swapBothWays(k);

        address b = _addr(uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG), 0x71e0);
        deployCodeTo("CreatorBondHook.sol:CreatorBondHook", abi.encode(manager), b);
        (k,) = initPoolAndAddLiquidity(currency0, currency1, IHooks(b), 3000, SQRT_PRICE_1_1);
        _swapBothWays(k);

        address c = _addr(uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG), 0x71e1);
        deployCodeTo("SessionHook.sol:SessionHook", abi.encode(manager, address(this)), c);
        (k,) = initPoolAndAddLiquidity(currency0, currency1, IHooks(c), LPFeeLibrary.DYNAMIC_FEE_FLAG, SQRT_PRICE_1_1);
        _swapBothWays(k);
    }
}

/// @notice The full launch -> trade -> collect lifecycle on the live Robinhood Chain PoolManager.
contract ForkLaunchTest is TideStack {
    IPoolManager constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        _deployStack(PM);
        vm.deal(address(this), 100 ether);
    }

    function test_fork_launchTradeCollect_everyHook() public {
        for (uint8 k; k < 4; ++k) {
            TideLauncher.Kind kind = TideLauncher.Kind(k);
            (uint256 id, address token) = launcher.launch(_params(kind, address(0), ETH_START, 1_000));
            PoolKey memory key = launcher.getLaunch(id).key;

            (uint256 qIn, uint256 qOut) = router.quoteExactIn(TideRouter.Swap(key, true, 1 ether, 0, 0, ""));
            uint256 out = _buy(key, 1 ether, "");
            assertEq(qIn, 1 ether);
            assertEq(out, qOut, "live quote == live execution");

            vm.warp(block.timestamp + 60);
            uint256 back = _sell(key, token, uint128(out / 2));
            assertGt(back, 0);

            (uint256 fee0, uint256 fee1) = launcher.collectFees(id);
            assertGt(fee0 + fee1, 0, "locked liquidity earned fees");
            assertEq(ERC20(token).balanceOf(address(launcher)), 0);
        }
    }
}
