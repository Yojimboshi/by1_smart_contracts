import { ethers } from "hardhat";

async function main() {
  // Get deployer account
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  console.log("Account balance:", (await ethers.provider.getBalance(deployer.address)).toString());

  // Get WETH address from env (or deploy mock for testing)
  let wethAddress = process.env.WETH_ADDRESS;
  if (!wethAddress) {
    console.log("WETH address not provided, deploying MockWETH for testing...");
    const MockWETH = await ethers.getContractFactory("MockWETH");
    const mockWETH = await MockWETH.deploy();
    await mockWETH.waitForDeployment();
    wethAddress = await mockWETH.getAddress();
    console.log("MockWETH deployed to:", wethAddress);
  }
  console.log("Using WETH address:", wethAddress);

  // Get oracle signer address from env (or use deployer for testing)
  const oracleSigner = process.env.ORACLE_SIGNER_ADDRESS || deployer.address;
  console.log("Oracle signer address:", oracleSigner);

  // Deploy PredictionMarket contract
  const PredictionMarket = await ethers.getContractFactory("PredictionMarket");
  const predictionMarket = await PredictionMarket.deploy(wethAddress, oracleSigner);

  await predictionMarket.waitForDeployment();
  const address = await predictionMarket.getAddress();

  console.log("PredictionMarket deployed to:", address);
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

