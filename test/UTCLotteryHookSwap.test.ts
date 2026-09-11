import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { getAddress, parseEther, zeroAddress, encodeAbiParameters } from "viem";
import DeployModule from "../ignition/modules/DeployAndConfig";
import { mineHookAddress, HOOK_FLAGS } from "../scripts/hookMiner";

// Real-swap integration test: a genuine Uniswap v4 PoolManager, the real
// official PoolSwapTest/PoolModifyLiquidityTest routers (from
// @uniswap/v4-core's own src/test), and UTCLotteryHook attached to an actual
// UTC/native pool — not a mocked/hand-rolled stand-in for any of it. Proves
// the hook's afterSwap logic fires correctly from a real swap, not just
// from directly calling internal-shaped test hooks.

const FEE = 3000; // 0.3%, standard tier
const TICK_SPACING = 60;
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const MIN_USABLE_TICK = Math.trunc(MIN_TICK / TICK_SPACING) * TICK_SPACING;
const MAX_USABLE_TICK = Math.trunc(MAX_TICK / TICK_SPACING) * TICK_SPACING;
const SQRT_PRICE_1_1 = 79228162514264337593543950336n; // 2^96, tick 0
const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

describe("UTCLotteryHook — real swap integration", function () {
  // The fixture runs the full DeployModule plus PoolManager/router/hook
  // setup — a lot of sequential transactions. The default 40s mocha timeout
  // isn't enough on a cold run, and — unlike an isolated single-file rerun —
  // an aborted first attempt here corrupts nonce tracking for every later
  // test in this same process, cascading into unrelated-looking failures.
  this.timeout(180_000);

  async function deployFixture() {
    const [deployerSigner, lp, trader] = await hre.viem.getWalletClients();
    const deployed = await hre.ignition.deploy(DeployModule);
    const ships = deployed.ships;
    const universalCredits = deployed.universalCredits;
    const randomManager = deployed.randomManager;

    const shipsOwnerAddress = getAddress(await ships.read.owner());
    const allClients = await hre.viem.getWalletClients();
    const ownerClient = allClients.find(
      (c) => getAddress(c.account.address) === shipsOwnerAddress,
    );
    if (!ownerClient) throw new Error("Could not resolve Ships owner");

    const shipsAsOwner = await hre.viem.getContractAt(
      "Ships",
      ships.address,
      { client: { wallet: ownerClient } },
    );
    const ucAsOwner = await hre.viem.getContractAt(
      "UniversalCredits",
      universalCredits.address,
      { client: { wallet: ownerClient } },
    );

    // Real v4 core: PoolManager + the official test routers, not mocks.
    const poolManager = await hre.viem.deployContract("PoolManager", [
      ownerClient.account.address,
    ]);
    const swapRouter = await hre.viem.deployContract("PoolSwapTest", [
      poolManager.address,
    ]);
    const liquidityRouter = await hre.viem.deployContract(
      "PoolModifyLiquidityTest",
      [poolManager.address],
    );
    const create2Deployer = await hre.viem.deployContract(
      "Create2Deployer",
      [],
    );

    const hookArtifact = await hre.artifacts.readArtifact("UTCLotteryHook");
    const flags = HOOK_FLAGS.BEFORE_INITIALIZE | HOOK_FLAGS.AFTER_SWAP;
    const { hookAddress, salt, initCode } = mineHookAddress({
      deployer: create2Deployer.address,
      flags,
      abi: hookArtifact.abi,
      bytecode: hookArtifact.bytecode as `0x${string}`,
      constructorArgs: [
        poolManager.address,
        ships.address,
        randomManager.address,
        universalCredits.address,
        ownerClient.account.address,
      ],
    });
    await create2Deployer.write.deploy([initCode, salt]);
    const hook = await hre.viem.getContractAt("UTCLotteryHook", hookAddress);
    const hookAsOwner = await hre.viem.getContractAt(
      "UTCLotteryHook",
      hookAddress,
      { client: { wallet: ownerClient } },
    );

    await shipsAsOwner.write.setIsAllowedToCreateShips([hookAddress, true]);

    // Fund LP + trader with real UTC, temporarily authorizing the owner to
    // mint it directly rather than routing through ShipPurchaser.
    await ucAsOwner.write.setAuthorizedToMint([ownerClient.account.address, true]);
    await ucAsOwner.write.mint([lp.account.address, parseEther("1000")]);
    await ucAsOwner.write.mint([trader.account.address, parseEther("1000")]);

    const ucAsLp = await hre.viem.getContractAt(
      "UniversalCredits",
      universalCredits.address,
      { client: { wallet: lp } },
    );
    const ucAsTrader = await hre.viem.getContractAt(
      "UniversalCredits",
      universalCredits.address,
      { client: { wallet: trader } },
    );
    await ucAsLp.write.approve([liquidityRouter.address, parseEther("1000")]);
    await ucAsTrader.write.approve([swapRouter.address, parseEther("1000")]);

    const key = {
      currency0: zeroAddress,
      currency1: getAddress(universalCredits.address),
      fee: FEE,
      tickSpacing: TICK_SPACING,
      hooks: getAddress(hookAddress),
    } as const;

    return {
      ownerClient,
      lp,
      trader,
      ships,
      universalCredits,
      randomManager,
      poolManager,
      swapRouter,
      liquidityRouter,
      hook,
      hookAsOwner,
      key,
    };
  }

  it("locks onto the pool on initialize", async function () {
    const { poolManager, key, hook } = await loadFixture(deployFixture);

    await poolManager.write.initialize([key, SQRT_PRICE_1_1]);

    expect(await hook.read.poolLocked()).to.equal(true);
  });

  it("records a qualifying sell from a real swap, crediting the trader named in hookData", async function () {
    const { poolManager, liquidityRouter, swapRouter, key, hook, lp, trader } =
      await loadFixture(deployFixture);

    await poolManager.write.initialize([key, SQRT_PRICE_1_1]);

    await liquidityRouter.write.modifyLiquidity(
      [
        key,
        {
          tickLower: MIN_USABLE_TICK,
          tickUpper: MAX_USABLE_TICK,
          liquidityDelta: parseEther("1"),
          salt: `0x${"0".repeat(64)}`,
        },
        "0x",
      ],
      { account: lp.account, value: parseEther("5") },
    );

    const hookData = encodeAbiParameters(
      [{ type: "address" }],
      [getAddress(trader.account.address)],
    );

    // zeroForOne = false: selling UTC (currency1) for native ETH
    // (currency0) — the direction the hook is supposed to record.
    await swapRouter.write.swap(
      [
        key,
        {
          zeroForOne: false,
          amountSpecified: -parseEther("10"),
          sqrtPriceLimitX96: MAX_SQRT_PRICE - 1n,
        },
        { takeClaims: false, settleUsingBurn: false },
        hookData,
      ],
      { account: trader.account },
    );

    expect(
      await hook.read.hasParticipated([0n, trader.account.address]),
    ).to.equal(true);
    const weight = await hook.read.weightInDraw([0n, trader.account.address]);
    expect(weight > 0n).to.equal(true);
    expect(await hook.read.totalWeightInDraw([0n])).to.equal(weight);
  });

  it("does not record a buy (native -> UTC)", async function () {
    const { poolManager, liquidityRouter, swapRouter, key, hook, lp, trader } =
      await loadFixture(deployFixture);

    await poolManager.write.initialize([key, SQRT_PRICE_1_1]);
    await liquidityRouter.write.modifyLiquidity(
      [
        key,
        {
          tickLower: MIN_USABLE_TICK,
          tickUpper: MAX_USABLE_TICK,
          liquidityDelta: parseEther("1"),
          salt: `0x${"0".repeat(64)}`,
        },
        "0x",
      ],
      { account: lp.account, value: parseEther("5") },
    );

    const hookData = encodeAbiParameters(
      [{ type: "address" }],
      [getAddress(trader.account.address)],
    );

    // zeroForOne = true: buying UTC with native ETH — must NOT record.
    await swapRouter.write.swap(
      [
        key,
        {
          zeroForOne: true,
          amountSpecified: -parseEther("0.01"),
          sqrtPriceLimitX96: MIN_SQRT_PRICE + 1n,
        },
        { takeClaims: false, settleUsingBurn: false },
        hookData,
      ],
      { account: trader.account, value: parseEther("1") },
    );

    expect(
      await hook.read.hasParticipated([0n, trader.account.address]),
    ).to.equal(false);
  });

  it("runs a full draw cycle end to end: sell -> 24h -> trigger -> resolve -> ship minted", async function () {
    const {
      poolManager,
      liquidityRouter,
      swapRouter,
      key,
      hook,
      hookAsOwner,
      ships,
      lp,
      trader,
    } = await loadFixture(deployFixture);

    await poolManager.write.initialize([key, SQRT_PRICE_1_1]);
    await liquidityRouter.write.modifyLiquidity(
      [
        key,
        {
          tickLower: MIN_USABLE_TICK,
          tickUpper: MAX_USABLE_TICK,
          liquidityDelta: parseEther("1"),
          salt: `0x${"0".repeat(64)}`,
        },
        "0x",
      ],
      { account: lp.account, value: parseEther("5") },
    );

    await hookAsOwner.write.setPrize([1, 0]);

    const hookData = encodeAbiParameters(
      [{ type: "address" }],
      [getAddress(trader.account.address)],
    );
    const sellParams = {
      zeroForOne: false,
      amountSpecified: -parseEther("10"),
      sqrtPriceLimitX96: MAX_SQRT_PRICE - 1n,
    };
    const testSettings = { takeClaims: false, settleUsingBurn: false };

    // First qualifying sell — accumulates weight in draw 0.
    await swapRouter.write.swap([key, sellParams, testSettings, hookData], {
      account: trader.account,
    });
    expect(await hook.read.currentDrawId()).to.equal(0n);

    // Past the 24h interval.
    await hre.network.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await hre.network.provider.send("evm_mine");

    // Any swap after the interval triggers the draw start.
    await swapRouter.write.swap([key, sellParams, testSettings, hookData], {
      account: trader.account,
    });
    expect(await hook.read.currentDrawId()).to.equal(1n);
    expect(await hook.read.drawRandomRequestId([0n])).to.not.equal(0n);

    // RandomManager needs a genuinely new prevrandao epoch since the
    // request's commit block before it can be revealed.
    await hre.network.provider.send("evm_mine");

    const shipCountBefore = await ships.read.shipCount();
    await hook.write.resolveDraw([0n]);
    const shipCountAfter = await ships.read.shipCount();

    expect(shipCountAfter - shipCountBefore).to.equal(1n);
    expect(await hook.read.drawResolved([0n])).to.equal(true);

    // The only participant in draw 0 was `trader`, so they must have won.
    const traderShipIds = await ships.read.getShipIdsOwned([
      trader.account.address,
    ]);
    expect(traderShipIds.length).to.equal(1);
  });
});
