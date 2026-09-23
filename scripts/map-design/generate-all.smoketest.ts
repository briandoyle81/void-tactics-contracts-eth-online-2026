// Early smoke test for Phase 4 (the archetype library + generator) — runs
// every slot in the difficulty table through the generator and checks the
// structural properties Phase 5's real validator will enforce formally:
// symmetry (for symmetric modes), no scoring tile on an impassable cell,
// in-bounds positions, and non-degenerate output. This is a quick sanity
// pass, not a substitute for validate-map.ts.
//
// Run with: npx hardhat run scripts/map-design/generate-all.smoketest.ts

import { buildDifficultyTable } from "./difficulty-table";
import { generateAllMaps, EXEMPLAR_KEY } from "./generate-map";
import { mirrorFor } from "./archetypes";
import { GRID_HEIGHT, GRID_WIDTH } from "./los";
import { SparseMap } from "./dense-grid-format";

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) {
    failures++;
    console.error(`FAIL: ${name}`);
  }
}

const table = buildDifficultyTable();
check(
  "difficulty table has 39 slots (30 campaign + 5 roguelike + 4 pvp, the exemplar is pvp04)",
  table.length === 39,
);

const maps = generateAllMaps(table);
check("generated one map per slot", maps.length === table.length);

const keyOf = new Map(table.map((s) => [s.key, s]));

function positionKey(p: { row: number; col: number }): string {
  return `${p.row},${p.col}`;
}

let totalBlocked = 0;
let totalImpassable = 0;
let totalScoring = 0;

for (const map of maps) {
  const spec = keyOf.get(map.key!)!;
  const label = `${map.key} (${spec.archetype}/${spec.symmetryMode}/${spec.balanceIntent})`;

  // In-bounds.
  for (const p of [...map.blockedTiles, ...map.impassableTiles, ...map.creatorZone, ...map.joinerZone]) {
    check(
      `${label}: position (${p.row},${p.col}) in bounds`,
      p.row >= 0 && p.row < GRID_HEIGHT && p.col >= 0 && p.col < GRID_WIDTH,
    );
  }
  for (const s of map.scoringTiles) {
    check(
      `${label}: scoring position (${s.row},${s.col}) in bounds`,
      s.row >= 0 && s.row < GRID_HEIGHT && s.col >= 0 && s.col < GRID_WIDTH,
    );
  }

  // Symmetry (skip the hand-authored exemplar and any "none" imbalance slot).
  if (map.key !== EXEMPLAR_KEY && spec.symmetryMode !== "none") {
    const mirror = mirrorFor(spec.symmetryMode);
    const blockedSet = new Set(map.blockedTiles.map(positionKey));
    let blockedAsymmetric = 0;
    for (const p of map.blockedTiles) {
      const m = mirror(p.row, p.col);
      if (!blockedSet.has(positionKey(m))) blockedAsymmetric++;
    }
    check(`${label}: blocked tiles are symmetric under ${spec.symmetryMode}`, blockedAsymmetric === 0);

    const impassableSet = new Set(map.impassableTiles.map(positionKey));
    let impassableAsymmetric = 0;
    for (const p of map.impassableTiles) {
      const m = mirror(p.row, p.col);
      if (!impassableSet.has(positionKey(m))) impassableAsymmetric++;
    }
    check(`${label}: impassable tiles are symmetric under ${spec.symmetryMode}`, impassableAsymmetric === 0);
  }

  // No scoring tile on an impassable cell.
  const impassableSet2 = new Set(map.impassableTiles.map(positionKey));
  for (const s of map.scoringTiles) {
    check(
      `${label}: scoring tile (${s.row},${s.col}) is not on an impassable cell`,
      !impassableSet2.has(positionKey(s)),
    );
  }

  // Non-degenerate: every map except the two intentionally-sparse Open
  // Void slots should have at least a handful of blocked/impassable cells.
  const totalCover = map.blockedTiles.length + map.impassableTiles.length;
  if (spec.archetype !== "openVoid") {
    // >=4 was this early smoke test's own arbitrary threshold, written
    // before validate-map.ts existed; a legitimately sparse Debris Ring
    // roll can land lower and still be a perfectly valid map (the real
    // check is "non-zero", matching validate-map.ts's checkNonDegenerate).
    check(`${label}: has non-trivial cover (${totalCover} cells)`, totalCover >= 1);
  }
  check(`${label}: has at least one scoring tile`, map.scoringTiles.length >= 1);

  totalBlocked += map.blockedTiles.length;
  totalImpassable += map.impassableTiles.length;
  totalScoring += map.scoringTiles.length;

  console.log(
    `${label}: ${map.blockedTiles.length} blocked, ${map.impassableTiles.length} impassable, ${map.scoringTiles.length} scoring`,
  );
}

console.log(
  `\nTotals across ${maps.length} maps: ${totalBlocked} blocked, ${totalImpassable} impassable, ${totalScoring} scoring.`,
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll generated maps pass the Phase 4 smoke test.");
}
