// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PayrollVault
/// @notice A payroll account owned by one wallet. The owner funds it with one stablecoin (USDG on Robinhood
///         Chain), adds recipients with a fixed amount and schedule, and anyone (the NOUNY keeper bot, the
///         recipient, the owner) can trigger a payment once it is due.
///
/// Guarantees:
///  - Payments only ever go to the address the OWNER registered, for the amount the owner set, at most once
///    per interval. Triggering a payment early, twice, or to another address is impossible.
///  - Only the owner can add/change/remove recipients, pause, or withdraw. The owner can withdraw at any time.
///  - There is no admin, upgrade or fee: NOUNY has no special rights over this contract.
contract PayrollVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Recipient {
        address to;
        uint128 amount; // token units per payment
        uint32 interval; // seconds between payments
        uint64 nextPayAt; // unix time the next payment becomes due
        bool active;
    }

    uint32 public constant MIN_INTERVAL = 1 days;
    uint32 public constant MAX_INTERVAL = 366 days;
    /// @notice Most ACTIVE recipients at once. Removed recipients free their place (review L-2).
    uint256 public constant MAX_RECIPIENTS = 100;
    /// @notice Most recipient records ever (active + removed), so `payAllDue` and `dueNow` stay within gas limits.
    uint256 public constant MAX_SLOTS = 1000;

    address public immutable owner;
    IERC20 public immutable token;

    bool public paused;
    Recipient[] private _recipients;
    uint256 public activeCount;

    event RecipientAdded(uint256 indexed id, address indexed to, uint256 amount, uint32 interval, uint64 firstPayAt);
    event RecipientUpdated(uint256 indexed id, uint256 amount, uint32 interval, uint64 nextPayAt);
    event RecipientRemoved(uint256 indexed id);
    event Paid(uint256 indexed id, address indexed to, uint256 amount, uint64 periodDueAt);
    event Skipped(uint256 indexed id, uint256 needed, uint256 balance);
    event PaymentFailed(uint256 indexed id, address indexed to, uint256 amount);
    event PausedChanged(bool paused);
    event Withdrawn(address indexed to, uint256 amount);

    error NotOwner();
    error IsPaused();
    error ZeroAddress();
    error ZeroAmount();
    error BadInterval();
    error BadStart();
    error TooManyRecipients();
    error UnknownRecipient(uint256 id);
    error NotDue(uint256 id, uint64 dueAt);
    error InsufficientBalance(uint256 needed, uint256 balance);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, address token_) {
        if (owner_ == address(0) || token_ == address(0)) revert ZeroAddress();
        owner = owner_;
        token = IERC20(token_);
    }

    // ---------------------------------------------------------------- owner

    /// @param firstPayAt when the first payment becomes due (0 = now). At most one year ahead.
    function addRecipient(address to, uint128 amount, uint32 interval, uint64 firstPayAt)
        external
        onlyOwner
        returns (uint256 id)
    {
        if (to == address(0) || to == address(this)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (interval < MIN_INTERVAL || interval > MAX_INTERVAL) revert BadInterval();
        if (activeCount >= MAX_RECIPIENTS || _recipients.length >= MAX_SLOTS) revert TooManyRecipients();
        if (firstPayAt == 0) firstPayAt = uint64(block.timestamp);
        if (firstPayAt + 1 < block.timestamp || firstPayAt > block.timestamp + 366 days) revert BadStart();
        id = _recipients.length;
        _recipients.push(Recipient(to, amount, interval, firstPayAt, true));
        ++activeCount;
        emit RecipientAdded(id, to, amount, interval, firstPayAt);
    }

    /// @notice Change amount, interval and next due time. The recipient address is fixed: remove and re-add to change it.
    function updateRecipient(uint256 id, uint128 amount, uint32 interval, uint64 nextPayAt) external onlyOwner {
        Recipient storage r = _active(id);
        if (amount == 0) revert ZeroAmount();
        if (interval < MIN_INTERVAL || interval > MAX_INTERVAL) revert BadInterval();
        if (nextPayAt + 1 < block.timestamp || nextPayAt > block.timestamp + 366 days) revert BadStart();
        r.amount = amount;
        r.interval = interval;
        r.nextPayAt = nextPayAt;
        emit RecipientUpdated(id, amount, interval, nextPayAt);
    }

    function removeRecipient(uint256 id) external onlyOwner {
        _active(id).active = false;
        --activeCount;
        emit RecipientRemoved(id);
    }

    /// @notice Pausing defers payments, it does not cancel them: after `setPaused(false)` every period that fell
    ///         due while paused can be paid. Use `resumeAndSkipMissed` to resume without paying those periods.
    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedChanged(p);
    }

    /// @notice Unpause and move every overdue recipient to its next future due time, so the periods missed
    ///         while paused are not paid (review I-3).
    function resumeAndSkipMissed() external onlyOwner {
        uint256 n = _recipients.length;
        for (uint256 id; id < n; ++id) {
            Recipient storage r = _recipients[id];
            if (!r.active || block.timestamp < r.nextPayAt) continue;
            uint256 periods = (block.timestamp - r.nextPayAt) / r.interval + 1;
            r.nextPayAt += uint64(periods * r.interval);
            emit RecipientUpdated(id, r.amount, r.interval, r.nextPayAt);
        }
        paused = false;
        emit PausedChanged(false);
    }

    /// @notice Withdraw to the owner at any time, also while paused. `amount` = type(uint256).max withdraws everything.
    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        uint256 bal = token.balanceOf(address(this));
        if (amount == type(uint256).max) amount = bal;
        if (amount == 0) revert ZeroAmount();
        if (amount > bal) revert InsufficientBalance(amount, bal);
        token.safeTransfer(owner, amount);
        emit Withdrawn(owner, amount);
    }

    /// @notice Recover a token sent here by mistake (anything other than the payroll token).
    function rescue(address otherToken, uint256 amount) external onlyOwner nonReentrant {
        if (otherToken == address(token)) revert ZeroAddress();
        IERC20(otherToken).safeTransfer(owner, amount);
    }

    // ---------------------------------------------------------------- anyone

    /// @notice Pay one due period to recipient `id`. Reverts if not due or not enough balance.
    function pay(uint256 id) external nonReentrant {
        if (paused) revert IsPaused();
        Recipient storage r = _active(id);
        if (block.timestamp < r.nextPayAt) revert NotDue(id, r.nextPayAt);
        uint256 bal = token.balanceOf(address(this));
        if (bal < r.amount) revert InsufficientBalance(r.amount, bal);
        _pay(id, r);
    }

    /// @notice Pay every recipient that is due (one period each). Skips those the balance cannot cover.
    /// @return paid number of payments made
    function payAllDue() external nonReentrant returns (uint256 paid) {
        if (paused) revert IsPaused();
        uint256 bal = token.balanceOf(address(this));
        uint256 n = _recipients.length;
        for (uint256 id; id < n; ++id) {
            Recipient storage r = _recipients[id];
            if (!r.active || block.timestamp < r.nextPayAt) continue;
            if (bal < r.amount) {
                emit Skipped(id, r.amount, bal);
                continue;
            }
            // One recipient that cannot receive (e.g. frozen by the token issuer) must not block everyone else
            // (review I-4): a failed transfer is skipped and that period stays due.
            uint64 dueAt = r.nextPayAt;
            r.nextPayAt = dueAt + r.interval; // effects before the transfer
            if (_tryTransfer(r.to, r.amount)) {
                bal -= r.amount;
                emit Paid(id, r.to, r.amount, dueAt);
                ++paid;
            } else {
                r.nextPayAt = dueAt;
                emit PaymentFailed(id, r.to, r.amount);
            }
        }
    }

    // ---------------------------------------------------------------- views

    function recipientCount() external view returns (uint256) {
        return _recipients.length;
    }

    function getRecipient(uint256 id) external view returns (Recipient memory) {
        if (id >= _recipients.length) revert UnknownRecipient(id);
        return _recipients[id];
    }

    function getRecipients() external view returns (Recipient[] memory) {
        return _recipients;
    }

    /// @notice Number of payments due now and the token amount they need (one period each).
    function dueNow() external view returns (uint256 count, uint256 amount) {
        if (paused) return (0, 0);
        for (uint256 id; id < _recipients.length; ++id) {
            Recipient storage r = _recipients[id];
            if (r.active && block.timestamp >= r.nextPayAt) {
                ++count;
                amount += r.amount;
            }
        }
    }

    // ---------------------------------------------------------------- internal

    function _active(uint256 id) private view returns (Recipient storage r) {
        if (id >= _recipients.length || !_recipients[id].active) revert UnknownRecipient(id);
        r = _recipients[id];
    }

    /// @dev ERC-20 transfer that returns false instead of reverting (also for tokens that return no value).
    function _tryTransfer(address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory ret) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        return ok && (ret.length == 0 ? address(token).code.length > 0 : (ret.length == 32 && abi.decode(ret, (bool))));
    }

    function _pay(uint256 id, Recipient storage r) private {
        uint64 dueAt = r.nextPayAt;
        r.nextPayAt = dueAt + r.interval; // effects before the transfer
        token.safeTransfer(r.to, r.amount);
        emit Paid(id, r.to, r.amount, dueAt);
    }
}
