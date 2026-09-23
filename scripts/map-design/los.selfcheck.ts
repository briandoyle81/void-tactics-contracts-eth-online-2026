// Fixture cross-check for los.ts's port of Maps.sol's LOS/movement-path
// walk. Every hasLineOfSight case here is copied from a passing assertion
// in test/Maps.test.ts (same coordinates, same blocked tiles, same expected
// result) so a porting bug shows up here before it silently corrupts every
// generated map's sightline-profile metric. hasMovementPath cases mirror
// this session's new test/Maps.test.ts "Impassable Terrain / Movement Path"
// tests the same way.
//
// Run with: npx hardhat run scripts/map-design/los.selfcheck.ts
// (uses Hardhat's ts-node registration; no Hardhat runtime/network needed.)

import { emptyGrid, hasLineOfSight, hasMovementPath, TileGrid } from "./los";

let failures = 0;

function grid(blocked: [number, number][]): TileGrid {
  const g = emptyGrid();
  for (const [row, col] of blocked) g[row][col] = true;
  return g;
}

function checkLOS(
  name: string,
  blocked: [number, number][],
  row0: number,
  col0: number,
  row1: number,
  col1: number,
  expected: boolean,
) {
  const actual = hasLineOfSight(grid(blocked), row0, col0, row1, col1);
  if (actual !== expected) {
    failures++;
    console.error(
      `FAIL hasLineOfSight: ${name} — expected ${expected}, got ${actual}`,
    );
  } else {
    console.log(`ok   hasLineOfSight: ${name}`);
  }
}

function checkPath(
  name: string,
  impassable: [number, number][],
  row0: number,
  col0: number,
  row1: number,
  col1: number,
  expected: boolean,
) {
  const actual = hasMovementPath(grid(impassable), row0, col0, row1, col1);
  if (actual !== expected) {
    failures++;
    console.error(
      `FAIL hasMovementPath: ${name} — expected ${expected}, got ${actual}`,
    );
  } else {
    console.log(`ok   hasMovementPath: ${name}`);
  }
}

// ---- hasLineOfSight — copied from test/Maps.test.ts ----

checkLOS("clear LOS on horizontal line", [], 5, 2, 5, 8, true);
checkLOS("clear LOS on vertical line", [], 2, 5, 8, 5, true);
checkLOS("clear LOS on diagonal line", [], 2, 2, 6, 6, true);
checkLOS("clear LOS on same position", [], 5, 5, 5, 5, true);

checkLOS(
  "blocked by single obstacle on horizontal line",
  [[5, 5]],
  5,
  2,
  5,
  8,
  false,
);
checkLOS(
  "blocked by single obstacle on vertical line",
  [[5, 5]],
  2,
  5,
  8,
  5,
  false,
);
checkLOS(
  "blocked by single obstacle on diagonal line",
  [[4, 4]],
  2,
  2,
  6,
  6,
  false,
);

checkLOS(
  "permissive corner — single flanker blocked stays clear",
  [[3, 2]],
  2,
  2,
  4,
  4,
  true,
);
checkLOS(
  "permissive corner — both flankers blocked blocks LOS",
  [
    [3, 2],
    [2, 3],
  ],
  2,
  2,
  4,
  4,
  false,
);

checkLOS("steep diagonal line stays clear", [], 1, 1, 8, 2, true);
checkLOS("shallow diagonal line stays clear", [], 1, 1, 2, 8, true);

// ---- hasMovementPath — mirrors this session's new Maps.test.ts cases ----

checkPath("clear with no impassable tiles", [], 5, 2, 5, 8, true);
checkPath("blocks landing ON an impassable destination", [[5, 8]], 5, 2, 5, 8, false);
checkPath(
  "blocks passing THROUGH an impassable cell strictly between start/end",
  [[5, 5]],
  5,
  2,
  5,
  8,
  false,
);
checkPath(
  "NOT blocked by an impassable tile adjacent but off the line",
  [[4, 5]],
  5,
  2,
  5,
  8,
  true,
);
checkPath(
  "a ship may always leave a tile that is itself impassable",
  [[5, 2]],
  5,
  2,
  5,
  8,
  true,
);
checkPath("staying on the same tile is always clear", [[5, 5]], 5, 5, 5, 5, true);

if (failures > 0) {
  console.error(`\n${failures} fixture(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll los.ts fixtures match Maps.sol's on-chain behavior.");
}
