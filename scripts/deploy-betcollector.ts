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

    // Settlement signer: address that signs settlement data (from BET_COLLECTOR_SETTLEMENT_SIGNER_PRIVATE_KEY or deployer)
    const settlementSigner = process.env.BET_COLLECTOR_SETTLEMENT_SIGNER_ADDRESS || deployer.address;
    console.log("Settlement signer:", settlementSigner);

    // Deploy BetCollector contract
    const BetCollector = await ethers.getContractFactory("BetCollector");
    const betCollector = await BetCollector.deploy(wbnbAddress, settlementSigner);

    await betCollector.waitForDeployment();
    const address = await betCollector.getAddress();

    console.log("BetCollector deployed to:", address);
    console.log("WBNB address:", wbnbAddress);

    // Verify deployment by checking owner, WETH, and settlement signer
    const owner = await betCollector.owner();
    const weth = await betCollector.weth();
    const signer = await betCollector.settlementSigner();
    console.log("Contract owner:", owner);
    console.log("Contract WETH:", weth);
    console.log("Settlement signer:", signer);

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
