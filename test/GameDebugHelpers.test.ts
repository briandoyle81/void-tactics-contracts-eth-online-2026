import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { parseEther, zeroAddress } from "viem";
import { ShipTuple, tupleToShip, GameDataView, ActionType } from "./types";
import DeployModule from "../ignition/modules/DeployAndConfig";
import {
  setShipPosition,
  setShipHullPointsToZero,
  primeShipForRealDestruction,
  getGridShipId,
} from "./helpers/gameStorage";

// Equivalence proof for the storage-poke helpers in test/helpers/gameStorage.ts,
// run BEFORE any real test call site is migrated and BEFORE Game.sol's debug
// functions are deleted (see docs/audit-2.md I-01 and the removal plan). Each
// helper's resulting on-chain state is compared against the still-present
// real debug function's resulting state, via existing public getters plus
// one read-only grid-slot check (independent of the write path — see
// getGridShipId's own comment).
function generateStartingPositions(shipIds: bigint[], isCreator: boolean) {
  const positions = [];
  for (let i = 0; i < shipIds.length; i++) {
    if (isCreator) {
      positions.push({ row: i % 11, col: i % 4 });
    } else {
      const row = Math.max(0, 10 - (i % 11));
      positions.push({ row, col: 13 + (i % 4) });
    }
  }
  return positions;
}

function findShipPosition(gameData: GameDataView, shipId: bigint) {
  for (const sp of gameData.shipPositions) {
    if (sp.shipId === shipId) return sp.position;
  }
  throw new Error(`Ship ${shipId} not found in game data`);
}

