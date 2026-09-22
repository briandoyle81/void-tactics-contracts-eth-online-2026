// Test-only EVM storage manipulation replacing Game.sol's removed debug
// functions (debugDestroyShip/debugSetHullPointsToZero/debugSetShipPosition
// — see docs/audit-2.md I-01). These write directly to the Hardhat test
// blockchain's storage slots via hardhat-network-helpers' setStorageAt —
// nothing here has any on-chain footprint; it's pure test-side state setup,
// exactly the same kind of technique as Foundry's `vm.store`.
//
// Every slot number/offset below was cross-checked against the Solidity
// compiler's own authoritative storageLayout output (`hardhat.config.ts`
// requests it; see artifacts/build-info/*.json's
// .output.contracts["contracts/Game.sol"].Game.storageLayout) rather than
// hand-derived alone — that check caught a real bug (the `games` mapping is
// slot 10, not 9, because `Game is Ownable` and Ownable's own `_owner`
// occupies slot 0, shifting every one of Game.sol's own declared variables
// up by one). If Game.sol's or Types.sol's state variables / struct fields
// are ever reordered, re-derive against a fresh storageLayout dump before
// trusting these constants again — nothing else would catch a silent slot
// shift except test/GameDebugHelpers.test.ts's equivalence checks.
import {
  concat,
  hexToBigInt,
  keccak256,
  numberToHex,
  type Hex,
} from "viem";
import {
  getStorageAt,
  setStorageAt,
} from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";

// ---- Game.sol / Types.sol storage layout constants ----

// Game.sol's own state variables start at slot 1 (slot 0 is Ownable's
// _owner). `games` is the 9th one declared (ships, fleets, shipAttributes,
// maps, isAllowedToStartGames, factionAbilityResolvers, specialResolvers,
// healCapPercent, games) -> slot 9.
const GAMES_SLOT = 9n;

// GameData (Types.sol) field offsets, relative to a given game's base slot.
const GD_SHIP_ATTRIBUTES = 22n;
const GD_GRID = 23n;
const GD_SHIP_POSITIONS = 24n;
const GD_SHIP_MOVED_THIS_ROUND = 26n;
const GD_SHIPS_WITH_ZERO_HP = 28n;

// Attributes (Types.sol) packs into slot 0: version(u16,0) range(u8,2)
// gunDamage(u8,3) hullPoints(u8,4) maxHullPoints(u8,5) movement(u8,6)
// damageReduction(u8,7) reactorCriticalTimer(u8,8). Byte offsets are
// measured from the word's least-significant byte (Solidity convention).
const ATTR_HULL_POINTS_BYTE_OFFSET = 4;
const ATTR_REACTOR_TIMER_BYTE_OFFSET = 8;

// ShipPosition (Types.sol): slot+0 shipId, slot+1 position (Position:
// row int16 @0, col int16 @2), slot+2 isCreator(bool,@0)/status(uint8,@1).
const SP_POSITION_SLOT_OFFSET = 1n;
const SP_FLAGS_SLOT_OFFSET = 2n;
const SP_STATUS_BYTE_OFFSET = 1;

// EnumerableSet.UintSet (OZ 5.3.0): _inner.slot+0 = _values (bytes32[]
// length; data at keccak256(slot)), _inner.slot+1 = _positions (mapping
// bytes32 => uint256, 1-indexed, 0 = not present).
const SET_VALUES_SLOT_OFFSET = 0n;
const SET_POSITIONS_SLOT_OFFSET = 1n;

// ---- low-level slot arithmetic ----

function pad32(value: bigint): Hex {
  const asUint = value < 0n ? (1n << 256n) + value : value;
  return numberToHex(asUint, { size: 32 });
}

// Solidity mapping slot formula: keccak256(pad32(key) . pad32(baseSlot)).
// Works identically for a uint256 key (games[gameId], shipPositions[shipId])
// and a bytes32 key (EnumerableSet's _positions[bytes32(value)]) — a
// uint256 value and its bytes32 cast share the same 32-byte encoding.
function mappingSlot(key: bigint, baseSlot: bigint): bigint {
  return hexToBigInt(keccak256(concat([pad32(key), pad32(baseSlot)])));
}

// Dynamic array data start (Solidity: keccak256(pad32(lengthSlot))).
function arrayDataStart(lengthSlot: bigint): bigint {
  return hexToBigInt(keccak256(pad32(lengthSlot)));
}

async function readWord(address: string, slot: bigint): Promise<bigint> {
  return hexToBigInt((await getStorageAt(address, slot)) as Hex);
}

function readByteRange(
  word: bigint,
  byteOffset: number,
  byteWidth: number
): bigint {
  const mask = (1n << BigInt(byteWidth * 8)) - 1n;
  return (word >> BigInt(byteOffset * 8)) & mask;
}

