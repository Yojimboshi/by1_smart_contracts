// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// WETH interface (standard deposit/withdraw)
interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(
        address from,
        address to,
        uint256 value
    ) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title BetCollector
 * @dev Minimal contract for collecting bets and handling withdrawals
 *
 * Philosophy:
 * - Contract only handles money movement (deposits/withdrawals)
 * - Settlement logic (Binance API, who won) is off-chain; anyone can submit the result
 * - setWithdrawable / batchSetWithdrawable are permissionless - caller pays gas
 *
 * Flow:
 * 1. User approves token spending
 * 2. User calls placeBet() - transfers tokens to contract
 * 3. Off-chain: server/Binance determines round outcome
 * 4. Anyone calls setWithdrawable/batchSetWithdrawable with correct (users, amounts) - caller pays gas
 * 5. User calls withdraw() to claim winnings
 */
contract BetCollector is Ownable, ReentrancyGuard, Pausable {
    // WETH token address (immutable, set at deployment)
    IWETH public immutable weth;

    // Mapping: user => token => withdrawable amount
    mapping(address => mapping(address => uint256)) public withdrawableBalances;

    // Mapping: supported tokens
    mapping(address => bool) public supportedTokens;

    // roundId (keccak256) => true if already settled. Prevents double-settlement / double-credit.
    mapping(bytes32 => bool) public settledRounds;

    // Events
    event BetPlaced(
        address indexed user,
        address indexed token,
        uint256 amount,
        string roundId,
        bool isUp
    );

    event WithdrawableSet(
        address indexed user,
        address indexed token,
        uint256 amount,
        string roundId
    );

    event Withdrawn(
        address indexed user,
        address indexed token,
        uint256 amount
    );

    event TokenAdded(address indexed token);
    event TokenRemoved(address indexed token);

    // Errors
    error TokenNotSupported();
    error InvalidAmount();
    error InsufficientWithdrawable();
    error TransferFailed();
    error RoundAlreadySettled();

    constructor(address _weth) Ownable(msg.sender) {
        require(_weth != address(0), "Invalid WETH address");
        weth = IWETH(_weth);

        // WETH is always supported (for native ETH wrapping)
        supportedTokens[_weth] = true;
    }

    /**
     * @dev Place a bet - supports both native ETH and ERC-20 tokens
     * @param token Token address to bet with (use WETH address for native ETH)
     * @param amount Amount to bet (in wei) - ignored if sending native ETH
     * @param roundId Round identifier (for event logging only)
     * @param isUp true for UP bet, false for DOWN bet (for event logging only)
     *
     * Usage:
     * - Native ETH: Send ETH via msg.value, token = WETH address, amount = 0
     * - ERC-20: Approve token first, then call with msg.value = 0
     */
    function placeBet(
        address token,
        uint256 amount,
        string calldata roundId,
        bool isUp
    ) external payable nonReentrant whenNotPaused {
        if (!supportedTokens[token]) revert TokenNotSupported();

        uint256 betAmount = 0;

        // Handle native ETH (auto-wrap to WETH)
        if (token == address(weth)) {
            if (msg.value > 0) {
                // Native ETH: auto-wrap to WETH
                betAmount = msg.value;
                weth.deposit{value: msg.value}();
            } else {
                // WETH directly: transferFrom
                if (amount == 0) revert InvalidAmount();
                betAmount = amount;
                bool success = weth.transferFrom(
                    msg.sender,
                    address(this),
                    amount
                );
                if (!success) revert TransferFailed();
            }
        } else {
            // Handle other ERC-20 tokens
            if (msg.value > 0) revert InvalidAmount(); // Cannot send ETH for non-WETH token bet
            if (amount == 0) revert InvalidAmount();
            betAmount = amount;
            bool success = IERC20(token).transferFrom(
                msg.sender,
                address(this),
                amount
            );
            if (!success) revert TransferFailed();
        }

        emit BetPlaced(msg.sender, token, betAmount, roundId, isUp);
    }

    /**
     * @dev Set withdrawable amount for a user (permissionless - caller pays gas)
     * Settlement data must match off-chain outcome (Binance API). settledRounds prevents double-credit.
     */
    function setWithdrawable(
        address user,
        address token,
        uint256 amount,
        string calldata roundId
    ) external {
        bytes32 rId = keccak256(abi.encodePacked(roundId));
        if (settledRounds[rId]) revert RoundAlreadySettled();
        settledRounds[rId] = true;
        withdrawableBalances[user][token] += amount;
        emit WithdrawableSet(user, token, amount, roundId);
    }

    /**
     * @dev Batch set withdrawable amounts (permissionless - caller pays gas)
     * Settlement data must match off-chain outcome. settledRounds prevents double-credit.
     */
    function batchSetWithdrawable(
        address[] calldata users,
        address[] calldata tokens,
        uint256[] calldata amounts,
        string calldata roundId
    ) external {
        require(
            users.length == tokens.length && tokens.length == amounts.length,
            "Array length mismatch"
        );

        bytes32 rId = keccak256(abi.encodePacked(roundId));
        if (settledRounds[rId]) revert RoundAlreadySettled();
        settledRounds[rId] = true;

        for (uint256 i = 0; i < users.length; i++) {
            withdrawableBalances[users[i]][tokens[i]] += amounts[i];
            emit WithdrawableSet(users[i], tokens[i], amounts[i], roundId);
        }
    }

    /**
     * @dev Withdraw available balance
     * @param token Token address to withdraw
     * @param amount Amount to withdraw (0 = withdraw all)
     */
    function withdraw(address token, uint256 amount) external nonReentrant {
        uint256 available = withdrawableBalances[msg.sender][token];
        if (available == 0) revert InsufficientWithdrawable();

        uint256 withdrawAmount = amount == 0 ? available : amount;
        if (withdrawAmount > available) revert InsufficientWithdrawable();

        withdrawableBalances[msg.sender][token] -= withdrawAmount;

        bool success = IERC20(token).transfer(msg.sender, withdrawAmount);
        if (!success) revert TransferFailed();

        emit Withdrawn(msg.sender, token, withdrawAmount);
    }

    /**
     * @dev Withdraw WETH winnings as raw ETH (unwrap WETH to ETH)
     * @param amount Amount to withdraw (0 = withdraw all)
     */
    function withdrawAsEth(uint256 amount) external nonReentrant {
        uint256 available = withdrawableBalances[msg.sender][address(weth)];
        if (available == 0) revert InsufficientWithdrawable();

        uint256 withdrawAmount = amount == 0 ? available : amount;
        if (withdrawAmount > available) revert InsufficientWithdrawable();

        withdrawableBalances[msg.sender][address(weth)] -= withdrawAmount;

        // Unwrap WETH to ETH
        weth.withdraw(withdrawAmount);

        // Send ETH to user
        (bool success, ) = payable(msg.sender).call{value: withdrawAmount}("");
        if (!success) revert TransferFailed();

        emit Withdrawn(msg.sender, address(weth), withdrawAmount);
    }

    /**
     * @dev Get withdrawable balance for user
     * @param user User address
     * @param token Token address
     */
    function getWithdrawableBalance(
        address user,
        address token
    ) external view returns (uint256) {
        return withdrawableBalances[user][token];
    }

    /**
     * @dev Check if a round was already settled (prevents double-settlement)
     * @param roundId Round identifier
     */
    function isRoundSettled(string calldata roundId) external view returns (bool) {
        return settledRounds[keccak256(abi.encodePacked(roundId))];
    }

    /**
     * @dev Add supported token (admin only)
     * @param token Token address to add
     */
    function addSupportedToken(address token) external onlyOwner {
        require(token != address(0), "Invalid token");
        supportedTokens[token] = true;
        emit TokenAdded(token);
    }

    /**
     * @dev Remove supported token (admin only)
     * @param token Token address to remove
     */
    function removeSupportedToken(address token) external onlyOwner {
        // Prevent removing WETH (needed for native ETH wrapping)
        require(token != address(weth), "Cannot remove WETH");
        supportedTokens[token] = false;
        emit TokenRemoved(token);
    }

    /**
     * @dev Pause contract (admin only)
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @dev Unpause contract (admin only)
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @dev Emergency withdraw ERC-20 tokens (admin only) - for stuck funds
     * @param token Token address
     * @param amount Amount to withdraw (0 = all)
     */
    function emergencyWithdraw(
        address token,
        uint256 amount
    ) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 withdrawAmount = amount == 0 ? balance : amount;

        bool success = IERC20(token).transfer(owner(), withdrawAmount);
        if (!success) revert TransferFailed();
    }

    /**
     * @dev Emergency withdraw native ETH (admin only) - for stuck ETH
     * @param amount Amount to withdraw (0 = all)
     */
    function emergencyWithdrawEth(uint256 amount) external onlyOwner {
        uint256 balance = address(this).balance;
        uint256 withdrawAmount = amount == 0 ? balance : amount;

        (bool success, ) = payable(owner()).call{value: withdrawAmount}("");
        if (!success) revert TransferFailed();
    }

    // Receive native ETH (for WETH wrapping)
    receive() external payable {}
}
