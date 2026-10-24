// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TideBaseHook} from "./base/TideBaseHook.sol";

/// @title SessionHook — fees that follow the stock market's clock
/// @notice Built for pools that pair against tokenized equities on Robinhood Chain. When the
///         underlying exchange is closed, the on-chain price cannot be arbitraged against the real
///         market, so LPs carry gap risk. This hook never halts trading; it prices the risk:
///         cheap during the regular session, moderate in extended hours, expensive while closed,
///         and highest on weekends and listed holidays (the longest gaps).
/// @dev    Session times are UTC seconds-of-day, set by the owner so DST shifts and the exchange
///         holiday calendar can be maintained without redeploying.
contract SessionHook is TideBaseHook {
    using LPFeeLibrary for uint24;

    error MustUseDynamicFee();
    error NotOwner();

    enum Session {
        Regular,
        Extended,
        Closed,
        Weekend
    }

    struct Schedule {
        uint32 preOpen; // extended session starts
        uint32 open; // regular session starts
        uint32 close; // regular session ends
        uint32 postClose; // extended session ends
    }

    event ScheduleSet(Schedule schedule);
    event FeesSet(uint24 regular, uint24 extended, uint24 closed, uint24 weekend);
    event HolidaySet(uint256 indexed day, bool isHoliday);
    event OwnerSet(address owner);

    address public owner;
    Schedule public schedule;
    /// @notice Fee in pips per session, indexed by `Session`.
    uint24[4] public fees;
    /// @notice UTC day index (timestamp / 1 days) => exchange closed all day.
    mapping(uint256 => bool) public holidays;

    constructor(IPoolManager _poolManager, address _owner) TideBaseHook(_poolManager) {
        owner = _owner;
        // NYSE in EDT (UTC-4): pre 08:00, open 13:30, close 20:00, post 24:00 UTC.
        _setSchedule(Schedule({preOpen: 8 hours, open: 13 hours + 30 minutes, close: 20 hours, postClose: 24 hours}));
        _setFees(500, 3000, 10000, 20000);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeSwap = true;
    }

    function sessionAt(uint256 timestamp) public view returns (Session) {
        uint256 day = timestamp / 1 days;
        // 1970-01-01 was a Thursday; with this offset 0 = Sunday, 6 = Saturday.
        uint256 weekday = (day + 4) % 7;
        if (weekday == 0 || weekday == 6 || holidays[day]) return Session.Weekend;

        uint256 t = timestamp % 1 days;
        Schedule memory s = schedule;
        if (t >= s.open && t < s.close) return Session.Regular;
        if (t >= s.preOpen && t < s.postClose) return Session.Extended;
        return Session.Closed;
    }

    function currentFee() public view returns (uint24) {
        return fees[uint256(sessionAt(block.timestamp))];
    }

    function beforeInitialize(address, PoolKey calldata key, uint160)
        external
        view
        override
        onlyPoolManager
        returns (bytes4)
    {
        if (!key.fee.isDynamicFee()) revert MustUseDynamicFee();
        return this.beforeInitialize.selector;
    }

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        view
        override
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        return (
            this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, currentFee() | LPFeeLibrary.OVERRIDE_FEE_FLAG
        );
    }

    // ---------------------------------------------------------------- admin

    function setSchedule(Schedule calldata s) external onlyOwner {
        _setSchedule(s);
    }

    function setFees(uint24 regular, uint24 extended, uint24 closed, uint24 weekend) external onlyOwner {
        _setFees(regular, extended, closed, weekend);
    }

    function setHolidays(uint256[] calldata days_, bool isHoliday) external onlyOwner {
        for (uint256 i; i < days_.length; ++i) {
            holidays[days_[i]] = isHoliday;
            emit HolidaySet(days_[i], isHoliday);
        }
    }

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
        emit OwnerSet(newOwner);
    }

    function _setSchedule(Schedule memory s) internal {
        require(s.preOpen <= s.open && s.open < s.close && s.close <= s.postClose && s.postClose <= 1 days, "schedule");
        schedule = s;
        emit ScheduleSet(s);
    }

    function _setFees(uint24 regular, uint24 extended, uint24 closed, uint24 weekend) internal {
        require(weekend <= LPFeeLibrary.MAX_LP_FEE && closed <= LPFeeLibrary.MAX_LP_FEE, "fee");
        require(regular <= extended && extended <= closed && closed <= weekend, "order");
        fees = [regular, extended, closed, weekend];
        emit FeesSet(regular, extended, closed, weekend);
    }
}