function writeByteRange(
  word: bigint,
  byteOffset: number,
  byteWidth: number,
  value: bigint
): bigint {
  const mask = (1n << BigInt(byteWidth * 8)) - 1n;
  const cleared = word & ~(mask << BigInt(byteOffset * 8));
  return cleared | ((value & mask) << BigInt(byteOffset * 8));
}

function toInt16(raw: bigint): number {
  const v = Number(raw & 0xffffn);
  return v >= 0x8000 ? v - 0x10000 : v;
}

function fromInt16(value: number): bigint {
  const unsigned = value < 0 ? value + 0x10000 : value;
  return BigInt(unsigned) & 0xffffn;
}

function gameBaseSlot(gameId: bigint): bigint {
  return mappingSlot(gameId, GAMES_SLOT);
}

// Read-only: which shipId (0 = none) currently occupies a grid cell.
// Exported for equivalence-test verification only, independent of
// setShipPosition's write path (both derive the same slot via the same
// mappingSlot/gameBaseSlot primitives, but this reads rather than writes,
// so it isn't circular — getShipPosition already independently confirms
// those primitives are correct before this is used to double-check grid
// occupancy specifically).
export async function getGridShipId(
  gameAddress: string,
  gameId: bigint,
  row: number,
  col: number
): Promise<bigint> {
  const gameSlot = gameBaseSlot(gameId);
  const gridBase = gameSlot + GD_GRID;
  const rowSlot = mappingSlot(fromInt16(row), gridBase);
  const cellSlot = mappingSlot(fromInt16(col), rowSlot);
  return readWord(gameAddress, cellSlot);
}

// ---- EnumerableSet.UintSet add/remove (faithful OZ 5.3.0 replica) ----

async function enumerableSetAdd(
  address: string,
  setBaseSlot: bigint,
  value: bigint
): Promise<void> {
  const positionsBase = setBaseSlot + SET_POSITIONS_SLOT_OFFSET;
  const posSlot = mappingSlot(value, positionsBase);
  const currentPos = await readWord(address, posSlot);
  if (currentPos !== 0n) return; // already present, matches OZ's no-op-on-duplicate

  const lengthSlot = setBaseSlot + SET_VALUES_SLOT_OFFSET;
  const len = await readWord(address, lengthSlot);
  const dataStart = arrayDataStart(lengthSlot);

  await setStorageAt(address, dataStart + len, value);
  await setStorageAt(address, lengthSlot, len + 1n);
  await setStorageAt(address, posSlot, len + 1n); // 1-indexed
}

async function enumerableSetRemove(
  address: string,
  setBaseSlot: bigint,
  value: bigint
): Promise<void> {
  const positionsBase = setBaseSlot + SET_POSITIONS_SLOT_OFFSET;
  const posSlot = mappingSlot(value, positionsBase);
  const pos = await readWord(address, posSlot);
  if (pos === 0n) return; // not present, matches OZ's no-op

  const valueIndex = pos - 1n;
  const lengthSlot = setBaseSlot + SET_VALUES_SLOT_OFFSET;
  const len = await readWord(address, lengthSlot);
  const lastIndex = len - 1n;
  const dataStart = arrayDataStart(lengthSlot);

  if (valueIndex !== lastIndex) {
    const lastValue = await readWord(address, dataStart + lastIndex);
    await setStorageAt(address, dataStart + valueIndex, lastValue);
    const lastValuePosSlot = mappingSlot(lastValue, positionsBase);
    await setStorageAt(address, lastValuePosSlot, pos);
  }

  await setStorageAt(address, lengthSlot, lastIndex);
  await setStorageAt(address, posSlot, 0n);
}

// ---- purpose-built helpers (these are what test files call) ----

// Replaces debugSetShipPosition. Reads the ship's current position first
// (directly from storage, so this helper has no dependency on a contract
// instance/ABI — just the deployed address) to know which grid cell to
// clear, matching the real function's exact 4-write behavior: clear old
// grid cell, set position, clear status (revive from destroyed/fled if it
// was), set new grid cell.
export async function setShipPosition(
  gameAddress: string,
  gameId: bigint,
  shipId: bigint,
  row: number,
  col: number
): Promise<void> {
  const gameSlot = gameBaseSlot(gameId);
  const shipPositionsBase = gameSlot + GD_SHIP_POSITIONS;
  const spSlot0 = mappingSlot(shipId, shipPositionsBase);
  const positionSlot = spSlot0 + SP_POSITION_SLOT_OFFSET;
  const flagsSlot = spSlot0 + SP_FLAGS_SLOT_OFFSET;

  const oldPositionWord = await readWord(gameAddress, positionSlot);
  const oldRow = toInt16(readByteRange(oldPositionWord, 0, 2));
  const oldCol = toInt16(readByteRange(oldPositionWord, 2, 2));

  const gridBase = gameSlot + GD_GRID;
  const oldRowSlot = mappingSlot(fromInt16(oldRow), gridBase);
  const oldCellSlot = mappingSlot(fromInt16(oldCol), oldRowSlot);
  await setStorageAt(gameAddress, oldCellSlot, 0n);

  let newPositionWord = 0n;
  newPositionWord = writeByteRange(newPositionWord, 0, 2, fromInt16(row));
  newPositionWord = writeByteRange(newPositionWord, 2, 2, fromInt16(col));
  await setStorageAt(gameAddress, positionSlot, newPositionWord);

  const flagsWord = await readWord(gameAddress, flagsSlot);
  const newFlagsWord = writeByteRange(
    flagsWord,
    SP_STATUS_BYTE_OFFSET,
    1,
    0n
  );
  await setStorageAt(gameAddress, flagsSlot, newFlagsWord);

  const newRowSlot = mappingSlot(fromInt16(row), gridBase);
  const newCellSlot = mappingSlot(fromInt16(col), newRowSlot);
  await setStorageAt(gameAddress, newCellSlot, shipId);
}

