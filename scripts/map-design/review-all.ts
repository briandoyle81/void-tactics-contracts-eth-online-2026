// Phase 5 verification runner: generates every slot, places a (placeholder-
// roster-size) AI formation for PvE maps, validates every one, prints a
// summary, exports every map as a dense-grid JSON file for the real Map
// Editor tool, and prints a full ASCII preview for one representative slot
// per archetype (the plan's "eyeball >=1 preview per archetype" step).
//
// Roster sizes here are a PLACEHOLDER (4 ships) -- real sizes come from
// each map's existing AIEncounters roster and are only known at Phase 7's
// migration step, which calls generateFormationPositions directly with the
// real count instead of using this script.
//
// Run with: npx hardhat run scripts/map-design/review-all.ts

import * as path from "path";
import { buildDifficultyTable, SlotSpec } from "./difficulty-table";
import { generateAllMaps, generateFormationPositions, EXEMPLAR_KEY } from "./generate-map";
import { validateMap } from "./validate-map";
import { renderAscii, exportDenseGridFile } from "./preview";
import { sparseToDense } from "./dense-grid-format";
import { ArchetypeName } from "./archetypes";

const PLACEHOLDER_ROSTER_SIZE = 4;
const OUT_DIR = path.join(__dirname, "out");

const table = buildDifficultyTable();
const specByKey = new Map<string, SlotSpec>(table.map((s) => [s.key, s]));
const maps = generateAllMaps(table);

let totalErrors = 0;
let totalWarnings = 0;
const seenArchetypes = new Set<ArchetypeName>();
const previewedArchetypes = new Set<ArchetypeName>();

for (const map of maps) {
  const spec = specByKey.get(map.key!)!;
  const formation =
    spec.mode === "PvE"
      ? generateFormationPositions(spec, map, PLACEHOLDER_ROSTER_SIZE)
      : [];

  const result = validateMap(map, spec, formation);
  const errors = result.issues.filter((i) => i.severity === "error");
  const warnings = result.issues.filter((i) => i.severity === "warning");
  totalErrors += errors.length;
  totalWarnings += warnings.length;

  const status = errors.length > 0 ? "FAIL" : "ok  ";
  console.log(
    `${status} ${map.key} (${spec.archetype}/${spec.symmetryMode}/${spec.balanceIntent}) — ` +
      `${map.blockedTiles.length} blocked, ${map.impassableTiles.length} impassable, ` +
      `${map.scoringTiles.length} scoring, sightline ${(result.sightlineProfile * 100).toFixed(0)}%`,
  );
  for (const issue of result.issues) {
    console.log(`     [${issue.severity}] ${issue.message}`);
  }

  // Export every map as a dense-grid file for the real editor.
  const dense = sparseToDense(map, {
    createdBy: map.key === EXEMPLAR_KEY ? "Map Editor" : "map-design generator",
  });
  exportDenseGridFile(OUT_DIR, map.key!, dense);

  // Print a full ASCII preview for the first slot seen of each archetype.
  seenArchetypes.add(spec.archetype);
  if (!previewedArchetypes.has(spec.archetype)) {
    previewedArchetypes.add(spec.archetype);
    console.log("\n" + renderAscii(map, formation) + "\n");
  }
}

console.log(
  `\n${maps.length} maps reviewed. ${totalErrors} error(s), ${totalWarnings} warning(s).`,
);
console.log(`Archetypes previewed: ${[...previewedArchetypes].join(", ")}`);
console.log(`Dense-grid exports written to ${OUT_DIR}`);

if (totalErrors > 0) {
  console.error("\nFAIL: one or more maps failed validation.");
  process.exit(1);
} else {
  console.log("\nAll maps pass validation.");
}
