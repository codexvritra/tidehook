// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";

interface ITideVetoLauncher {
    function pendingMigration(uint256 id)
        external
        view
        returns (uint8 kind, address quote, uint64 readyAt, int24 routeTick, bytes32 routeId);
    function migrationRound(uint256 id) external view returns (uint32);
    function tokenOf(uint256 id) external view returns (address);
    function bondHook() external view returns (address);
}

/// @title TideVeto
/// @notice Holders can block a launch's announced hook or pair switch. While a migration is pending, any holder
///         may lock the launch's tokens here against it; if the locked amount reaches VETO_BPS of the circulating
///         supply (everything outside the pool, the burn address and the creator bond) the launcher refuses to
///         execute it. Tokens can be unlocked at any time, which also withdraws their vote.
///         Every new proposal starts a new round with an empty tally, so a creator can't reuse an old count.
contract TideVeto {
    using SafeTransferLib for ERC20;

    struct Tally {
        uint32 round;
        uint224 locked;
    }

    struct Lock {
        uint32 round;
        uint224 amount;
    }

    event Locked(uint256 indexed id, uint32 indexed round, address indexed holder, uint256 amount, uint256 total);
    event Unlocked(uint256 indexed id, uint32 indexed round, address indexed holder, uint256 amount, uint256 total);

    error NothingToVeto();
    error VotingClosed();
    error UnlockFirst();
    error NothingLocked();
    error ZeroAmount();

    uint256 public constant VETO_BPS = 1_000; // 10% of the circulating supply blocks a migration
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    ITideVetoLauncher public immutable launcher;
    address public immutable poolManager;

    mapping(uint256 => Tally) public tally;
    mapping(uint256 => mapping(address => Lock)) public lockOf;

    constructor(address _launcher, address _poolManager) {
        launcher = ITideVetoLauncher(_launcher);
        poolManager = _poolManager;
    }

    /// @notice Lock `amount` of launch `id`'s token against its pending migration.
    function lock(uint256 id, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        (,, uint64 readyAt,,) = launcher.pendingMigration(id);
        if (readyAt == 0) revert NothingToVeto();
        if (block.timestamp >= readyAt) revert VotingClosed();
        uint32 round = launcher.migrationRound(id);

        Lock storage me = lockOf[id][msg.sender];
        if (me.amount != 0 && me.round != round) revert UnlockFirst(); // tokens still sit in an old round
        Tally storage t = tally[id];
        if (t.round != round) (t.round, t.locked) = (round, 0);

        ERC20(launcher.tokenOf(id)).safeTransferFrom(msg.sender, address(this), amount);
        me.round = round;
        me.amount += uint224(amount);
        t.locked += uint224(amount);
        emit Locked(id, round, msg.sender, amount, t.locked);
    }

    /// @notice Take back everything you locked on launch `id` (and your vote, if its round is still open).
    function unlock(uint256 id) external {
        Lock memory me = lockOf[id][msg.sender];
        if (me.amount == 0) revert NothingLocked();
        delete lockOf[id][msg.sender];
        Tally storage t = tally[id];
        if (t.round == me.round) t.locked -= me.amount;
        ERC20(launcher.tokenOf(id)).safeTransfer(msg.sender, me.amount);
        emit Unlocked(id, me.round, msg.sender, me.amount, t.round == me.round ? t.locked : 0);
    }

    /// @notice Tokens of launch `id` held by people (not the pool, the burn address or the creator bond).
    function circulating(uint256 id) public view returns (uint256) {
        ERC20 token = ERC20(launcher.tokenOf(id));
        return token.totalSupply() - token.balanceOf(poolManager) - token.balanceOf(BURN)
            - token.balanceOf(launcher.bondHook());
    }

    /// @notice Votes against the current round and the amount needed to block it.
    function status(uint256 id) public view returns (uint256 locked, uint256 needed, bool blocked) {
        uint32 round = launcher.migrationRound(id);
        Tally memory t = tally[id];
        locked = t.round == round ? t.locked : 0;
        needed = (circulating(id) * VETO_BPS + 9_999) / 10_000;
        blocked = locked != 0 && locked >= needed;
    }

    function isVetoed(uint256 id) external view returns (bool blocked) {
        (,, blocked) = status(id);
    }
}
