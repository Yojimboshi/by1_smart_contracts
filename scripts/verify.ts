import { run } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
    const contractAddress = process.env.CONTRACT_ADDRESS;
    const wbnbAddress = process.env.WBNB_ADDRESS;
    const oracleSigner = process.env.ORACLE_SIGNER_ADDRESS;

    if (!contractAddress || !wbnbAddress || !oracleSigner) {
        throw new Error(
            "Missing required environment variables: CONTRACT_ADDRESS, WBNB_ADDRESS, ORACLE_SIGNER_ADDRESS"
        );
    }

    console.log("Verifying contract on BSCScan...");

    try {
        await run("verify:verify", {
            address: contractAddress,
            constructorArguments: [wbnbAddress, oracleSigner],
            network: "bscTestnet",
        });
        console.log("✅ Contract verified successfully!");
    } catch (error: any) {
        if (error.message.toLowerCase().includes("already verified")) {
            console.log("✅ Contract is already verified!");
        } else {
            console.error("❌ Verification failed:", error.message);
        }
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
