// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "solmate/src/tokens/ERC20.sol";

/// @title TideToken
/// @notice Plain fixed-supply ERC20 minted once to the launcher. No owner, no mint, no tax, no blacklist:
///         every rule a tidehook token has lives in its pool's hook, where anyone can read it.
contract TideToken is ERC20 {
    constructor(string memory _name, string memory _symbol, uint256 supply, address to) ERC20(_name, _symbol, 18) {
        _mint(to, supply);
    }
}
