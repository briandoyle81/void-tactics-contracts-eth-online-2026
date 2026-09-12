// Mines a CREATE2 salt that deploys a Uniswap v4 hook to an address whose
// low 14 bits match its declared permission flags — required because
// BaseHook's constructor (see @uniswap/v4-periphery/src/utils/BaseHook.sol)
// rejects any address that doesn't. Reimplements the same algorithm as
// Uniswap's own Solidity `HookMiner` library
// (@uniswap/v4-periphery/src/utils/HookMiner.sol) in TypeScript, since this
// repo is Hardhat/viem-based rather than Foundry and has no equivalent
// on-chain-cheatcode shortcut for it.
//
// Usable against either a locally-controlled `Create2Deployer.sol` instance
// (see that file's own header — needed on Hardhat's local network, which
// doesn't pre-seed the canonical deployer proxy) or, for a real deploy, the
// canonical 0x4e59b44847b379578588920cA78FbF26c0B4956C deterministic
// deployment proxy already present on most real networks — this module only
// needs a deployer *address* and doesn't care which kind it is, as long as
// mining and the actual deployment both target the same one.

import { encodeDeployData, encodePacked, keccak256, getAddress } from "viem";
import type { Abi, Hex } from "viem";

const FLAG_MASK = 0x3fffn; // low 14 bits, matches Hooks.ALL_HOOK_MASK
const MAX_LOOP = 160_444; // matches Uniswap's own HookMiner bound

export interface MineHookAddressParams {
  deployer: `0x${string}`;
  flags: bigint;
  abi: Abi;
  bytecode: Hex;
  constructorArgs: readonly unknown[];
}

export interface MinedHook {
  hookAddress: `0x${string}`;
  salt: `0x${string}`;
  initCode: Hex;
}

function computeCreate2Address(
  deployer: `0x${string}`,
  salt: bigint,
  initCodeHash: `0x${string}`,
): `0x${string}` {
  const saltHex = `0x${salt.toString(16).padStart(64, "0")}` as `0x${string}`;
  const packed = encodePacked(
    ["bytes1", "address", "bytes32", "bytes32"],
    ["0xff", deployer, saltHex, initCodeHash],
  );
  const hash = keccak256(packed);
  return getAddress(`0x${hash.slice(-40)}`);
}

/**
 * Finds a salt such that CREATE2-deploying `bytecode` (with `constructorArgs`
 * appended, ABI-encoded) from `deployer` produces an address whose low 14
 * bits exactly equal `flags`. Mirrors @uniswap/v4-periphery's HookMiner.find.
 */
export function mineHookAddress({
  deployer,
  flags,
  abi,
  bytecode,
  constructorArgs,
}: MineHookAddressParams): MinedHook {
  const initCode = encodeDeployData({
    abi,
    bytecode,
    args: constructorArgs,
  });
  const initCodeHash = keccak256(initCode);
  const wantedFlags = flags & FLAG_MASK;

  for (let salt = 0n; salt < BigInt(MAX_LOOP); salt++) {
    const candidate = computeCreate2Address(deployer, salt, initCodeHash);
    const candidateFlags = BigInt(candidate) & FLAG_MASK;
    if (candidateFlags === wantedFlags) {
      return {
        hookAddress: candidate,
        salt: `0x${salt.toString(16).padStart(64, "0")}` as `0x${string}`,
        initCode,
      };
    }
  }

  throw new Error(
    `hookMiner: could not find a salt matching flags 0x${wantedFlags.toString(16)} within ${MAX_LOOP} attempts`,
  );
}

// Hooks.sol's flag bit positions (contracts/UTCLotteryHook.sol only sets
// beforeInitialize + afterSwap — see getHookPermissions()).
export const HOOK_FLAGS = {
  BEFORE_INITIALIZE: 1n << 13n,
  AFTER_INITIALIZE: 1n << 12n,
  BEFORE_ADD_LIQUIDITY: 1n << 11n,
  AFTER_ADD_LIQUIDITY: 1n << 10n,
  BEFORE_REMOVE_LIQUIDITY: 1n << 9n,
  AFTER_REMOVE_LIQUIDITY: 1n << 8n,
  BEFORE_SWAP: 1n << 7n,
  AFTER_SWAP: 1n << 6n,
  BEFORE_DONATE: 1n << 5n,
  AFTER_DONATE: 1n << 4n,
  BEFORE_SWAP_RETURNS_DELTA: 1n << 3n,
  AFTER_SWAP_RETURNS_DELTA: 1n << 2n,
  AFTER_ADD_LIQUIDITY_RETURNS_DELTA: 1n << 1n,
  AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA: 1n << 0n,
} as const;
