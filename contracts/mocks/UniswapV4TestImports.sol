// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

// Forces Hardhat to compile Uniswap's own real v4-core PoolManager and its
// official PoolSwapTest/PoolModifyLiquidityTest test routers, so they get
// artifacts and are deployable from test/UTCLotteryHookSwap.test.ts — not
// otherwise imported by anything in this repo's own contracts. Nothing here
// is deployed from this file; it exists purely so Hardhat's compiler
// discovers these third-party contracts as compilation targets.
import "@uniswap/v4-core/src/PoolManager.sol";
import "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
