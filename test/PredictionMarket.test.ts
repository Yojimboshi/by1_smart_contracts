import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { PredictionMarket, IWETH, IERC20 } from "../typechain-types";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("PredictionMarket", function () {
  // Helper function to create signature for settlement
  async function createSettlementSignature(
    predictionMarket: PredictionMarket,
    oracleSigner: SignerWithAddress,
    roundId: string,
    closePrice: bigint,
    outcome: number
  ): Promise<string> {
    const domain = {
      name: "PredictionMarket",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await predictionMarket.getAddress(),
    };

    const types = {
      Settlement: [
        { name: "roundId", type: "string" },
        { name: "closePrice", type: "uint256" },
        { name: "outcome", type: "uint8" },
        { name: "chainId", type: "uint256" },
        { name: "contractAddress", type: "address" },
        { name: "settledAt", type: "uint256" },
      ],
    };

    // Get current timestamp (will match block.timestamp when settleRound is called)
    const timestamp = await time.latest();
    const value = {
      roundId,
      closePrice,
      outcome,
      chainId: (await ethers.provider.getNetwork()).chainId,
      contractAddress: await predictionMarket.getAddress(),
      settledAt: timestamp,
    };

    return await oracleSigner.signTypedData(domain, types, value);
  }

  // Mock WETH contract for testing
  async function deployMockWETH() {
    const MockWETH = await ethers.getContractFactory("MockWETH");
    const weth = await MockWETH.deploy();
    return weth;
  }

  // Mock ERC20 token for testing
  async function deployMockERC20(name: string, symbol: string) {
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy(name, symbol);
    return token;
  }

  async function deployPredictionMarketFixture() {
    const [owner, oracleSigner, user1, user2, user3] = await ethers.getSigners();

    // Deploy mock WETH
    const weth = await deployMockWETH();

    // Deploy PredictionMarket
    const PredictionMarket = await ethers.getContractFactory("PredictionMarket");
    const predictionMarket = await PredictionMarket.deploy(
      await weth.getAddress(),
      oracleSigner.address
    );

    // Deploy mock ERC20 token
    const mockToken = await deployMockERC20("Test Token", "TEST");

    // Add mock token to supported tokens
    await predictionMarket.addSupportedToken(await mockToken.getAddress());

    return {
      predictionMarket,
      weth,
      mockToken,
      owner,
      oracleSigner,
      user1,
      user2,
      user3,
    };
  }

  describe("Deployment", function () {
    it("Should set the right owner and oracle signer", async function () {
      const { predictionMarket, owner, oracleSigner } = await loadFixture(
        deployPredictionMarketFixture
      );

      expect(await predictionMarket.owner()).to.equal(owner.address);
      expect(await predictionMarket.oracleSigner()).to.equal(oracleSigner.address);
    });

    it("Should have WETH as supported token by default", async function () {
      const { predictionMarket, weth } = await loadFixture(deployPredictionMarketFixture);

      expect(await predictionMarket.supportedTokens(await weth.getAddress())).to.be.true;
    });
  });

  describe("Round Management", function () {
    it("Should create a new round", async function () {
      const { predictionMarket, owner } = await loadFixture(deployPredictionMarketFixture);

      const roundId = "round-1";
      const symbol = "BTCUSDT";
      const startTime = (await time.latest()) + 100;
      const lockTime = startTime + 300;
      const endTime = lockTime + 300;

      await expect(
        predictionMarket.createRound(roundId, symbol, startTime, lockTime, endTime)
      )
        .to.emit(predictionMarket, "RoundCreated")
        .withArgs(roundId, symbol, startTime, lockTime, endTime);

      const round = await predictionMarket.getRound(roundId);
      expect(round.roundId).to.equal(roundId);
      expect(round.symbol).to.equal(symbol);
      expect(round.status).to.equal(0); // OPEN
    });

    it("Should revert if round already exists", async function () {
      const { predictionMarket } = await loadFixture(deployPredictionMarketFixture);

      const roundId = "round-1";
      const symbol = "BTCUSDT";
      const startTime = (await time.latest()) + 100;
      const lockTime = startTime + 300;
      const endTime = lockTime + 300;

      await predictionMarket.createRound(roundId, symbol, startTime, lockTime, endTime);

      await expect(
        predictionMarket.createRound(roundId, symbol, startTime, lockTime, endTime)
      ).to.be.revertedWith("Round already exists");
    });

    it("Should revert if non-owner tries to create round", async function () {
      const { predictionMarket, user1 } = await loadFixture(deployPredictionMarketFixture);

      const roundId = "round-1";
      const symbol = "BTCUSDT";
      const startTime = (await time.latest()) + 100;
      const lockTime = startTime + 300;
      const endTime = lockTime + 300;

      await expect(
        predictionMarket
          .connect(user1)
          .createRound(roundId, symbol, startTime, lockTime, endTime)
      ).to.be.revertedWithCustomError(predictionMarket, "OwnableUnauthorizedAccount");
    });
  });

  describe("Betting", function () {
    async function createRoundFixture() {
      const fixture = await deployPredictionMarketFixture();
      const roundId = "round-1";
      const symbol = "BTCUSDT";
      const startTime = (await time.latest()) + 100;
      const lockTime = startTime + 300;
      const endTime = lockTime + 300;

      await fixture.predictionMarket.createRound(roundId, symbol, startTime, lockTime, endTime);

      return { ...fixture, roundId, startTime, lockTime, endTime };
    }

    it("Should place bet with native ETH (auto-wrapped to WETH)", async function () {
      const { predictionMarket, weth, user1, roundId } = await loadFixture(createRoundFixture);

      const betAmount = ethers.parseEther("1.0");

      await expect(
        predictionMarket.connect(user1).placeBet(roundId, true, 0, await weth.getAddress(), {
          value: betAmount,
        })
      )
        .to.emit(predictionMarket, "BetPlaced")
        .withArgs(roundId, user1.address, true, betAmount, await weth.getAddress());

      const bet = await predictionMarket.getUserBet(roundId, user1.address);
      expect(bet.amount).to.equal(betAmount);
      expect(bet.isUp).to.be.true;
      expect(bet.token).to.equal(await weth.getAddress());
    });

    it("Should place bet with WETH directly", async function () {
      const { predictionMarket, weth, user1, roundId } = await loadFixture(createRoundFixture);

      const betAmount = ethers.parseEther("1.0");

      // Mint WETH for user
      await weth.connect(user1).deposit({ value: betAmount });
      await weth.connect(user1).approve(await predictionMarket.getAddress(), betAmount);

      await expect(
        predictionMarket.connect(user1).placeBet(roundId, false, betAmount, await weth.getAddress())
      )
        .to.emit(predictionMarket, "BetPlaced")
        .withArgs(roundId, user1.address, false, betAmount, await weth.getAddress());

      const bet = await predictionMarket.getUserBet(roundId, user1.address);
      expect(bet.amount).to.equal(betAmount);
      expect(bet.isUp).to.be.false;
    });

    it("Should place bet with ERC20 token", async function () {
      const { predictionMarket, mockToken, user1, roundId } = await loadFixture(
        createRoundFixture
      );

      const betAmount = ethers.parseEther("100");

      // Mint tokens for user
      await mockToken.mint(user1.address, betAmount);
      await mockToken.connect(user1).approve(await predictionMarket.getAddress(), betAmount);

      await expect(
        predictionMarket.connect(user1).placeBet(roundId, true, betAmount, await mockToken.getAddress())
      )
        .to.emit(predictionMarket, "BetPlaced")
        .withArgs(roundId, user1.address, true, betAmount, await mockToken.getAddress());

      const bet = await predictionMarket.getUserBet(roundId, user1.address);
      expect(bet.amount).to.equal(betAmount);
      expect(bet.token).to.equal(await mockToken.getAddress());
    });

    it("Should allow multiple bets from same user (same token)", async function () {
      const { predictionMarket, weth, user1, roundId } = await loadFixture(createRoundFixture);

      const betAmount1 = ethers.parseEther("1.0");
      const betAmount2 = ethers.parseEther("0.5");

      await predictionMarket.connect(user1).placeBet(roundId, true, 0, await weth.getAddress(), {
        value: betAmount1,
      });

      await predictionMarket.connect(user1).placeBet(roundId, true, 0, await weth.getAddress(), {
        value: betAmount2,
      });

      const bet = await predictionMarket.getUserBet(roundId, user1.address);
      expect(bet.amount).to.equal(betAmount1 + betAmount2);
    });

    it("Should revert if user tries to bet with different token", async function () {
      const { predictionMarket, weth, mockToken, user1, roundId } = await loadFixture(
        createRoundFixture
      );

      const betAmount = ethers.parseEther("1.0");

      // First bet with WETH
      await predictionMarket.connect(user1).placeBet(roundId, true, 0, await weth.getAddress(), {
        value: betAmount,
      });

      // Try to bet with different token
      await mockToken.mint(user1.address, betAmount);
      await mockToken.connect(user1).approve(await predictionMarket.getAddress(), betAmount);

      await expect(
        predictionMarket.connect(user1).placeBet(roundId, true, betAmount, await mockToken.getAddress())
      ).to.be.revertedWithCustomError(predictionMarket, "TokenMismatch");
    });

    it("Should revert if round is locked", async function () {
      const { predictionMarket, weth, user1, roundId, lockTime } = await loadFixture(
        createRoundFixture
      );

      // Move time past lock time
      await time.increaseTo(lockTime + 1n);

      await expect(
        predictionMarket.connect(user1).placeBet(roundId, true, 0, await weth.getAddress(), {
          value: ethers.parseEther("1.0"),
        })
      ).to.be.revertedWithCustomError(predictionMarket, "RoundNotOpen");
    });

    it("Should revert if token not supported", async function () {
      const { predictionMarket, user1, roundId } = await loadFixture(createRoundFixture);

      const unsupportedToken = ethers.Wallet.createRandom().address;

      await expect(
        predictionMarket.connect(user1).placeBet(roundId, true, ethers.parseEther("1.0"), unsupportedToken)
      ).to.be.revertedWithCustomError(predictionMarket, "TokenNotSupported");
    });
  });

  describe("Settlement", function () {
    async function createRoundWithBetsFixture() {
      const fixture = await deployPredictionMarketFixture();
      const roundId = "round-1";
      const symbol = "BTCUSDT";
      const startTime = (await time.latest()) + 100;
      const lockTime = startTime + 300;
      const endTime = lockTime + 300;

      await fixture.predictionMarket.createRound(roundId, symbol, startTime, lockTime, endTime);

      // Place bets
      const betAmount = ethers.parseEther("1.0");
      await fixture.predictionMarket
        .connect(fixture.user1)
        .placeBet(roundId, true, 0, await fixture.weth.getAddress(), { value: betAmount });
      await fixture.predictionMarket
        .connect(fixture.user2)
        .placeBet(roundId, false, 0, await fixture.weth.getAddress(), { value: betAmount });

      // Move time past lock time
      await time.increaseTo(lockTime + 1n);

      return { ...fixture, roundId, lockTime };
    }

    it("Should settle round with valid signature", async function () {
      const { predictionMarket, oracleSigner, roundId } = await loadFixture(
        createRoundWithBetsFixture
      );

      const closePrice = ethers.parseEther("50000");
      const outcome = 1; // UP

      // Create signature right before settlement to ensure timestamp matches
      const signature = await createSettlementSignature(
        predictionMarket,
        oracleSigner,
        roundId,
        closePrice,
        outcome
      );

      await expect(predictionMarket.settleRound(roundId, closePrice, outcome, signature))
        .to.emit(predictionMarket, "RoundSettled")
        .withArgs(roundId, closePrice, outcome);

      const round = await predictionMarket.getRound(roundId);
      expect(round.settled).to.be.true;
      expect(round.outcome).to.equal(outcome);
      expect(round.closePrice).to.equal(closePrice);
    });

    it("Should revert with invalid signature", async function () {
      const { predictionMarket, user1, roundId } = await loadFixture(createRoundWithBetsFixture);

      const closePrice = ethers.parseEther("50000");
      const outcome = 1;
      const invalidSignature = "0x" + "00".repeat(65);

      await expect(
        predictionMarket.settleRound(roundId, closePrice, outcome, invalidSignature)
      ).to.be.revertedWithCustomError(predictionMarket, "InvalidSignature");
    });

    it("Should revert if round already settled", async function () {
      const { predictionMarket, oracleSigner, roundId } = await loadFixture(
        createRoundWithBetsFixture
      );

      const closePrice = ethers.parseEther("50000");
      const outcome = 1;

      // Create and submit signature
      const signature = await createSettlementSignature(
        predictionMarket,
        oracleSigner,
        roundId,
        closePrice,
        outcome
      );
      await predictionMarket.settleRound(roundId, closePrice, outcome, signature);

      // Try to settle again
      const signature2 = await createSettlementSignature(
        predictionMarket,
        oracleSigner,
        roundId,
        closePrice,
        outcome
      );
      await expect(
        predictionMarket.settleRound(roundId, closePrice, outcome, signature2)
      ).to.be.revertedWithCustomError(predictionMarket, "RoundAlreadySettled");
    });
  });

  describe("Claiming Winnings", function () {
    async function createSettledRoundFixture() {
      const fixture = await deployPredictionMarketFixture();
      const roundId = "round-1";
      const symbol = "BTCUSDT";
      const startTime = (await time.latest()) + 100;
      const lockTime = startTime + 300;
      const endTime = lockTime + 300;

      await fixture.predictionMarket.createRound(roundId, symbol, startTime, lockTime, endTime);

      // Place bets
      const betAmount = ethers.parseEther("1.0");
      await fixture.predictionMarket
        .connect(fixture.user1)
        .placeBet(roundId, true, 0, await fixture.weth.getAddress(), { value: betAmount });
      await fixture.predictionMarket
        .connect(fixture.user2)
        .placeBet(roundId, false, 0, await fixture.weth.getAddress(), { value: betAmount });

      // Move time past lock time and settle
      await time.increaseTo(lockTime + 1n);

      const closePrice = ethers.parseEther("50000");
      const outcome = 1; // UP

      const signature = await createSettlementSignature(
        fixture.predictionMarket,
        fixture.oracleSigner,
        roundId,
        closePrice,
        outcome
      );
      await fixture.predictionMarket.settleRound(roundId, closePrice, outcome, signature);

      return { ...fixture, roundId, betAmount };
    }

    it("Should claim winnings for winning bet (2x payout)", async function () {
      const { predictionMarket, weth, user1, roundId, betAmount } = await loadFixture(
        createSettledRoundFixture
      );

      const initialBalance = await weth.balanceOf(user1.address);

      await expect(predictionMarket.connect(user1).claimWinnings(roundId))
        .to.emit(predictionMarket, "WinningsClaimed")
        .withArgs(roundId, user1.address, betAmount * 2n, await weth.getAddress());

      const finalBalance = await weth.balanceOf(user1.address);
      expect(finalBalance - initialBalance).to.equal(betAmount * 2n);

      const bet = await predictionMarket.getUserBet(roundId, user1.address);
      expect(bet.claimed).to.be.true;
    });

    it("Should revert if user tries to claim losing bet", async function () {
      const { predictionMarket, user2, roundId } = await loadFixture(createSettledRoundFixture);

      // user2 bet DOWN, outcome is UP, so they lose
      await expect(
        predictionMarket.connect(user2).claimWinnings(roundId)
      ).to.be.revertedWithCustomError(predictionMarket, "NoWinnings");
    });

    it("Should refund bet amount on TIE", async function () {
      const fixture = await deployPredictionMarketFixture();
      const roundId = "round-tie";
      const symbol = "BTCUSDT";
      const startTime = (await time.latest()) + 100;
      const lockTime = startTime + 300;
      const endTime = lockTime + 300;

      await fixture.predictionMarket.createRound(roundId, symbol, startTime, lockTime, endTime);

      const betAmount = ethers.parseEther("1.0");
      await fixture.predictionMarket
        .connect(fixture.user1)
        .placeBet(roundId, true, 0, await fixture.weth.getAddress(), { value: betAmount });

      await time.increaseTo(lockTime + 1n);

      // Settle as TIE
      const closePrice = ethers.parseEther("50000");
      const outcome = 0; // TIE

      const signature = await createSettlementSignature(
        fixture.predictionMarket,
        fixture.oracleSigner,
        roundId,
        closePrice,
        outcome
      );
      await fixture.predictionMarket.settleRound(roundId, closePrice, outcome, signature);

      const initialBalance = await fixture.weth.balanceOf(fixture.user1.address);
      await fixture.predictionMarket.connect(fixture.user1).claimWinnings(roundId);
      const finalBalance = await fixture.weth.balanceOf(fixture.user1.address);

      expect(finalBalance - initialBalance).to.equal(betAmount);
    });

    it("Should revert if already claimed", async function () {
      const { predictionMarket, user1, roundId } = await loadFixture(createSettledRoundFixture);

      await predictionMarket.connect(user1).claimWinnings(roundId);

      await expect(
        predictionMarket.connect(user1).claimWinnings(roundId)
      ).to.be.revertedWithCustomError(predictionMarket, "AlreadyClaimed");
    });
  });

  describe("Token Management", function () {
    it("Should add supported token", async function () {
      const { predictionMarket, mockToken, owner } = await loadFixture(
        deployPredictionMarketFixture
      );

      const tokenAddress = await mockToken.getAddress();
      await expect(predictionMarket.addSupportedToken(tokenAddress))
        .to.emit(predictionMarket, "TokenAdded")
        .withArgs(tokenAddress);

      expect(await predictionMarket.supportedTokens(tokenAddress)).to.be.true;
    });

    it("Should remove supported token", async function () {
      const { predictionMarket, mockToken, owner } = await loadFixture(
        deployPredictionMarketFixture
      );

      const tokenAddress = await mockToken.getAddress();
      await predictionMarket.addSupportedToken(tokenAddress);
      await predictionMarket.removeSupportedToken(tokenAddress);

      expect(await predictionMarket.supportedTokens(tokenAddress)).to.be.false;
    });

    it("Should revert if trying to remove WETH", async function () {
      const { predictionMarket, weth, owner } = await loadFixture(deployPredictionMarketFixture);

      await expect(
        predictionMarket.removeSupportedToken(await weth.getAddress())
      ).to.be.revertedWith("Cannot remove WETH");
    });
  });

  describe("Pause/Unpause", function () {
    it("Should pause contract", async function () {
      const { predictionMarket, owner } = await loadFixture(deployPredictionMarketFixture);

      await predictionMarket.pause();
      expect(await predictionMarket.paused()).to.be.true;
    });

    it("Should prevent betting when paused", async function () {
      const { predictionMarket, weth, user1 } = await loadFixture(deployPredictionMarketFixture);

      const roundId = "round-1";
      const symbol = "BTCUSDT";
      const startTime = (await time.latest()) + 100;
      const lockTime = startTime + 300;
      const endTime = lockTime + 300;

      await predictionMarket.createRound(roundId, symbol, startTime, lockTime, endTime);
      await predictionMarket.pause();

      await expect(
        predictionMarket.connect(user1).placeBet(roundId, true, 0, await weth.getAddress(), {
          value: ethers.parseEther("1.0"),
        })
      ).to.be.revertedWithCustomError(predictionMarket, "EnforcedPause");
    });
  });
});