describe("Game debug-function storage-poke helpers (equivalence proof, I-01 removal prep)", function () {
  async function deployFixture() {
    const [owner, creator, joiner] = await hre.viem.getWalletClients();

    const deployed = await hre.ignition.deploy(DeployModule);

    const creatorLobbies = await hre.viem.getContractAt(
      "Lobbies",
      deployed.lobbies.address,
      { client: { wallet: creator } },
    );
    const joinerLobbies = await hre.viem.getContractAt(
      "Lobbies",
      deployed.lobbies.address,
      { client: { wallet: joiner } },
    );
    const gameAsOwner = await hre.viem.getContractAt(
      "Game",
      deployed.game.address,
      { client: { wallet: owner } },
    );

    const ships = deployed.ships;
    const game = deployed.game;
    const randomManager = deployed.randomManager;

    // Tier 0 = 5 ships per purchase: creator gets 1-5, joiner gets 6-10.
    await ships.write.purchaseWithFlow(
      [creator.account.address, 0n, owner.account.address, 1],
      { value: parseEther("4.99") },
    );
    await ships.write.purchaseWithFlow(
      [joiner.account.address, 0n, owner.account.address, 1],
      { value: parseEther("4.99") },
    );
    for (let i = 1; i <= 10; i++) {
      const shipTuple = (await ships.read.ships([BigInt(i)])) as ShipTuple;
      const ship = tupleToShip(shipTuple);
      await randomManager.write.revealRandomness([ship.traits.serialNumber]);
    }
    await ships.write.constructAllMyShips({ account: creator.account });
    await ships.write.constructAllMyShips({ account: joiner.account });

    // 3 ships per side, so round-completion tests have other ships to Pass.
    const creatorShipIds = [1n, 2n, 3n];
    const joinerShipIds = [6n, 7n, 8n];

    await creatorLobbies.write.createLobby([
      1000n,
      300n,
      true,
      0n,
      100n,
      zeroAddress,
    ]);
    await joinerLobbies.write.joinLobby([1n]);
    await creatorLobbies.write.createFleet([
      1n,
      creatorShipIds,
      generateStartingPositions(creatorShipIds, true),
    ]);
    await joinerLobbies.write.createFleet([
      1n,
      joinerShipIds,
      generateStartingPositions(joinerShipIds, false),
    ]);

    return {
      owner,
      creator,
      joiner,
      ships,
      game,
      gameAsOwner,
      gameId: 1n,
      creatorShipIds,
      joinerShipIds,
    };
  }

  it("setShipPosition matches debugSetShipPosition's resulting state", async function () {
    const { gameAsOwner, game, gameId } = await loadFixture(deployFixture);

    // Ship 2 via the real, still-present debug function.
    await gameAsOwner.write.debugSetShipPosition([gameId, 2n, 5, 5]);
    const realResult = await game.read.getShipPosition([gameId, 2n]);

    // Ship 3 via the new storage-poke helper.
    await setShipPosition(game.address, gameId, 3n, 5, 6);
    const helperResult = await game.read.getShipPosition([gameId, 3n]);

    expect(realResult.position.row).to.equal(5);
    expect(realResult.position.col).to.equal(5);
    expect(realResult.status).to.equal(0);
    expect(realResult.isCreator).to.equal(true);

    expect(helperResult.position.row).to.equal(5);
    expect(helperResult.position.col).to.equal(6);
    expect(helperResult.status).to.equal(0);
    expect(helperResult.isCreator).to.equal(true);

    // Grid correctness, independent of getShipPosition: old cells cleared,
    // new cells occupied, for both the real- and helper-driven ships.
    expect(await getGridShipId(game.address, gameId, 5, 5)).to.equal(2n);
    expect(await getGridShipId(game.address, gameId, 5, 6)).to.equal(3n);
    // Ship 3's original starting cell (row 2 % 11 = 2, col 2 % 4 = 2) is vacated.
    expect(await getGridShipId(game.address, gameId, 2, 2)).to.equal(0n);
    // Ship 2's original starting cell (row 1, col 1) is vacated.
    expect(await getGridShipId(game.address, gameId, 1, 1)).to.equal(0n);
  });

  it("setShipHullPointsToZero matches debugSetHullPointsToZero's resulting state", async function () {
    const { gameAsOwner, game, gameId } = await loadFixture(deployFixture);

    // Ship 2 via the real debug function.
    await gameAsOwner.write.debugSetHullPointsToZero([gameId, 2n]);
    const realAttrs = await game.read.getShipAttributes([gameId, 2]);
    expect(realAttrs.hullPoints).to.equal(0);

    // Ship 3 via the new helper.
    await setShipHullPointsToZero(game.address, gameId, 3n);
    const helperAttrs = await game.read.getShipAttributes([gameId, 3]);
    expect(helperAttrs.hullPoints).to.equal(0);

    // shipsWithZeroHP membership (the EnumerableSet side effect) is proven
    // indirectly in the next test, via reactorCriticalTimer incrementing
    // after a real round completes.
  });

  it("completing a round after zeroing HP increments reactorCriticalTimer for both the real- and helper-driven ship", async function () {
    const { gameAsOwner, game, gameId, creator, joiner } =
      await loadFixture(deployFixture);

    await gameAsOwner.write.debugSetHullPointsToZero([gameId, 2n]);
    await setShipHullPointsToZero(game.address, gameId, 3n);

    // Complete round 1 (creator goes first by default in Lobbies-started
    // games): Pass every ship that can still move. Ships 2 and 3 are at 0
    // HP (counted via shipsWithZeroHP, not required to move); ship 1
    // (creator) and ships 6/7/8 (joiner) still need to act.
    const gameData = (await game.read.getGame([gameId])) as GameDataView;
    const pos1 = findShipPosition(gameData, 1n);
    const pos6 = findShipPosition(gameData, 6n);
    const pos7 = findShipPosition(gameData, 7n);
    const pos8 = findShipPosition(gameData, 8n);

    const creatorGame = await hre.viem.getContractAt(
      "Game",
      game.address,
      { client: { wallet: creator } },
    );
    const joinerGame = await hre.viem.getContractAt(
      "Game",
      game.address,
      { client: { wallet: joiner } },
    );

    await creatorGame.write.moveShip([
      gameId,
      1n,
      pos1.row,
      pos1.col,
      ActionType.Pass,
      0n,
    ]);
    await joinerGame.write.moveShip([
      gameId,
      6n,
      pos6.row,
      pos6.col,
      ActionType.Pass,
      0n,
    ]);
    await joinerGame.write.moveShip([
      gameId,
      7n,
      pos7.row,
      pos7.col,
      ActionType.Pass,
      0n,
    ]);
    await joinerGame.write.moveShip([
      gameId,
      8n,
      pos8.row,
      pos8.col,
      ActionType.Pass,
      0n,
    ]);

    const realAttrsAfter = await game.read.getShipAttributes([gameId, 2]);
    const helperAttrsAfter = await game.read.getShipAttributes([gameId, 3]);
    expect(realAttrsAfter.reactorCriticalTimer).to.equal(1);
    expect(helperAttrsAfter.reactorCriticalTimer).to.equal(1);
  });

  it("primeShipForRealDestruction + one real round completion matches debugDestroyShip's resulting state", async function () {
    const { gameAsOwner, game, gameId, creator, joiner, ships } =
      await loadFixture(deployFixture);

    // Ship 2 via the real, still-present debug function — instant removal.
    await gameAsOwner.write.debugDestroyShip([gameId, 2n]);
    const realPositionsAfter = (await game.read.getAllShipPositions([
      gameId,
    ])) as unknown as { shipId: bigint; status: number }[];
    const realShip2 = realPositionsAfter.find((p) => p.shipId === 2n);
    expect(realShip2?.status).to.equal(1); // destroyed

    // Ship 3 via prime + one real round completion.
    await primeShipForRealDestruction(game.address, gameId, 3n);

    const gameData = (await game.read.getGame([gameId])) as GameDataView;
    const pos1 = findShipPosition(gameData, 1n);
    const pos6 = findShipPosition(gameData, 6n);
    const pos7 = findShipPosition(gameData, 7n);
    const pos8 = findShipPosition(gameData, 8n);

    const creatorGame = await hre.viem.getContractAt(
      "Game",
      game.address,
      { client: { wallet: creator } },
    );
    const joinerGame = await hre.viem.getContractAt(
      "Game",
      game.address,
      { client: { wallet: joiner } },
    );

    // Ship 2 is already gone (removed via the real debug call above), so
    // this round only needs ships 1, 6, 7, 8 to act; ship 3 (0 HP, primed)
    // is counted via shipsWithZeroHP.
    await creatorGame.write.moveShip([
      gameId,
      1n,
      pos1.row,
      pos1.col,
      ActionType.Pass,
      0n,
    ]);
    await joinerGame.write.moveShip([
      gameId,
      6n,
      pos6.row,
      pos6.col,
      ActionType.Pass,
      0n,
    ]);
    await joinerGame.write.moveShip([
      gameId,
      7n,
      pos7.row,
      pos7.col,
      ActionType.Pass,
      0n,
    ]);
    await joinerGame.write.moveShip([
      gameId,
      8n,
      pos8.row,
      pos8.col,
      ActionType.Pass,
      0n,
    ]);

    const positionsAfter = (await game.read.getAllShipPositions([
      gameId,
    ])) as unknown as { shipId: bigint; status: number }[];
    const helperShip3 = positionsAfter.find((p) => p.shipId === 3n);
    expect(helperShip3?.status).to.equal(1); // destroyed, matching debugDestroyShip

    // Cross-contract cleanup happened for real (not replicated by hand):
    // ships.setTimestampDestroyed was called through the real
    // _removeShipFromGame path, exactly as it was for ship 2 via the real
    // debug function.
    const ship2Tuple = (await ships.read.ships([2n])) as ShipTuple;
    const ship3TupleAfter = (await ships.read.ships([3n])) as ShipTuple;
    expect(tupleToShip(ship2Tuple).shipData.timestampDestroyed).to.not.equal(
      0,
    );
    expect(
      tupleToShip(ship3TupleAfter).shipData.timestampDestroyed,
    ).to.not.equal(0);
  });
});
