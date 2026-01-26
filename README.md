# BY1 Smart Contracts

Smart contracts for the BY1 prediction market platform.

## Structure

```
contracts/
  ├── PredictionMarket.sol    # Main prediction market contract
  └── mocks/
      ├── MockWETH.sol        # Mock WETH for testing
      └── MockERC20.sol       # Mock ERC20 for testing

test/
  └── PredictionMarket.test.ts  # Comprehensive test suite

scripts/
  └── deploy.ts              # Deployment script
```

## Setup

1. Install dependencies:
```bash
npm install
```

2. Compile contracts:
```bash
npm run compile
```

3. Run tests:
```bash
npm run test
```

## Deployment

### Local (Hardhat Network)
```bash
npm run deploy:local
```

### BSC Testnet
```bash
WETH_ADDRESS=<weth_address> ORACLE_SIGNER_ADDRESS=<oracle_address> npm run deploy:bsc-testnet
```

### BSC Mainnet
```bash
WETH_ADDRESS=<weth_address> ORACLE_SIGNER_ADDRESS=<oracle_address> npm run deploy:bsc-mainnet
```

## Environment Variables

- `WETH_ADDRESS`: WETH token address (optional, will deploy MockWETH if not provided)
- `ORACLE_SIGNER_ADDRESS`: Oracle signer address for settlement signatures
- `PRIVATE_KEY`: Private key for deployment (for testnet/mainnet)
- `BSC_TESTNET_RPC_URL`: BSC testnet RPC URL (optional)
- `BSC_MAINNET_RPC_URL`: BSC mainnet RPC URL (optional)

## Contract Overview

### PredictionMarket

On-chain prediction market with server-signed settlement. Supports multiple ERC-20 tokens for betting.

**Key Features:**
- Multi-token support via token registry
- Native ETH wrapping (auto-converts to WETH)
- EIP-712 signature verification for settlements
- Pausable for emergency stops
- Reentrancy protection

**Main Functions:**
- `createRound()`: Create a new prediction round (owner only)
- `placeBet()`: Place a bet on a round
- `settleRound()`: Settle a round with oracle signature
- `claimWinnings()`: Claim winnings after settlement
- `addSupportedToken()`: Add token to registry (owner only)

## Testing

The test suite covers:
- Contract deployment
- Round creation and management
- Betting with native ETH, WETH, and ERC20 tokens
- Settlement with EIP-712 signatures
- Winnings claims (win/loss/tie scenarios)
- Token management
- Pause/unpause functionality

## License

MIT

