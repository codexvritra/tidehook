// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";
import {TideFeeHook} from "./base/TideFeeHook.sol";

/// @title CreatorBondHook — the creator's bag is collateral for the floor
/// @notice A creator escrows their own allocation in the hook. It vests linearly, but:
///         - it can only be claimed once the token has *held* at or above the creator's floor for
///           `grace` seconds;
///         - the bond *arms* the first time the price reaches the floor; from then on, if the price
///           falls back and stays below the floor for `grace`, anyone can slash the bond and every
///           unclaimed token is burned, shrinking supply for holders. A floor set above the launch
///           price therefore can't be slashed before the token ever got there.
///         The creator's payout is tied to the price they promised, enforced by the pool itself.
/// @dev    Floor crossings are recorded in afterSwap. Price in a v4 pool only moves by swapping,
///         so a swap is always the event that enters or leaves the below-floor state.
///         Both directions require the new state to *persist*: a flash pump (buy, claim, dump in
///         one tx) cannot claim, and an above-floor stint shorter than `grace` does not reset the
///         slash timer, so buy-then-sell round trips cannot postpone a slash.
contract CreatorBondHook is TideFeeHook {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeTransferLib for ERC20;

    error BondExists();
    error NoBond();
    error NotCreator();
    error NotLauncher();
    error NativeNotSupported();
    error PoolNotInitialized();
    error BelowFloor();
    error NotSlashable();
    error Slashed();
    error FloorNotHeld(uint256 heldFor, uint256 required);

    event Bonded(PoolId indexed poolId, address indexed creator, uint256 amount, int24 floorTick);
    event FloorArmed(PoolId indexed poolId, uint64 at);
    event FloorBreached(PoolId indexed poolId, uint64 at);
    event FloorRecovered(PoolId indexed poolId, uint64 at);
    event Claimed(PoolId indexed poolId, uint256 amount);
    event BondSlashed(PoolId indexed poolId, address indexed slasher, uint256 burned);

    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    struct Bond {
        address creator;
        bool creatorIsCurrency0;
        bool slashed;
        int24 floorTick;
        uint64 start;
        uint64 vestDuration;
        uint64 grace; // how long a floor state must persist to count
        bool isBelow;
        bool armed; // price has reached the floor at least once; only then can the bond be slashed
        uint64 belowSince; // start of the below-floor timer (survives short recoveries)
        uint64 aboveSince; // start of the current above-floor stint; 0 while below
        uint128 amount;
        uint128 claimed;
    }

    mapping(PoolId => Bond) internal bonds;

    constructor(IPoolManager _poolManager) TideFeeHook(_poolManager) {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeSwap = true;
        p.afterSwap = true;
        p.beforeSwapReturnDelta = true;
        p.afterSwapReturnDelta = true;
    }

    /// @dev Remembers who called PoolManager.initialize, so nobody can front-run the real creator
    ///      with a dust bond. Initialize directly from the creator, or from a launcher contract
    ///      that bonds in the same transaction.
    function beforeInitialize(address sender, PoolKey calldata key, uint160)
        external
        override
        onlyPoolManager
        returns (bytes4)
    {
        _recordInitializer(sender, key);
        return this.beforeInitialize.selector;
    }

    /// @notice Escrow `amount` of the creator token against `floorTick`. Tokens are pulled from the
    ///         caller (the pool's launcher); vested tokens are paid to `creator`, who alone may claim.
    /// @param floorTick Pool tick of the floor. When the creator token is currency1, a *higher*
    ///        tick means a *cheaper* creator token, and the floor is breached above this tick.
    function bond(
        PoolKey calldata key,
        bool creatorIsCurrency0,
        uint128 amount,
        int24 floorTick,
        uint64 vestDuration,
        uint64 grace,
        address creator
    ) external {
        require(address(key.hooks) == address(this), "hook");
        require(amount > 0 && vestDuration > 0 && creator != address(0), "params");
        PoolId id = key.toId();
        if (msg.sender != initializerOf[id]) revert NotLauncher();
        if (bonds[id].creator != address(0)) revert BondExists();

        (uint160 sqrtPriceX96, int24 tick,,) = poolManager.getSlot0(id);
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();

        Currency token = creatorIsCurrency0 ? key.currency0 : key.currency1;
        if (token.isAddressZero()) revert NativeNotSupported();

        Bond memory b = Bond({
            creator: creator,
            creatorIsCurrency0: creatorIsCurrency0,
            slashed: false,
            floorTick: floorTick,
            start: uint64(block.timestamp),
            vestDuration: vestDuration,
            grace: grace,
            isBelow: false,
            armed: true,
            belowSince: 0,
            aboveSince: uint64(block.timestamp),
            amount: amount,
            claimed: 0
        });
        if (_isBelow(b, tick)) {
            // Launched under the floor: nothing to slash until the price first gets there.
            b.isBelow = true;
            b.armed = false;
            b.aboveSince = 0;
        }
        bonds[id] = b;

        ERC20(Currency.unwrap(token)).safeTransferFrom(msg.sender, address(this), amount);
        emit Bonded(id, creator, amount, floorTick);
    }

    function getBond(PoolId id) external view returns (Bond memory) {
        return bonds[id];
    }

    function vested(PoolId id) public view returns (uint256) {
        Bond storage b = bonds[id];
        uint256 elapsed = block.timestamp - b.start;
        if (elapsed >= b.vestDuration) return b.amount;
        return (uint256(b.amount) * elapsed) / b.vestDuration;
    }

    /// @notice Seconds the floor has held continuously; 0 while below.
    function heldFor(PoolId id) public view returns (uint256) {
        Bond storage b = bonds[id];
        return b.isBelow ? 0 : block.timestamp - b.aboveSince;
    }

    function claimable(PoolId id) public view returns (uint256) {
        Bond storage b = bonds[id];
        if (b.slashed || b.isBelow || heldFor(id) < b.grace) return 0;
        return vested(id) - b.claimed;
    }

    function slashable(PoolId id) public view returns (bool) {
        Bond storage b = bonds[id];
        return
            b.creator != address(0) && !b.slashed && b.armed && b.isBelow && block.timestamp - b.belowSince >= b.grace;
    }

    function claim(PoolKey calldata key) external {
        PoolId id = key.toId();
        Bond storage b = bonds[id];
        if (b.creator == address(0)) revert NoBond();
        if (msg.sender != b.creator) revert NotCreator();
        if (b.slashed) revert Slashed();
        if (b.isBelow) revert BelowFloor();
        uint256 held = heldFor(id);
        if (held < b.grace) revert FloorNotHeld(held, b.grace);

        uint256 amount = vested(id) - b.claimed;
        b.claimed += uint128(amount);
        ERC20(Currency.unwrap(_creatorToken(key, b))).safeTransfer(b.creator, amount);
        emit Claimed(id, amount);
    }

    /// @notice Permissionless: burn everything unclaimed once the floor has been lost for `grace`.
    function slash(PoolKey calldata key) external {
        PoolId id = key.toId();
        Bond storage b = bonds[id];
        if (b.creator == address(0)) revert NoBond();
        if (b.slashed) revert Slashed();
        if (!slashable(id)) revert NotSlashable();

        b.slashed = true;
        uint256 burned = b.amount - b.claimed;
        ERC20(Currency.unwrap(_creatorToken(key, b))).safeTransfer(BURN, burned);
        emit BondSlashed(id, msg.sender, burned);
    }

    /// @dev Bond pools use a static LP fee (0 for launchpad pools); beforeSwap only charges launchpad fees.
    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        override
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        return (this.beforeSwap.selector, _feeBefore(key, params), 0);
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        override
        onlyPoolManager
        returns (bytes4, int128)
    {
        PoolId id = key.toId();
        Bond storage b = bonds[id];
        if (b.creator != address(0) && !b.slashed) {
            (, int24 tick,,) = poolManager.getSlot0(id);
            bool below = _isBelow(b, tick);
            if (below && !b.isBelow) {
                // A recovery that did not hold for `grace` doesn't count: the old timer resumes.
                if (b.belowSince == 0 || block.timestamp - b.aboveSince >= b.grace) {
                    b.belowSince = uint64(block.timestamp);
                }
                b.isBelow = true;
                b.aboveSince = 0;
                emit FloorBreached(id, b.belowSince);
            } else if (!below && b.isBelow) {
                b.isBelow = false;
                b.aboveSince = uint64(block.timestamp);
                if (!b.armed) {
                    b.armed = true;
                    emit FloorArmed(id, uint64(block.timestamp));
                } else {
                    emit FloorRecovered(id, uint64(block.timestamp));
                }
            }
        }
        return (this.afterSwap.selector, _feeAfter(key, params, delta));
    }

    function _isBelow(Bond memory b, int24 tick) internal pure returns (bool) {
        return b.creatorIsCurrency0 ? tick < b.floorTick : tick > b.floorTick;
    }

    function _creatorToken(PoolKey calldata key, Bond storage b) internal view returns (Currency) {
        return b.creatorIsCurrency0 ? key.currency0 : key.currency1;
    }
}
