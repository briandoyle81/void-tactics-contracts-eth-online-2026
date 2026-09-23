// Round-trips the real exemplar-pvp-map.json through denseToSparse ->
// sparseToDense and checks the result matches the original (modulo the new
// optional fields the exemplar predates), plus re-verifies the exemplar's
// hand-checked 180-degree rotational symmetry programmatically.
//
// Run with: npx hardhat run scripts/map-design/dense-grid-format.selfcheck.ts

import * as fs from "fs";
import * as path from "path";
import { denseToSparse, sparseToDense, DenseMapFile } from "./dense-grid-format";
import { GRID_HEIGHT, GRID_WIDTH } from "./los";

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) {
    failures++;
    console.error(`FAIL: ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const exemplarPath = path.join(__dirname, "..", "..", "exemplar-pvp-map.json");
const exemplar: DenseMapFile = JSON.parse(fs.readFileSync(exemplarPath, "utf8"));

check(
  "exemplar grid is 17x11",
  exemplar.gridDimensions.WIDTH === GRID_WIDTH &&
    exemplar.gridDimensions.HEIGHT === GRID_HEIGHT,
);

// ---- round-trip ----
const sparse = denseToSparse(exemplar);
const roundTripped = sparseToDense(sparse, {
  createdBy: exemplar.metadata.createdBy,
  createdAt: exemplar.metadata.createdAt,
});

check(
  "blockedTiles round-trips exactly",
  JSON.stringify(roundTripped.blockedTiles) ===
    JSON.stringify(exemplar.blockedTiles),
);
check(
  "scoringTiles round-trips exactly",
  JSON.stringify(roundTripped.scoringTiles) ===
    JSON.stringify(exemplar.scoringTiles),
);
check(
  "onlyOnceTiles round-trips exactly",
  JSON.stringify(roundTripped.onlyOnceTiles) ===
    JSON.stringify(exemplar.onlyOnceTiles),
);
check(
  "impassableTiles defaults to all-empty (exemplar predates the field)",
  sparse.impassableTiles.length === 0,
);
check(
  "deployment zones default to empty (exemplar predates the field)",
  sparse.creatorZone.length === 0 && sparse.joinerZone.length === 0,
);

// ---- exemplar's rotational (180-degree) symmetry, re-verified programmatically ----
let blockedAsymmetric = 0;
for (let row = 0; row < GRID_HEIGHT; row++) {
  for (let col = 0; col < GRID_WIDTH; col++) {
    const mirrored = exemplar.blockedTiles[GRID_HEIGHT - 1 - row][GRID_WIDTH - 1 - col];
    if (exemplar.blockedTiles[row][col] !== mirrored) blockedAsymmetric++;
  }
}
check("exemplar's blocked tiles are exactly 180-degree rotationally symmetric", blockedAsymmetric === 0);

let scoringAsymmetric = 0;
for (let row = 0; row < GRID_HEIGHT; row++) {
  for (let col = 0; col < GRID_WIDTH; col++) {
    const mirrored = exemplar.scoringTiles[GRID_HEIGHT - 1 - row][GRID_WIDTH - 1 - col];
    if (exemplar.scoringTiles[row][col] !== mirrored) scoringAsymmetric++;
  }
}
check("exemplar's scoring tiles are exactly 180-degree rotationally symmetric", scoringAsymmetric === 0);

check(
  "exemplar is NOT simple left-right mirror symmetric (confirms it's genuinely radial, not vertical)",
  exemplar.blockedTiles[0][0] !== exemplar.blockedTiles[0][GRID_WIDTH - 1],
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log("\ndense-grid-format.ts round-trips the exemplar correctly.");
}
