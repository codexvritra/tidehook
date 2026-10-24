// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "../lib/v4-periphery/test/shared/HookMiner.sol";

import {PatienceHook} from "../src/PatienceHook.sol";
import {SpringHook} from "../src/SpringHook.sol";
import {CreatorBondHook} from "../src/CreatorBondHook.sol";
import {SessionHook} from "../src/SessionHook.sol";

/// @notice forge script script/Deploy.s.sol --rpc-url robinhood --broadcast
///         Env: POOL_MANAGER (v4 PoolManager on the target chain), OWNER (SessionHook admin).
contract Deploy is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external {
        IPoolManager manager = IPoolManager(vm.envAddress("POOL_MANAGER"));
        address owner = vm.envAddress("OWNER");

        vm.startBroadcast();

        // PatienceHook: 1% fast lane -> 0.05% after 30s + 1h, commitments valid 24h.
        bytes memory args =
            abi.encode(manager, uint24(10_000), uint24(500), uint32(30), uint32(1 hours), uint32(1 days));
        (address a, bytes32 salt) = HookMiner.find(
            CREATE2_DEPLOYER,
            uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG),
            type(PatienceHook).creationCode,
            args
        );
        PatienceHook patience = new PatienceHook{salt: salt}(
            manager, uint24(10_000), uint24(500), uint32(30), uint32(1 hours), uint32(1 days)
        );
        require(address(patience) == a, "patience addr");

        // SpringHook: 0.30% base, 0.05% restoring, up to 5%; 50-tick band, +20 pips/tick, 1h EMA.
        args = abi.encode(manager, uint24(3000), uint24(500), uint24(50_000), uint24(50), uint24(20), uint32(1 hours));
        (a, salt) = HookMiner.find(
            CREATE2_DEPLOYER,
            uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG),
            type(SpringHook).creationCode,
            args
        );
        SpringHook spring = new SpringHook{salt: salt}(
            manager, uint24(3000), uint24(500), uint24(50_000), uint24(50), uint24(20), uint32(1 hours)
        );
        require(address(spring) == a, "spring addr");

        args = abi.encode(manager);
        (a, salt) = HookMiner.find(
            CREATE2_DEPLOYER,
            uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG),
            type(CreatorBondHook).creationCode,
            args
        );
        CreatorBondHook bond = new CreatorBondHook{salt: salt}(manager);
        require(address(bond) == a, "bond addr");

        args = abi.encode(manager, owner);
        (a, salt) = HookMiner.find(
            CREATE2_DEPLOYER,
            uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG),
            type(SessionHook).creationCode,
            args
        );
        SessionHook session = new SessionHook{salt: salt}(manager, owner);
        require(address(session) == a, "session addr");

        vm.stopBroadcast();

        console.log("PatienceHook   ", address(patience));
        console.log("SpringHook     ", address(spring));
        console.log("CreatorBondHook", address(bond));
        console.log("SessionHook    ", address(session));
    }
}
