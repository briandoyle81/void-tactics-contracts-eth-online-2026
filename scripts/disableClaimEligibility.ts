// One-off (2026-09-24): turns off eligibility verification for
// FreeShipClaim.claimFreeShips and TutorialClaim's completion functions on
// an already-deployed set of contracts, per docs/frontend-handoff-
// attributes-costs-and-ai-2026-09-21.md §10 -- address(0) means "no
// verification at all," which is the intended effect here.
//
// Both contracts are owned by MAP_EDITOR on this deployment (confirmed via
// scripts/checkClaimContractsOwner.ts), so this must be signed by MAP_EDITOR,
// not the deployer wallet base-sepolia's hardhat.config.ts network entry
// defaults to (METAMASK_WALLET_1). Follows the exact key-resolution pattern
// scripts/deployUTCLotteryPool.ts already uses for the same owner: try
// MAP_EDITOR_KEY, then SHIP_MINTER_PRIVATE_KEY, sign automatically if one
// matches; otherwise print the calldata for manual submission instead of
// attempting a doomed transaction.
//
// Run with: npx hardhat run scripts/disableClaimEligibility.ts --network base-sepolia
//
// Configuration via environment variables:
//   FREE_SHIP_CLAIM_ADDRESS  Defaults to deployed_addresses.json.
//   TUTORIAL_CLAIM_ADDRESS   Defaults to deployed_addresses.json.
//   MAP_EDITOR_KEY / SHIP_MINTER_PRIVATE_KEY  Owner's private key.

import fs from "fs";
import path from "path";
import hre from "hardhat";
import {
  createWalletClient,
  http,
  getAddress,
  isAddress,
  encodeFunctionData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { MAP_EDITOR } from "../ignition/modules/DeployAndConfig";

function resolveAddress(
  chainId: number,
  envVar: string,
  deployKey: string,
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
    "deployed_addresses.json",
  );
  const addresses = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
  const address = addresses[deployKey];
  if (!address) throw new Error(`${deployKey} missing in ${addressesPath}`);
  return getAddress(address);
}

function buildClientFromKey(rawKey: string) {
  const pk = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;
  const account = privateKeyToAccount(pk);
  return createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org"),
  });
}

function resolveOwnerClient(expectedOwner: `0x${string}`) {
  const candidates: Array<[string, string | undefined]> = [
    ["MAP_EDITOR_KEY", process.env.MAP_EDITOR_KEY],
    ["SHIP_MINTER_PRIVATE_KEY", process.env.SHIP_MINTER_PRIVATE_KEY],
  ];
  for (const [envName, rawKey] of candidates) {
    if (!rawKey) continue;
    const client = buildClientFromKey(rawKey);
    if (getAddress(client.account!.address) === expectedOwner) {
      console.log(`${envName} matches MAP_EDITOR (${expectedOwner}) -- will sign automatically.`);
      return client;
    }
  }
  console.warn(
    `WARNING: neither MAP_EDITOR_KEY nor SHIP_MINTER_PRIVATE_KEY matches ` +
      `MAP_EDITOR (${expectedOwner}) -- calls will be printed for manual submission instead.`,
  );
  return undefined;
}

async function disableOne(label: string, address: `0x${string}`) {
  const publicClient = await hre.viem.getPublicClient();
  const abi = (await hre.artifacts.readArtifact(label)).abi as any;

  console.log(`\n--- ${label} (${address}) ---`);

  const owner = (await publicClient.readContract({
    address,
    abi,
    functionName: "owner",
    args: [],
  })) as `0x${string}`;

  const currentProvider = (await publicClient.readContract({
    address,
    abi,
    functionName: "eligibilityProvider",
    args: [],
  })) as `0x${string}`;

  if (getAddress(currentProvider) === getAddress("0x0000000000000000000000000000000000000000")) {
    console.log("eligibilityProvider is already address(0) -- verification already off, nothing to do.");
    return;
  }
  console.log("current eligibilityProvider:", currentProvider);

  const ownerClient = resolveOwnerClient(getAddress(owner));
  if (!ownerClient) {
    const calldata = encodeFunctionData({
      abi,
      functionName: "setEligibilityProvider",
      args: ["0x0000000000000000000000000000000000000000"],
    });
    console.log(`Manual step -- send this from the owner wallet (${owner}):`);
    console.log(`  to:   ${address}`);
    console.log(`  data: ${calldata}`);
    return;
  }

  const { request } = await publicClient.simulateContract({
    address,
    abi,
    functionName: "setEligibilityProvider",
    args: ["0x0000000000000000000000000000000000000000"],
    account: ownerClient.account,
  });
  const hash = await ownerClient.writeContract(request);
  console.log("Submitted tx:", hash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("Mined in block:", receipt.blockNumber, "status:", receipt.status);
  if (receipt.status !== "success") {
    throw new Error(`Transaction reverted: ${hash}`);
  }

  // Public RPC endpoints are often load-balanced -- an immediate read can hit
  // a replica that hasn't caught up to the receipt's block yet (same issue
  // scripts/transferClaimContractsOwnership.ts already works around).
  let after: `0x${string}` = currentProvider;
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    after = (await publicClient.readContract({
      address,
      abi,
      functionName: "eligibilityProvider",
      args: [],
      blockTag: "latest",
    })) as `0x${string}`;
    if (getAddress(after) === getAddress("0x0000000000000000000000000000000000000000")) break;
  }

  if (getAddress(after) === getAddress("0x0000000000000000000000000000000000000000")) {
    console.log("OK: eligibilityProvider == address(0), verification is off.");
  } else {
    console.warn(
      `WARNING: read-back still shows eligibilityProvider == ${after}. The tx ` +
        `(${hash}) was mined successfully, so this is most likely RPC replica ` +
        `lag -- verify directly before assuming it failed.`,
    );
  }
}

async function main() {
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  console.log("chainId:", chainId, "MAP_EDITOR:", MAP_EDITOR);

  const freeShipClaimAddress = resolveAddress(chainId, "FREE_SHIP_CLAIM_ADDRESS", "DeployModule#FreeShipClaim");
  const tutorialClaimAddress = resolveAddress(chainId, "TUTORIAL_CLAIM_ADDRESS", "DeployModule#TutorialClaim");

  await disableOne("FreeShipClaim", freeShipClaimAddress);
  await disableOne("TutorialClaim", tutorialClaimAddress);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
