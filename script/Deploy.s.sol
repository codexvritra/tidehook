// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";

/// @notice Deploys the whole stack from the frozen init code in web/src/deploy/initcode.json: the exact
///         bytes the web app's Deploy page sends, through the canonical CREATE2 deployer. One source of
///         truth for both paths, so the addresses can never drift from deployments/robinhood.json.
///         Contracts that already exist are skipped.
///
///   forge script script/Deploy.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --account <keystore>
contract Deploy is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint256 constant COUNT = 6;

    function run() external {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/web/src/deploy/initcode.json"));

        vm.startBroadcast();
        for (uint256 i; i < COUNT; ++i) {
            string memory at = string.concat("[", vm.toString(i), "]");
            string memory name = vm.parseJsonString(json, string.concat(at, ".name"));
            address target = vm.parseJsonAddress(json, string.concat(at, ".address"));
            if (target.code.length > 0) {
                console.log("exists  ", name, target);
                continue;
            }
            bytes32 salt = vm.parseJsonBytes32(json, string.concat(at, ".salt"));
            bytes memory initCode = vm.parseJsonBytes(json, string.concat(at, ".initCode"));
            (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
            require(ok && address(bytes20(ret)) == target, string.concat(name, ": unexpected address"));
            console.log("deployed", name, target);
        }
        vm.stopBroadcast();
    }
}
