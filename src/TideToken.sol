// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "solmate/src/tokens/ERC20.sol";

/// @title TideToken
/// @notice Fixed-supply ERC20 minted once. No mint, no tax, no blacklist, no transfer hooks.
///         The only privileged action is a cosmetic one: the launcher may update `name` and `symbol`
///         when the token's creator renames it (rate-limited and logged by the launcher).
contract TideToken is ERC20 {
    error NotLauncher();

    event Renamed(string name, string symbol);

    address public immutable launcher;

    constructor(string memory _name, string memory _symbol, uint256 supply, address to, address _launcher)
        ERC20(_name, _symbol, 18)
    {
        launcher = _launcher;
        _mint(to, supply);
    }

    function setMetadata(string calldata _name, string calldata _symbol) external {
        if (msg.sender != launcher) revert NotLauncher();
        name = _name;
        symbol = _symbol;
        emit Renamed(_name, _symbol);
    }
}

/// @title TideTokenFactory
/// @notice Deploys TideTokens for the launcher, keeping the token bytecode out of the launcher's size budget.
contract TideTokenFactory {
    function create(string calldata name, string calldata symbol, uint256 supply, address to)
        external
        returns (address)
    {
        return address(new TideToken(name, symbol, supply, to, msg.sender));
    }
}