// Replaces debugSetHullPointsToZero: hullPoints=0, remove from
// shipMovedThisRound, add to shipsWithZeroHP — same three effects as
// _setShipHPToZero plus the debug function's own extra explicit
// shipMovedThisRound removal.
export async function setShipHullPointsToZero(
  gameAddress: string,
  gameId: bigint,
  shipId: bigint
): Promise<void> {
  const gameSlot = gameBaseSlot(gameId);
  const shipAttributesBase = gameSlot + GD_SHIP_ATTRIBUTES;
  const attrSlot0 = mappingSlot(shipId, shipAttributesBase);

  const attrWord = await readWord(gameAddress, attrSlot0);
  const newAttrWord = writeByteRange(
    attrWord,
    ATTR_HULL_POINTS_BYTE_OFFSET,
    1,
    0n
  );
  await setStorageAt(gameAddress, attrSlot0, newAttrWord);

  await enumerableSetRemove(
    gameAddress,
    gameSlot + GD_SHIP_MOVED_THIS_ROUND,
    shipId
  );
  await enumerableSetAdd(
    gameAddress,
    gameSlot + GD_SHIPS_WITH_ZERO_HP,
    shipId
  );
}

// Sets a ship's current hull points to `hp` (an "injured but alive" ship when
// 0 < hp < max). Only the hull byte is written; use setShipHullPointsToZero
// for a downed ship, which also needs the zero-HP bookkeeping.
export async function setShipHullPoints(
  gameAddress: string,
  gameId: bigint,
  shipId: bigint,
  hp: number
): Promise<void> {
  const attrSlot0 = mappingSlot(
    shipId,
    gameBaseSlot(gameId) + GD_SHIP_ATTRIBUTES
  );
  const attrWord = await readWord(gameAddress, attrSlot0);
  await setStorageAt(
    gameAddress,
    attrSlot0,
    writeByteRange(attrWord, ATTR_HULL_POINTS_BYTE_OFFSET, 1, BigInt(hp))
  );
}

// Replaces debugDestroyShip — NOT by replicating _removeShipFromGame (too
// cross-cutting: 3 EnumerableSets, a dynamic array push, and cross-contract
// calls into Fleets/Ships plus a conditional orchestrator callback — see
// docs/audit-2.md I-01's resolution). Instead: prime the ship (hullPoints=0
// AND reactorCriticalTimer=2, packed into the same word as one write, plus
// shipsWithZeroHP membership), then the CALLER must drive one real round to
// completion. Game.sol's own existing
// _incrementReactorCriticalTimerForZeroHPShips then increments the timer to
// 3 and calls the real _removeShipFromGame itself — fully correct
// cross-contract cleanup through the actual production code path, not a
// hand-rolled replica. Does not touch shipMovedThisRound: round completion
// only needs a ship counted in EITHER that set or shipsWithZeroHP (see
// Game.sol's _checkRoundComplete), so leaving it as-is is harmless.
export async function primeShipForRealDestruction(
  gameAddress: string,
  gameId: bigint,
  shipId: bigint
): Promise<void> {
  const gameSlot = gameBaseSlot(gameId);
  const shipAttributesBase = gameSlot + GD_SHIP_ATTRIBUTES;
  const attrSlot0 = mappingSlot(shipId, shipAttributesBase);

  let attrWord = await readWord(gameAddress, attrSlot0);
  attrWord = writeByteRange(attrWord, ATTR_HULL_POINTS_BYTE_OFFSET, 1, 0n);
  attrWord = writeByteRange(
    attrWord,
    ATTR_REACTOR_TIMER_BYTE_OFFSET,
    1,
    2n
  );
  await setStorageAt(gameAddress, attrSlot0, attrWord);

  await enumerableSetAdd(
    gameAddress,
    gameSlot + GD_SHIPS_WITH_ZERO_HP,
    shipId
  );
}
