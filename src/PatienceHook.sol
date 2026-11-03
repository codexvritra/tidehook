// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TideFeeHook} from "./base/TideFeeHook.sol";

/// @title PatienceHook — "pay less for waiting"
/// @notice A two-lane fee market. The fast lane swaps immediately at `baseFee`. The slow lane
///         first commits a salted hash of its exact swap, waits, then reveals it through hookData;
///         the fee decays linearly from `baseFee` to `minFee` the longer the commitment aged.
/// @dev    Side effects of the design:
///         - Snipers and MEV bots that need to act *now* subsidise patient traders via LP fees.
///         - The intent (direction, size, limit) stays hidden until reveal, so it cannot be
///           front-run from the commit transaction.
///         Ages are measured in seconds, not blocks: on Arbitrum-Orbit chains such as Robinhood
///         Chain `block.number` tracks L1, so timestamps are the reliable clock.
contract PatienceHook is TideFeeHook {
    using PoolIdLibrary for PoolKey;
    using LPFeeLibrary for uint24;

    error MustUseDynamicFee();
    error UnknownCommitment();
    error CommitmentTooYoung(uint256 age, uint256 minAge);
    error CommitmentExpired(uint256 age, uint256 maxAge);
    error AlreadyCommitted();

    event Committed(bytes32 indexed commitment, uint64 timestamp);
    event Redeemed(bytes32 indexed commitment, PoolId indexed poolId, uint256 age, uint24 fee);

    /// @notice Fee in pips (1e6 = 100%) charged to swaps without a commitment.
    uint24 public immutable baseFee;
    /// @notice Floor fee reached once a commitment has aged `minAge + rampDuration`.
    uint24 public immutable minFee;
    /// @notice Seconds a commitment must age before it can be redeemed at all.
    uint32 public immutable minAge;
    /// @notice Seconds over which the fee decays from `baseFee` to `minFee`.
    uint32 public immutable rampDuration;
    /// @notice Seconds after which a commitment can no longer be redeemed.
    uint32 public immutable maxAge;

    /// @notice commitment => timestamp it was posted.
    mapping(bytes32 => uint64) public commitments;
    /// @notice Pool launch time. Commitments only start ageing once the pool exists, so pool ids
    ///         (which are deterministic) can't be pre-committed for a cheap launch-block snipe.
    mapping(PoolId => uint64) public initializedAt;

    constructor(
        IPoolManager _poolManager,
        uint24 _baseFee,
        uint24 _minFee,
        uint32 _minAge,
        uint32 _rampDuration,
        uint32 _maxAge
    ) TideFeeHook(_poolManager) {
        require(_minFee <= _baseFee && _baseFee <= LPFeeLibrary.MAX_LP_FEE, "fees");
        require(_rampDuration > 0 && _minAge + _rampDuration <= _maxAge, "timing");
        baseFee = _baseFee;
        minFee = _minFee;
        minAge = _minAge;
        rampDuration = _rampDuration;
        maxAge = _maxAge;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeSwap = true;
        p.afterSwap = true;
        p.beforeSwapReturnDelta = true;
        p.afterSwapReturnDelta = true;
    }

    /// @notice Hash a swap the same way the hook will when it is revealed.
    function commitmentOf(PoolKey calldata key, SwapParams calldata params, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(key.toId(), params.zeroForOne, params.amountSpecified, params.sqrtPriceLimitX96, salt)
        );
    }

    /// @notice Post a commitment. Reveals nothing about the swap it stands for.
    function commit(bytes32 commitment) external {
        if (commitments[commitment] != 0) revert AlreadyCommitted();
        commitments[commitment] = uint64(block.timestamp);
        emit Committed(commitment, uint64(block.timestamp));
    }

    /// @notice Age a commitment would have right now in `id`, counted from max(commit, launch).
    function ageOf(PoolId id, bytes32 commitment) external view returns (uint256) {
        uint64 postedAt = commitments[commitment];
        if (postedAt == 0) return 0;
        uint64 launched = initializedAt[id];
        return block.timestamp - (postedAt > launched ? postedAt : launched);
    }

    /// @notice Fee a commitment of the given age would pay.
    function feeForAge(uint256 age) public view returns (uint24) {
        if (age < minAge) revert CommitmentTooYoung(age, minAge);
        if (age > maxAge) revert CommitmentExpired(age, maxAge);
        uint256 elapsed = age - minAge;
        if (elapsed >= rampDuration) return minFee;
        return uint24(baseFee - (uint256(baseFee - minFee) * elapsed) / rampDuration);
    }

    function beforeInitialize(address sender, PoolKey calldata key, uint160)
        external
        override
        onlyPoolManager
        returns (bytes4)
    {
        if (!key.fee.isDynamicFee()) revert MustUseDynamicFee();
        _recordInitializer(sender, key);
        initializedAt[key.toId()] = uint64(block.timestamp);
        return this.beforeInitialize.selector;
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        override
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        uint24 fee = baseFee;

        // Slow lane: hookData carries the salt. A bad or immature salt reverts rather than
        // silently charging the fast-lane fee the trader was trying to avoid.
        if (hookData.length >= 32) {
            bytes32 salt = abi.decode(hookData, (bytes32));
            bytes32 commitment = commitmentOf(key, params, salt);
            uint64 postedAt = commitments[commitment];
            if (postedAt == 0) revert UnknownCommitment();

            PoolId id = key.toId();
            uint64 launched = initializedAt[id];
            uint256 age = block.timestamp - (postedAt > launched ? postedAt : launched);
            fee = feeForAge(age);
            delete commitments[commitment];
            emit Redeemed(commitment, id, age, fee);
        }

        return (this.beforeSwap.selector, _feeBefore(key, params), _lpFee(key, fee) | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }
}
