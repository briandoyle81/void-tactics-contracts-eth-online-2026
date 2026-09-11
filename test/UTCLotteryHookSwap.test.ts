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

  const validTemplate = {
    variant: 1,
    colors: {
      h1: 45,
      s1: 100,
      l1: 50,
      h2: 45,
      s2: 100,
      l2: 50,
      h3: 45,
      s3: 100,
      l3: 50,
    },
    accuracy: 2,
    hull: 2,
    speed: 2,
    mainWeapon: 0, // MainWeapon.Generic
    armor: 3, // Armor.Heavy
    shields: 0, // Shields.None
    special: 0, // Special.None
  };

  async function setUpPoolAndLiquidity(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
  ) {
    const { poolManager, liquidityRouter, key, lp } = fixture;
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
  }

  async function runFullDrawCycle(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
  ) {
    const { swapRouter, key, hook, trader } = fixture;
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

    await hook.write.resolveDraw([0n]);
    expect(await hook.read.drawResolved([0n])).to.equal(true);
  }

  it("runs a full draw cycle with a queued template: sell -> 24h -> trigger -> resolve -> hand-crafted ship minted", async function () {
    const fixture = await loadFixture(deployFixture);
    const { hookAsOwner, ships, trader } = fixture;
    await setUpPoolAndLiquidity(fixture);
    await hookAsOwner.write.queuePrizeTemplate([validTemplate]);

    await runFullDrawCycle(fixture);

    // The only participant in draw 0 was `trader`, so they must have won.
    const traderShipIds = await ships.read.getShipIdsOwned([
      trader.account.address,
    ]);
    expect(traderShipIds.length).to.equal(1);

    // Hand-crafted via createSpecificShip, not the generic random path —
    // confirms _buildPrizeShip actually ran, not just that some ship exists.
    const prizeShip = await ships.read.getShip([traderShipIds[0]]);
    expect(prizeShip.name).to.equal("Legendary Draw #0");
    expect(prizeShip.shipData.shiny).to.equal(true);
    expect(prizeShip.traits.accuracy).to.equal(2);
    expect(prizeShip.traits.hull).to.equal(2);
    expect(prizeShip.traits.speed).to.equal(2);
    expect(await hookAsOwner.read.queueLength()).to.equal(0n);
  });

  it("falls back to a random 4-star ship when the queue is empty", async function () {
    const fixture = await loadFixture(deployFixture);
    const { ships, trader } = fixture;
    await setUpPoolAndLiquidity(fixture);
    // Queue deliberately left empty.

    await runFullDrawCycle(fixture);

    const traderShipIds = await ships.read.getShipIdsOwned([
      trader.account.address,
    ]);
    expect(traderShipIds.length).to.equal(1);

    // createShips(winner, 1, fallbackVariant, 4, false) gives the single
    // minted ship rank 5 (Ships._getKillsForRank(5) == 300), the same top
    // rank a real tier-4 pack's first ship gets — and it's NOT hand-crafted,
    // so it's still unconstructed (no name/stats revealed yet).
    const prizeShip = await ships.read.getShip([traderShipIds[0]]);
    expect(prizeShip.shipData.shipsDestroyed).to.equal(300);
    expect(prizeShip.shipData.constructed).to.equal(false);
    expect(prizeShip.name).to.equal("");
  });

  describe("prize queue", function () {
    it("only the owner can queue a template", async function () {
      const { hook, trader } = await loadFixture(deployFixture);
      const asTrader = await hre.viem.getContractAt(
        "UTCLotteryHook",
        hook.address,
        { client: { wallet: trader } },
      );
      await expect(
        asTrader.write.queuePrizeTemplate([validTemplate]),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });

    it("reverts InvalidPrizeVariant for variant 0", async function () {
      const { hookAsOwner } = await loadFixture(deployFixture);
      await expect(
        hookAsOwner.write.queuePrizeTemplate([
          { ...validTemplate, variant: 0 },
        ]),
      ).to.be.rejectedWith("InvalidPrizeVariant");
    });

    it("reverts InvalidPrizeVariant for a variant beyond maxVariant", async function () {
      const { hookAsOwner, ships } = await loadFixture(deployFixture);
      const maxVariant = await ships.read.maxVariant();
      await expect(
        hookAsOwner.write.queuePrizeTemplate([
          { ...validTemplate, variant: maxVariant + 1 },
        ]),
      ).to.be.rejectedWith("InvalidPrizeVariant");
    });

    it("reverts ArmorAndShieldsBothSet when both are non-None", async function () {
      const { hookAsOwner } = await loadFixture(deployFixture);
      await expect(
        hookAsOwner.write.queuePrizeTemplate([
          { ...validTemplate, armor: 3, shields: 1 },
        ]),
      ).to.be.rejectedWith("ArmorAndShieldsBothSet");
    });

    it("reverts InvalidPrizeStatTier when a stat exceeds tier 2", async function () {
      const { hookAsOwner } = await loadFixture(deployFixture);
      await expect(
        hookAsOwner.write.queuePrizeTemplate([
          { ...validTemplate, accuracy: 3 },
        ]),
      ).to.be.rejectedWith("InvalidPrizeStatTier");
    });

    it("accepts a valid template and increments queueLength", async function () {
      const { hookAsOwner } = await loadFixture(deployFixture);
      await hookAsOwner.write.queuePrizeTemplate([
        { ...validTemplate, hull: 1 },
      ]);
      expect(await hookAsOwner.read.queueLength()).to.equal(1n);
    });

    it("allows up to MAX_QUEUE_SIZE (5) templates, then reverts PrizeQueueFull", async function () {
      const { hookAsOwner } = await loadFixture(deployFixture);
      for (let i = 0; i < 5; i++) {
        await hookAsOwner.write.queuePrizeTemplate([validTemplate]);
      }
      expect(await hookAsOwner.read.queueLength()).to.equal(5n);
      await expect(
        hookAsOwner.write.queuePrizeTemplate([validTemplate]),
      ).to.be.rejectedWith("PrizeQueueFull");
    });

    it("clearPrizeQueue empties the queue and is owner-only", async function () {
      const { hookAsOwner, hook, trader } = await loadFixture(deployFixture);
      await hookAsOwner.write.queuePrizeTemplate([validTemplate]);
      await hookAsOwner.write.queuePrizeTemplate([validTemplate]);
      expect(await hook.read.queueLength()).to.equal(2n);

      const asTrader = await hre.viem.getContractAt(
        "UTCLotteryHook",
        hook.address,
        { client: { wallet: trader } },
      );
      await expect(
        asTrader.write.clearPrizeQueue(),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");

      await hookAsOwner.write.clearPrizeQueue();
      expect(await hook.read.queueLength()).to.equal(0n);
    });

    it("dequeues in FIFO order across multiple resolved draws", async function () {
      const fixture = await loadFixture(deployFixture);
      const { hookAsOwner, ships, trader } = fixture;
      await setUpPoolAndLiquidity(fixture);
      await hookAsOwner.write.queuePrizeTemplate([
        { ...validTemplate, hull: 0 },
      ]);
      await hookAsOwner.write.queuePrizeTemplate([
        { ...validTemplate, hull: 1 },
      ]);

      await runFullDrawCycle(fixture);
      expect(await hookAsOwner.read.queueLength()).to.equal(1n);
      const traderShipIds = await ships.read.getShipIdsOwned([
        trader.account.address,
      ]);
      const firstPrize = await ships.read.getShip([traderShipIds[0]]);
      expect(firstPrize.traits.hull).to.equal(0); // first-queued template
    });
  });
});
