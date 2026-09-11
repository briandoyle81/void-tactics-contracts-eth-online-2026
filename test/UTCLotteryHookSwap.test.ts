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
    const [deployerSigner, lp, trader, trader2, trader3] =
      await hre.viem.getWalletClients();
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
    await ucAsOwner.write.mint([lp.account.address, parseEther("10000")]);
    for (const t of [trader, trader2, trader3]) {
      await ucAsOwner.write.mint([t.account.address, parseEther("1000")]);
    }

    const ucAsLp = await hre.viem.getContractAt(
      "UniversalCredits",
      universalCredits.address,
      { client: { wallet: lp } },
    );
    await ucAsLp.write.approve([liquidityRouter.address, parseEther("10000")]);

    const [ucAsTrader, ucAsTrader2, ucAsTrader3] = await Promise.all(
      [trader, trader2, trader3].map((t) =>
        hre.viem.getContractAt("UniversalCredits", universalCredits.address, {
          client: { wallet: t },
        }),
      ),
    );
    await ucAsTrader.write.approve([swapRouter.address, parseEther("1000")]);
    await ucAsTrader2.write.approve([swapRouter.address, parseEther("1000")]);
    await ucAsTrader3.write.approve([swapRouter.address, parseEther("1000")]);

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
      trader2,
      trader3,
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

  it("weights an address by its single best sell in the draw, not a sum — a lower later sell doesn't replace it", async function () {
    const { poolManager, liquidityRouter, swapRouter, key, hook, lp, trader } =
      await loadFixture(deployFixture);

    await poolManager.write.initialize([key, SQRT_PRICE_1_1]);
    // Much deeper liquidity than the other tests in this file use — this
    // test compares *relative* proceeds between a small and a large sell,
    // which needs a pool deep enough that a 20-token sell isn't itself
    // enough to exhaust reserves and distort the comparison.
    await liquidityRouter.write.modifyLiquidity(
      [
        key,
        {
          tickLower: MIN_USABLE_TICK,
          tickUpper: MAX_USABLE_TICK,
          liquidityDelta: parseEther("1000"),
          salt: `0x${"0".repeat(64)}`,
        },
        "0x",
      ],
      { account: lp.account, value: parseEther("2000") },
    );

    const hookData = encodeAbiParameters(
      [{ type: "address" }],
      [getAddress(trader.account.address)],
    );
    const testSettings = { takeClaims: false, settleUsingBurn: false };
    const sell = (amount: bigint) => ({
      zeroForOne: false,
      amountSpecified: -amount,
      sqrtPriceLimitX96: MAX_SQRT_PRICE - 1n,
    });

    // Small sell first.
    await swapRouter.write.swap(
      [key, sell(parseEther("1")), testSettings, hookData],
      { account: trader.account },
    );
    const weightAfterSmall = await hook.read.weightInDraw([
      0n,
      trader.account.address,
    ]);

    // Bigger sell — should replace (raise) the recorded weight.
    await swapRouter.write.swap(
      [key, sell(parseEther("20")), testSettings, hookData],
      { account: trader.account },
    );
    const weightAfterBig = await hook.read.weightInDraw([
      0n,
      trader.account.address,
    ]);
    expect(weightAfterBig > weightAfterSmall).to.equal(true);
    expect(await hook.read.totalWeightInDraw([0n])).to.equal(weightAfterBig);

    // Small sell again — must NOT reduce the already-recorded (higher) weight.
    await swapRouter.write.swap(
      [key, sell(parseEther("1")), testSettings, hookData],
      { account: trader.account },
    );
    const weightAfterSecondSmall = await hook.read.weightInDraw([
      0n,
      trader.account.address,
    ]);
    expect(weightAfterSecondSmall).to.equal(weightAfterBig);
    expect(await hook.read.totalWeightInDraw([0n])).to.equal(weightAfterBig);
  });

  describe("draw eligibility gating", function () {
    it("defaults: drawInterval 24h, minParticipants 3, minTotalWeightWei 0", async function () {
      const { hook } = await loadFixture(deployFixture);
      expect(await hook.read.drawInterval()).to.equal(24n * 60n * 60n);
      expect(await hook.read.minParticipants()).to.equal(3n);
      expect(await hook.read.minTotalWeightWei()).to.equal(0n);
    });

    it("drawInterval/minParticipants/minTotalWeightWei setters are owner-only", async function () {
      const { hook, trader } = await loadFixture(deployFixture);
      const asTrader = await hre.viem.getContractAt(
        "UTCLotteryHook",
        hook.address,
        { client: { wallet: trader } },
      );
      await expect(
        asTrader.write.setDrawInterval([1n]),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
      await expect(
        asTrader.write.setMinParticipants([1n]),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
      await expect(
        asTrader.write.setMinTotalWeightWei([1n]),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });

    it("does not start a draw with fewer than minParticipants sellers, and keeps running (no reset) until a 3rd distinct seller shows up — even past drawInterval", async function () {
      const fixture = await loadFixture(deployFixture);
      const { hook, liquidityRouter, key, lp, trader, trader2, trader3 } =
        fixture;
      await setUpPoolAndLiquidity(fixture);
      // Deeper than the shared default — this test's final (eligibility-
      // completing) sell has to itself clear minEntryThresholdWei after
      // several prior sells, which a thin pool can't reliably do.
      await liquidityRouter.write.modifyLiquidity(
        [
          key,
          {
            tickLower: MIN_USABLE_TICK,
            tickUpper: MAX_USABLE_TICK,
            liquidityDelta: parseEther("1000"),
            salt: `0x${"1".repeat(64)}`,
          },
          "0x",
        ],
        { account: lp.account, value: parseEther("2000") },
      );
      const sellAs = makeSellAs(fixture);

      await sellAs(trader);
      await sellAs(trader2);
      expect(await hook.read.currentDrawId()).to.equal(0n);

      await hre.network.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await hre.network.provider.send("evm_mine");

      // Past the interval, but still only 2 distinct participants (trader
      // selling again doesn't add a new one) — must not start.
      await sellAs(trader);
      expect(await hook.read.currentDrawId()).to.equal(0n);
      expect(await hook.read.drawResolved([0n])).to.equal(false);

      // A genuinely 3rd distinct participant finally satisfies eligibility —
      // same draw (id 0) just kept accumulating the whole time, no reset.
      await sellAs(trader3);
      expect(await hook.read.currentDrawId()).to.equal(1n);
    });

    it("does not start a draw below minTotalWeightWei even with enough participants", async function () {
      const fixture = await loadFixture(deployFixture);
      const { hookAsOwner, hook, liquidityRouter, key, lp, trader, trader2, trader3 } =
        fixture;
      await setUpPoolAndLiquidity(fixture);
      await liquidityRouter.write.modifyLiquidity(
        [
          key,
          {
            tickLower: MIN_USABLE_TICK,
            tickUpper: MAX_USABLE_TICK,
            liquidityDelta: parseEther("1000"),
            salt: `0x${"1".repeat(64)}`,
          },
          "0x",
        ],
        { account: lp.account, value: parseEther("2000") },
      );
      await hookAsOwner.write.setMinTotalWeightWei([parseEther("5")]);
      const sellAs = makeSellAs(fixture);

      // Three small sells, each just over minEntryThresholdWei (0.01 ETH)
      // but nowhere near the 5 ETH minTotalWeightWei bar.
      await sellAs(trader, parseEther("0.1"));
      await sellAs(trader2, parseEther("0.1"));
      await sellAs(trader3, parseEther("0.1"));

      await hre.network.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await hre.network.provider.send("evm_mine");

      // Enough participants, still not enough total volume — must not start.
      await sellAs(trader, parseEther("0.1"));
      expect(await hook.read.currentDrawId()).to.equal(0n);

      // A big sell finally clears the total-volume bar.
      await sellAs(trader, parseEther("10"));
      expect(await hook.read.currentDrawId()).to.equal(1n);
    });

    it("setDrawInterval changes how long a draw must wait before it's even checked", async function () {
      const fixture = await loadFixture(deployFixture);
      const { hookAsOwner, hook, trader, trader2, trader3 } = fixture;
      await setUpPoolAndLiquidity(fixture);
      await hookAsOwner.write.setDrawInterval([60n]); // 1 minute, not 24h
      const sellAs = makeSellAs(fixture);

      await sellAs(trader);
      await sellAs(trader2);
      await sellAs(trader3);

      await hre.network.provider.send("evm_increaseTime", [61]);
      await hre.network.provider.send("evm_mine");

      await sellAs(trader);
      expect(await hook.read.currentDrawId()).to.equal(1n);
    });
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

  // Shared qualifying-sell helper: seller sells `amount` UTC for native ETH,
  // hookData naming them as the trader.
  function makeSellAs(fixture: Awaited<ReturnType<typeof deployFixture>>) {
    const { swapRouter, key } = fixture;
    return async (
      seller: { account: { address: `0x${string}` } },
      amount: bigint = parseEther("10"),
    ) => {
      const hookData = encodeAbiParameters(
        [{ type: "address" }],
        [getAddress(seller.account.address)],
      );
      await swapRouter.write.swap(
        [
          key,
          {
            zeroForOne: false,
            amountSpecified: -amount,
            sqrtPriceLimitX96: MAX_SQRT_PRICE - 1n,
          },
          { takeClaims: false, settleUsingBurn: false },
          hookData,
        ],
        { account: seller.account },
      );
    };
  }

  // Meets the default minParticipants (3) with three distinct qualifying
  // sellers, then triggers and resolves the draw. Returns the winner's
  // address — with 3 possible winners now (not just `trader`), callers
  // can't assume who it is and must check.
  async function runFullDrawCycle(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
  ): Promise<`0x${string}`> {
    const { hook, ships, trader, trader2, trader3 } = fixture;
    const sellers = [trader, trader2, trader3];
    const sellAs = makeSellAs(fixture);

    for (const seller of sellers) {
      await sellAs(seller);
    }
    expect(await hook.read.currentDrawId()).to.equal(0n);

    const shipCountsBefore = await Promise.all(
      sellers.map((s) => ships.read.getShipIdsOwned([s.account.address])),
    );

    // Past drawInterval. Time alone isn't enough to start a draw — it also
    // needs >= minParticipants and >= minTotalWeightWei, both already met
    // by the three sells above.
    await hre.network.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await hre.network.provider.send("evm_mine");

    // Any qualifying swap after the interval (now that eligibility is also
    // met) triggers the draw start.
    await sellAs(trader);
    expect(await hook.read.currentDrawId()).to.equal(1n);
    expect(await hook.read.drawRandomRequestId([0n])).to.not.equal(0n);

    // RandomManager needs a genuinely new prevrandao epoch since the
    // request's commit block before it can be revealed.
    await hre.network.provider.send("evm_mine");

    await hook.write.resolveDraw([0n]);
    expect(await hook.read.drawResolved([0n])).to.equal(true);

    const shipCountsAfter = await Promise.all(
      sellers.map((s) => ships.read.getShipIdsOwned([s.account.address])),
    );
    const winnerIndex = shipCountsAfter.findIndex(
      (after, i) => after.length > shipCountsBefore[i].length,
    );
    expect(winnerIndex).to.not.equal(-1);
    return getAddress(sellers[winnerIndex].account.address);
  }

  it("runs a full draw cycle with a queued template: sell -> 24h -> trigger -> resolve -> hand-crafted ship minted", async function () {
    const fixture = await loadFixture(deployFixture);
    const { hookAsOwner, ships } = fixture;
    await setUpPoolAndLiquidity(fixture);
    await hookAsOwner.write.queuePrizeTemplate([validTemplate]);

    const winner = await runFullDrawCycle(fixture);

    const winnerShipIds = await ships.read.getShipIdsOwned([winner]);
    expect(winnerShipIds.length).to.equal(1);

    // Hand-crafted via createSpecificShip, not the generic random path —
    // confirms _buildPrizeShip actually ran, not just that some ship exists.
    const prizeShip = await ships.read.getShip([winnerShipIds[0]]);
    expect(prizeShip.name).to.equal("Legendary Draw #0");
    expect(prizeShip.shipData.shiny).to.equal(true);
    expect(prizeShip.traits.accuracy).to.equal(2);
    expect(prizeShip.traits.hull).to.equal(2);
    expect(prizeShip.traits.speed).to.equal(2);
    expect(await hookAsOwner.read.queueLength()).to.equal(0n);
  });

  it("falls back to a random 4-star ship when the queue is empty", async function () {
    const fixture = await loadFixture(deployFixture);
    const { ships } = fixture;
    await setUpPoolAndLiquidity(fixture);
    // Queue deliberately left empty.

    const winner = await runFullDrawCycle(fixture);

    const winnerShipIds = await ships.read.getShipIdsOwned([winner]);
    expect(winnerShipIds.length).to.equal(1);

    // createShips(winner, 1, fallbackVariant, 4, false) gives the single
    // minted ship rank 5 (Ships._getKillsForRank(5) == 300), the same top
    // rank a real tier-4 pack's first ship gets — and it's NOT hand-crafted,
    // so it's still unconstructed (no name/stats revealed yet).
    const prizeShip = await ships.read.getShip([winnerShipIds[0]]);
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
      const { hookAsOwner, ships } = fixture;
      await setUpPoolAndLiquidity(fixture);
      await hookAsOwner.write.queuePrizeTemplate([
        { ...validTemplate, hull: 0 },
      ]);
      await hookAsOwner.write.queuePrizeTemplate([
        { ...validTemplate, hull: 1 },
      ]);

      const winner = await runFullDrawCycle(fixture);
      expect(await hookAsOwner.read.queueLength()).to.equal(1n);
      const winnerShipIds = await ships.read.getShipIdsOwned([winner]);
      const firstPrize = await ships.read.getShip([winnerShipIds[0]]);
      expect(firstPrize.traits.hull).to.equal(0); // first-queued template
    });
  });
});
