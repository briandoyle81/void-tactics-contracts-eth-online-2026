// One-off (2026-09-24): grants the soulbound Shattered Hive campaign medal
// (the NFT VariantPurchaseGate requires for variant-2 ship purchases) to a
// hardcoded list of addresses via ShatteredHiveMedal.ownerMint, bypassing
// the campaign-completion check on claimMedal.
//
// The medal is owned by MAP_EDITOR on this deployment (transferred in
// DeployAndConfig.ts's PRODUCTION ownership-handover block), so this must
// be signed by MAP_EDITOR, not the deployer wallet base-sepolia's
// hardhat.config.ts network entry defaults to (METAMASK_WALLET_1). Follows
// the exact key-resolution pattern scripts/disableClaimEligibility.ts
// already uses for the same owner: try MAP_EDITOR_KEY, then
// SHIP_MINTER_PRIVATE_KEY, sign automatically if one matches; otherwise
// print the calldata for manual submission instead of attempting a doomed
// transaction.
//
// Run with: npx hardhat run scripts/grantShatteredHiveMedal.ts --network base-sepolia
//
// Configuration via environment variables:
//   SHATTERED_HIVE_MEDAL_ADDRESS  Defaults to deployed_addresses.json.
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

const RECIPIENTS: `0x${string}`[] = [
  "0x8DDaC6B68dE3c829bc792c06764A9f7af6b99c46",
  "0x726559ecF4e1868EB406B5D32D9Ee76EA8234Fc8",
];

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
      console.log(
        `${envName} matches MAP_EDITOR (${expectedOwner}) -- will sign automatically.`,
      );
      return client;
    }
  }
  console.warn(
    `WARNING: neither MAP_EDITOR_KEY nor SHIP_MINTER_PRIVATE_KEY matches ` +
      `MAP_EDITOR (${expectedOwner}) -- calls will be printed for manual submission instead.`,
  );
  return undefined;
}

async function grantOne(
  medalAddress: `0x${string}`,
  abi: any,
  recipient: `0x${string}`,
  owner: `0x${string}`,
  ownerClient: ReturnType<typeof buildClientFromKey> | undefined,
) {
  const publicClient = await hre.viem.getPublicClient();
  const to = getAddress(recipient);

  console.log(`\n--- ownerMint(${to}) ---`);

  const balance = (await publicClient.readContract({
    address: medalAddress,
    abi,
    functionName: "balanceOf",
    args: [to],
  })) as bigint;

  if (balance > 0n) {
    console.log("Already holds a medal -- skip.");
    return;
  }

  if (!ownerClient) {
    const calldata = encodeFunctionData({
      abi,
      functionName: "ownerMint",
      args: [to],
    });
    console.log(`Manual step -- send this from the owner wallet (${owner}):`);
    console.log(`  to:   ${medalAddress}`);
    console.log(`  data: ${calldata}`);
    return;
  }

  const { request } = await publicClient.simulateContract({
    address: medalAddress,
    abi,
    functionName: "ownerMint",
    args: [to],
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
  // scripts/disableClaimEligibility.ts already works around).
  let after = 0n;
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    after = (await publicClient.readContract({
      address: medalAddress,
      abi,
      functionName: "balanceOf",
      args: [to],
      blockTag: "latest",
    })) as bigint;
    if (after > 0n) break;
  }

  if (after > 0n) {
    console.log(`OK: ${to} now holds a Shattered Hive medal.`);
  } else {
    console.warn(
      `WARNING: read-back still shows balanceOf(${to}) == 0. The tx ` +
        `(${hash}) was mined successfully, so this is most likely RPC replica ` +
        `lag -- verify directly before assuming it failed.`,
    );
  }
}

async function main() {
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  console.log("chainId:", chainId, "MAP_EDITOR:", MAP_EDITOR);

  const medalAddress = resolveAddress(
    chainId,
    "SHATTERED_HIVE_MEDAL_ADDRESS",
    "DeployModule#ShatteredHiveMedal",
  );
  const abi = (await hre.artifacts.readArtifact("ShatteredHiveMedal")).abi as any;

  console.log(`\n--- ShatteredHiveMedal (${medalAddress}) ---`);

  const owner = (await publicClient.readContract({
    address: medalAddress,
    abi,
    functionName: "owner",
    args: [],
  })) as `0x${string}`;
  console.log("owner:", owner);

  const ownerClient = resolveOwnerClient(getAddress(owner));

  for (const recipient of RECIPIENTS) {
    await grantOne(medalAddress, abi, recipient, getAddress(owner), ownerClient);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
