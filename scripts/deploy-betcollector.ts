import { ethers } from "hardhat";

async function main() {
    // Get deployer account
    const [deployer] = await ethers.getSigners();
    console.log("Deploying BetCollector with account:", deployer.address);
    console.log("Account balance:", (await ethers.provider.getBalance(deployer.address)).toString());

    // Get WBNB address for BSC testnet
    const BSC_TESTNET_WBNB = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";
    const wbnbAddress = process.env.WBNB_ADDRESS || BSC_TESTNET_WBNB;

    console.log("Using WBNB address:", wbnbAddress);

    // Deploy BetCollector contract
    const BetCollector = await ethers.getContractFactory("BetCollector");
    const betCollector = await BetCollector.deploy(wbnbAddress);

    await betCollector.waitForDeployment();
    const address = await betCollector.getAddress();

    console.log("BetCollector deployed to:", address);
    console.log("WBNB address:", wbnbAddress);

    // Verify deployment by checking owner and WETH address
    const owner = await betCollector.owner();
    const weth = await betCollector.weth();
    console.log("Contract owner:", owner);
    console.log("Contract WETH:", weth);

    // Check if WBNB is supported
    const isWbnbSupported = await betCollector.supportedTokens(wbnbAddress);
    console.log("WBNB supported:", isWbnbSupported);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
