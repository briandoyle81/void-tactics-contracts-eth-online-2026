import fs from "fs";
import path from "path";
import hre from "hardhat";
import { getAddress, isAddress } from "viem";
import { MAP_EDITOR } from "../ignition/modules/DeployAndConfig";

// One-off fix (2026-09-22): FreeShipClaim and TutorialClaim were missing
// from DeployAndConfig.ts's ownership-handover block, so on an existing
// deployment both are still owned by the deployer wallet instead of
// MAP_EDITOR -- meaning the map admin can't toggle free-ship/tutorial
// eligibility gating (setEligibilityProvider) the way it controls
// everything else. This transfers both to MAP_EDITOR on an already-deployed
// set of contracts. The deploy module itself is fixed for future deploys;
// this script is only needed against contracts deployed before that fix.
//
// Run from the wallet that currently owns both contracts (the deployer):
//   npx hardhat run scripts/transferClaimContractsOwnership.ts --network base-sepolia
//   npx hardhat run scripts/transferClaimContractsOwnership.ts --network flow-testnet
//   npx hardhat run scripts/transferClaimContractsOwnership.ts --network ronin-saigon
//   npx hardhat run scripts/transferClaimContractsOwnership.ts --network xai-testnet
//
// Configuration via environment variables:
//   FREE_SHIP_CLAIM_ADDRESS  FreeShipClaim address. Defaults to reading
//                            ignition/deployments/chain-<id>/deployed_addresses.json.
//   TUTORIAL_CLAIM_ADDRESS   TutorialClaim address. Same default source.
//   NEW_OWNER                Address to transfer ownership to. Defaults to MAP_EDITOR.

function resolveAddress(
  chainId: number,
  envVar: string,
  deployKey: string
): `0x${string}` {
  const fromEnv = process.env[envVar];
  if (fromEnv) {
    if (!isAddress(fromEnv)) {
      throw new Error(`${envVar} is not a valid address: ${fromEnv}`);
    }
    return getAddress(fromEnv);
  }

  const addressesPath = path.join(
    __dirname,
    "..",
    "ignition",
    "deployments",
    `chain-${chainId}`,
    "deployed_addresses.json"
  );
  if (!fs.existsSync(addressesPath)) {
    throw new Error(
      `No ${envVar} provided and no deployment found at ${addressesPath}. ` +
        `Set ${envVar}=0x... to target an existing deployment.`
    );
  }
  const addresses = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
  const address = addresses[deployKey];
  if (!address) {
    throw new Error(`${deployKey} missing in ${addressesPath}`);
  }
  return getAddress(address);
}

async function transferOne(
  label: string,
  address: `0x${string}`,
  newOwner: `0x${string}`
) {
  const publicClient = await hre.viem.getPublicClient();
  const [wallet] = await hre.viem.getWalletClients();
  const abi = (await hre.artifacts.readArtifact(label)).abi as any;

  console.log(`\n--- ${label} (${address}) ---`);

  const currentOwner = (await publicClient.readContract({
    address,
    abi,
    functionName: "owner",
    args: [],
  })) as `0x${string}`;

  if (getAddress(currentOwner) === getAddress(newOwner)) {
    console.log(`Already owned by ${newOwner}; nothing to do.`);
    return;
  }

  if (getAddress(currentOwner) !== getAddress(wallet.account.address)) {
    console.warn(
      `WARNING: sender ${wallet.account.address} is not ${label}'s owner ` +
        `(${currentOwner}). The transaction will revert unless you control ` +
        "the owner wallet."
    );
  }

  const { request } = await publicClient.simulateContract({
    address,
    abi,
    functionName: "transferOwnership",
    args: [newOwner],
    account: wallet.account,
  });
  const hash = await wallet.writeContract(request);
  console.log("Submitted tx:", hash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("Mined in block:", receipt.blockNumber, "status:", receipt.status);
  if (receipt.status !== "success") {
    throw new Error(`Transaction reverted: ${hash}`);
  }

  // Public RPC endpoints are often load-balanced, so an immediate read can
  // hit a replica that hasn't caught up to the receipt's block yet -- see
  // scripts/deployUTCLotteryPool.ts's own owner() read for the same issue.
  // Retry a few times before downgrading a persistent mismatch to a warning.
  let after: `0x${string}` = currentOwner;
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    after = (await publicClient.readContract({
      address,
      abi,
      functionName: "owner",
      args: [],
      blockTag: "latest",
    })) as `0x${string}`;
    if (getAddress(after) === getAddress(newOwner)) break;
  }

  if (getAddress(after) === getAddress(newOwner)) {
    console.log(`OK: owner() == ${after}`);
  } else {
    console.warn(
      `WARNING: read-back still shows owner() == ${after}, expected ${newOwner}. ` +
        `The tx (${hash}) was mined successfully, so this is most likely RPC ` +
        `replica lag. Verify directly, e.g.:\n` +
        `  cast call ${address} "owner()(address)" --rpc-url <rpc>`
    );
  }
}

async function main() {
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const newOwnerRaw = process.env.NEW_OWNER || MAP_EDITOR;
  if (!isAddress(newOwnerRaw)) {
    throw new Error(`NEW_OWNER is not a valid address: ${newOwnerRaw}`);
  }
  const newOwner = getAddress(newOwnerRaw);

  const freeShipClaimAddress = resolveAddress(
    chainId,
    "FREE_SHIP_CLAIM_ADDRESS",
    "DeployModule#FreeShipClaim"
  );
  const tutorialClaimAddress = resolveAddress(
    chainId,
    "TUTORIAL_CLAIM_ADDRESS",
    "DeployModule#TutorialClaim"
  );

  console.log("chainId:", chainId, "newOwner:", newOwner);

  await transferOne("FreeShipClaim", freeShipClaimAddress, newOwner);
  await transferOne("TutorialClaim", tutorialClaimAddress, newOwner);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
