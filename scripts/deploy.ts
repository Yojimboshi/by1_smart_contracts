import { ethers } from "hardhat";

async function main() {
  // Get deployer account
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  console.log("Account balance:", (await ethers.provider.getBalance(deployer.address)).toString());

  // Get WBNB address for BSC testnet or from env
  let wbnbAddress = process.env.WBNB_ADDRESS;

  // BSC Testnet WBNB address
  const BSC_TESTNET_WBNB = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";

  if (!wbnbAddress) {
    // Check if we're on BSC testnet
    const network = await ethers.provider.getNetwork();
    if (network.chainId === 97n) {
      wbnbAddress = BSC_TESTNET_WBNB;
      console.log("Using BSC Testnet WBNB address:", wbnbAddress);
    } else {
      console.log("WBNB address not provided, deploying MockWETH for testing...");
      const MockWETH = await ethers.getContractFactory("MockWETH");
      const mockWETH = await MockWETH.deploy();
      await mockWETH.waitForDeployment();
      wbnbAddress = await mockWETH.getAddress();
      console.log("MockWETH deployed to:", wbnbAddress);
    }
  }
  console.log("Using WBNB address:", wbnbAddress);

  // Get oracle signer address from env (or use deployer for testing)
  const oracleSigner = process.env.ORACLE_SIGNER_ADDRESS || deployer.address;
  console.log("Oracle signer address:", oracleSigner);

  // Deploy PredictionMarket contract
  const PredictionMarket = await ethers.getContractFactory("PredictionMarket");
  const predictionMarket = await PredictionMarket.deploy(wbnbAddress, oracleSigner);

  await predictionMarket.waitForDeployment();
  const address = await predictionMarket.getAddress();

  console.log("PredictionMarket deployed to:", address);
  console.log("WBNB address:", wbnbAddress);
  console.log("Oracle signer:", oracleSigner);

  // Verify deployment
  const roundCount = await predictionMarket.owner();
  console.log("Contract owner:", roundCount);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

