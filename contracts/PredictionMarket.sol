// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
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
    function approve(address spender, uint256 amount) external returns (bool);
}

/**
 * @title PredictionMarket
 * @dev On-chain prediction market with server-signed settlement (Method B)
 *
 * Flow:
 * 1. Admin creates round
 * 2. Admin adds supported tokens via token registry
 * 3. Users can bet with any supported token:
 *    - WETH: Send native ETH (auto-wrapped) or approve WETH and transferFrom
 *    - Other tokens: Approve token once, then transferFrom
 * 4. Server signs settlement (off-chain)
 * 5. Anyone can relay settlement (with signature)
 * 6. Users claim winnings (same token as bet)
 *
 * Supports multiple ERC-20 tokens via token registry. Each bet tracks which token was used.
 */
contract PredictionMarket is EIP712, Ownable, ReentrancyGuard, Pausable {
    using ECDSA for bytes32;

    // EIP-712 domain separator
    bytes32 public constant SETTLEMENT_TYPEHASH =
        keccak256(
            "Settlement(string roundId,uint256 closePrice,uint8 outcome,uint256 chainId,address contractAddress,uint256 settledAt)"
        );

    // Outcome enum
    enum Outcome {
        TIE,
        UP,
        DOWN
    }

    // Round status
    enum RoundStatus {
        OPEN,
        LOCKED,
        SETTLED
    }

    // Round structure
    struct Round {
        string roundId; // Backend round ID
        string symbol; // e.g., "BTCUSDT"
        uint256 startTime;
        uint256 lockTime;
        uint256 endTime;
        uint256 closePrice; // Set on settlement
        Outcome outcome; // Set on settlement
        RoundStatus status;
        uint256 totalUpBets;
        uint256 totalDownBets;
        bool settled;
    }

    // User bet structure
    struct Bet {
        bool isUp; // true = UP, false = DOWN
        uint256 amount; // Bet amount in tokens
        address token; // Token address used for bet
        bool claimed; // Whether winnings claimed
    }

    // WETH token address (immutable, set at deployment, for native ETH wrapping)
    IWETH public immutable weth;

    // Token registry: mapping of supported token addresses
    mapping(address => bool) public supportedTokens;

    // Oracle signer address (server's public key)
    address public oracleSigner;

    // Mapping: roundId => Round
    mapping(string => Round) public rounds;

    // Mapping: roundId => user => Bet
    mapping(string => mapping(address => Bet)) public bets;

    // Mapping: roundId => address[] (all bettors)
    mapping(string => address[]) public bettors;

    // Events
    event RoundCreated(
        string indexed roundId,
        string symbol,
        uint256 startTime,
        uint256 lockTime,
        uint256 endTime
    );
    event BetPlaced(
        string indexed roundId,
        address indexed bettor,
        bool isUp,
        uint256 amount,
        address indexed token
    );
    event RoundSettled(
        string indexed roundId,
        uint256 closePrice,
        Outcome outcome
    );
    event WinningsClaimed(
        string indexed roundId,
        address indexed bettor,
        uint256 amount,
        address indexed token
    );
    event TokenAdded(address indexed token);
    event TokenRemoved(address indexed token);

    // Errors
    error RoundNotFound();
    error RoundNotOpen();
    error RoundAlreadySettled();
    error InvalidBetAmount();
    error InvalidSignature();
    error NoWinnings();
    error AlreadyClaimed();
    error InvalidOutcome();
    error TokenNotSupported();
    error TokenMismatch();

    constructor(
        address _weth,
        address _oracleSigner
    ) EIP712("PredictionMarket", "1") Ownable(msg.sender) {
        require(_weth != address(0), "Invalid WETH address");
        require(_oracleSigner != address(0), "Invalid oracle signer");
        weth = IWETH(_weth);
        oracleSigner = _oracleSigner;

        // WETH is always supported (for native ETH wrapping)
        supportedTokens[_weth] = true;
    }

    /**
     * @dev Create a new prediction round (admin only)
     */
    function createRound(
        string memory roundId,
        string memory symbol,
        uint256 startTime,
        uint256 lockTime,
        uint256 endTime
    ) external onlyOwner {
        require(lockTime <= startTime, "Lock time must be before or at start");
        require(endTime > startTime, "End time must be after start");
        require(
            bytes(rounds[roundId].roundId).length == 0,
            "Round already exists"
        );

        rounds[roundId] = Round({
            roundId: roundId,
            symbol: symbol,
            startTime: startTime,
            lockTime: lockTime,
            endTime: endTime,
            closePrice: 0,
            outcome: Outcome.TIE,
            status: RoundStatus.OPEN,
            totalUpBets: 0,
            totalDownBets: 0,
            settled: false
        });

        emit RoundCreated(roundId, symbol, startTime, lockTime, endTime);
    }

    /**
     * @dev Place a bet on a round
     * @param roundId Round identifier
     * @param isUp true for UP bet, false for DOWN bet
     * @param amount Amount of tokens to bet
     * @param token Token address to bet with (must be in supportedTokens registry)
     *
     * Payment methods:
     * - WETH (token == weth address):
     *   * Native ETH: Send ETH via msg.value, auto-wrapped to WETH
     *   * WETH directly: Approve WETH first, then transferFrom
     * - Other tokens:
     *   * Approve token first (token.approve(PredictionMarket, MAX_UINT))
     *   * Then transferFrom with amount
     *
     * Note: If placing multiple bets on same round, must use same token address.
     */
    function placeBet(
        string memory roundId,
        bool isUp,
        uint256 amount,
        address token
    ) external payable nonReentrant whenNotPaused {
        Round storage round = rounds[roundId];

        if (bytes(round.roundId).length == 0) revert RoundNotFound();
        if (round.status != RoundStatus.OPEN) revert RoundNotOpen();
        if (block.timestamp >= round.lockTime) revert RoundNotOpen();
        if (!supportedTokens[token]) revert TokenNotSupported();

        uint256 betAmount = 0;

        // Handle WETH (native ETH wrapping)
        if (token == address(weth)) {
            if (msg.value > 0) {
                // Native ETH: auto-wrap to WETH
                betAmount = msg.value;
                weth.deposit{value: msg.value}();
            } else {
                // WETH directly: transferFrom
                if (amount == 0) revert InvalidBetAmount();
                betAmount = amount;
                weth.transferFrom(msg.sender, address(this), amount);
            }
        } else {
            // Handle other ERC20 tokens
            if (msg.value > 0) revert InvalidBetAmount(); // Cannot send ETH for non-WETH token bet
            if (amount == 0) revert InvalidBetAmount();
            betAmount = amount;
            IERC20(token).transferFrom(msg.sender, address(this), amount);
        }

        // Update or create bet
        Bet storage bet = bets[roundId][msg.sender];

        // Check if user already has a bet with different token
        if (bet.amount > 0 && bet.token != token) {
            revert TokenMismatch();
        }

        if (bet.amount == 0) {
            // New bettor
            bettors[roundId].push(msg.sender);
            bet.token = token;
        }

        bet.isUp = isUp;
        bet.amount += betAmount;

        // Update round totals
        if (isUp) {
            round.totalUpBets += betAmount;
        } else {
            round.totalDownBets += betAmount;
        }

        emit BetPlaced(roundId, msg.sender, isUp, betAmount, token);
    }

    /**
     * @dev Settle a round using server-signed settlement (anyone can call)
     * @param settledAt Unix timestamp when settlement was signed (must be within reasonable window of block.timestamp)
     */
    function settleRound(
        string memory roundId,
        uint256 closePrice,
        uint8 outcome,
        uint256 settledAt,
        bytes memory signature
    ) external nonReentrant {
        Round storage round = rounds[roundId];

        if (bytes(round.roundId).length == 0) revert RoundNotFound();
        if (round.settled) revert RoundAlreadySettled();
        if (outcome > 2) revert InvalidOutcome();

        // Validate settledAt is within reasonable window (allow 1 hour in past, 5 minutes in future for clock skew)
        require(
            settledAt <= block.timestamp + 300,
            "Settlement timestamp too far in future"
        );
        require(
            settledAt >= block.timestamp - 3600,
            "Settlement timestamp too far in past"
        );

        // Verify signature
        bytes32 hash = _hashSettlement(roundId, closePrice, outcome, settledAt);
        address signer = hash.recover(signature);

        if (signer != oracleSigner) revert InvalidSignature();

        // Update round
        round.closePrice = closePrice;
        round.outcome = Outcome(outcome);
        round.status = RoundStatus.SETTLED;
        round.settled = true;

        emit RoundSettled(roundId, closePrice, Outcome(outcome));
    }

    /**
     * @dev Claim winnings for a settled round
     * Pays out in the same token as the bet
     */
    function claimWinnings(string memory roundId) external nonReentrant {
        Round storage round = rounds[roundId];
        Bet storage bet = bets[roundId][msg.sender];

        if (bytes(round.roundId).length == 0) revert RoundNotFound();
        if (!round.settled) revert RoundNotOpen();
        if (bet.amount == 0) revert NoWinnings();
        if (bet.claimed) revert AlreadyClaimed();

        uint256 payout = 0;

        // Calculate payout
        if (round.outcome == Outcome.TIE) {
            // Refund bet amount
            payout = bet.amount;
        } else if (
            (round.outcome == Outcome.UP && bet.isUp) ||
            (round.outcome == Outcome.DOWN && !bet.isUp)
        ) {
            // Win: 2x bet amount
            payout = bet.amount * 2;
        } else {
            // Loss: no payout
            revert NoWinnings();
        }

        bet.claimed = true;

        // Transfer winnings in the same token as bet
        if (bet.token == address(weth)) {
            weth.transfer(msg.sender, payout);
        } else {
            IERC20(bet.token).transfer(msg.sender, payout);
        }

        emit WinningsClaimed(roundId, msg.sender, payout, bet.token);
    }

    /**
     * @dev Get user's bet for a round
     */
    function getUserBet(
        string memory roundId,
        address user
    ) external view returns (Bet memory) {
        return bets[roundId][user];
    }

    /**
     * @dev Get round details
     */
    function getRound(
        string memory roundId
    ) external view returns (Round memory) {
        return rounds[roundId];
    }

    /**
     * @dev Get all bettors for a round
     */
    function getBettors(
        string memory roundId
    ) external view returns (address[] memory) {
        return bettors[roundId];
    }

    /**
     * @dev Update oracle signer (admin only)
     */
    function setOracleSigner(address _oracleSigner) external onlyOwner {
        require(_oracleSigner != address(0), "Invalid oracle signer");
        oracleSigner = _oracleSigner;
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
     * @dev Add a supported token to the registry (admin only)
     */
    function addSupportedToken(address token) external onlyOwner {
        require(token != address(0), "Invalid token");
        supportedTokens[token] = true;
        emit TokenAdded(token);
    }

    /**
     * @dev Remove a supported token from the registry (admin only)
     */
    function removeSupportedToken(address token) external onlyOwner {
        require(token != address(0), "Invalid token");
        // Prevent removing WETH (needed for native ETH wrapping)
        require(token != address(weth), "Cannot remove WETH");
        supportedTokens[token] = false;
        emit TokenRemoved(token);
    }

    /**
     * @dev Emergency withdraw tokens (admin only, for stuck funds)
     * Withdraws all balances of all supported tokens
     */
    function emergencyWithdraw() external onlyOwner {
        // Withdraw WETH
        uint256 wethBalance = weth.balanceOf(address(this));
        if (wethBalance > 0) {
            weth.transfer(owner(), wethBalance);
        }

        // Note: For other tokens, owner should call emergencyWithdrawToken for each token
        // This prevents gas issues with many tokens
    }

    /**
     * @dev Emergency withdraw specific token (admin only)
     */
    function emergencyWithdrawToken(address token) external onlyOwner {
        require(token != address(0), "Invalid token");
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).transfer(owner(), balance);
        }
    }

    /**
     * @dev Claim winnings as raw ETH (for WETH bets only)
     * Claims WETH winnings and unwraps to ETH in one transaction
     */
    function claimWinningsAsEth(string memory roundId) external nonReentrant {
        Round storage round = rounds[roundId];
        Bet storage bet = bets[roundId][msg.sender];

        if (bytes(round.roundId).length == 0) revert RoundNotFound();
        if (!round.settled) revert RoundNotOpen();
        if (bet.amount == 0) revert NoWinnings();
        if (bet.claimed) revert AlreadyClaimed();
        if (bet.token != address(weth)) revert TokenMismatch(); // Only for WETH bets

        uint256 payout = 0;

        // Calculate payout
        if (round.outcome == Outcome.TIE) {
            payout = bet.amount;
        } else if (
            (round.outcome == Outcome.UP && bet.isUp) ||
            (round.outcome == Outcome.DOWN && !bet.isUp)
        ) {
            payout = bet.amount * 2;
        } else {
            revert NoWinnings();
        }

        bet.claimed = true;

        // Unwrap WETH to ETH and send to user
        weth.withdraw(payout);
        (bool success, ) = payable(msg.sender).call{value: payout}("");
        require(success, "ETH transfer failed");

        emit WinningsClaimed(roundId, msg.sender, payout, bet.token);
    }

    /**
     * @dev Withdraw WETH as raw ETH (unwrap WETH to ETH)
     * Users can call this to convert their WETH to ETH
     * Requires user to approve contract to spend their WETH first
     * @param amount Amount of WETH to unwrap
     */
    function withdrawWethAsEth(uint256 amount) external nonReentrant {
        require(amount > 0, "Amount must be greater than 0");

        // Transfer WETH from user to contract
        weth.transferFrom(msg.sender, address(this), amount);

        // Unwrap WETH to ETH
        weth.withdraw(amount);

        // Send ETH to user
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "ETH transfer failed");
    }

    /**
     * @dev Hash settlement message for EIP-712
     * @param settledAt Unix timestamp when settlement was signed (must match signature)
     */
    function _hashSettlement(
        string memory roundId,
        uint256 closePrice,
        uint8 outcome,
        uint256 settledAt
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                SETTLEMENT_TYPEHASH,
                keccak256(bytes(roundId)),
                closePrice,
                outcome,
                block.chainid,
                address(this),
                settledAt
            )
        );
        return _hashTypedDataV4(structHash);
    }

    // Receive native tokens (for WETH wrapping)
    receive() external payable {}
}
