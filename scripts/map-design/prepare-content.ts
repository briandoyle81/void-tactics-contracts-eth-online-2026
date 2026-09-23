// Phase 7 step 1-3: generates every slot with REAL AI roster sizes (read
// from the existing ignition/data/*.json mapPlacements, not Phase 5's
// placeholder count of 4), validates everything, and re-exports the full
// dense-grid review set to scripts/map-design/out/ for the human
// sign-off checkpoint.
//
// This script deliberately does NOT write to ignition/data/*.json or
// ignition/modules/DeployAndConfig.ts -- that's Phase 7 step 4, which only
// happens after the person reviewing these exports (in the real Map Editor
// tool, or via the printed ASCII previews) says to proceed.
//
// Run with: npx hardhat run scripts/map-design/prepare-content.ts

import * as fs from "fs";
import * as path from "path";
import { buildDifficultyTable, SlotSpec } from "./difficulty-table";
import { generateAllMaps, generateFormationPositions, EXEMPLAR_KEY } from "./generate-map";
import { validateMap } from "./validate-map";
import { renderAscii, exportDenseGridFile } from "./preview";
import { sparseToDense, SparseMap } from "./dense-grid-format";
import { ArchetypeName } from "./archetypes";

const OUT_DIR = path.join(__dirname, "out");
const DATA_DIR = path.join(__dirname, "..", "..", "ignition", "data");

interface ExistingMapPlacement {
  mapKey: string;
  positions: { row: number; col: number }[];
  configKeys: string[];
}
interface ExistingContent {
  maps: { key: string }[];
  mapPlacements: ExistingMapPlacement[];
}

function loadExistingRosterSizes(): Map<string, number> {
  const files = ["singlePlayerStarterContent.json", "roguelikeStarterContent.json"];
  const sizes = new Map<string, number>();
  for (const file of files) {
    const content: ExistingContent = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, file), "utf8"),
    );
    for (const placement of content.mapPlacements) {
      sizes.set(placement.mapKey, placement.configKeys.length);
    }
  }
  return sizes;
}

function loadExistingKeyOrder(): { campaign: string[]; roguelike: string[] } {
  const campaign: ExistingContent = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, "singlePlayerStarterContent.json"), "utf8"),
  );
  const roguelike: ExistingContent = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, "roguelikeStarterContent.json"), "utf8"),
  );
  return {
    campaign: campaign.maps.map((m) => m.key),
    roguelike: roguelike.maps.map((m) => m.key),
  };
}

const table = buildDifficultyTable();
const specByKey = new Map<string, SlotSpec>(table.map((s) => [s.key, s]));
const maps = generateAllMaps(table);
const rosterSizes = loadExistingRosterSizes();
const existingOrder = loadExistingKeyOrder();

// A roguelike-dedicated key ("rlM04") standing in for a campaign key
// ("m04") -- undefined for anything that isn't "rl"+CapitalizedKey shaped.
function campaignCounterpartKey(key: string): string | undefined {
  if (!key.startsWith("rl") || key.length < 3) return undefined;
  const rest = key.slice(2);
  return rest[0].toLowerCase() + rest.slice(1);
}

// Same roster as the campaign slot a roguelike-dedicated map stands in for
// (design intent: identical pacing/difficulty, different terrain) -- falls
// back to the counterpart's roster only when this key has no placement of
// its own yet (the 5 already-dedicated rl* maps already have one each).
function rosterSizeFor(key: string): number {
  if (rosterSizes.has(key)) return rosterSizes.get(key)!;
  const counterpart = campaignCounterpartKey(key);
  if (counterpart && rosterSizes.has(counterpart)) return rosterSizes.get(counterpart)!;
  return 0;
}

// ---- key-set cross-check against the existing JSON (order + membership) ----
//
// Only checked for keys ALREADY in the real JSON -- a table key with no
// existing-JSON counterpart is a pending new slot (expected mid-pass, e.g.
// the 2026-09-23 "dedicated roguelike maps" extension), not a corruption.
// Order/membership among the already-shipped keys is still checked exactly,
// since that's what protects Ignition's array-position id guessing.

const tableKeys = table.filter((s) => s.mode === "PvE").map((s) => s.key);
const existingPveKeys = [...existingOrder.campaign, ...existingOrder.roguelike];
const existingPveKeySet = new Set(existingPveKeys);
const tableKeysAlreadyInJson = tableKeys.filter((k) => existingPveKeySet.has(k));
const newTableKeys = tableKeys.filter((k) => !existingPveKeySet.has(k));

let keyMismatch = false;
if (JSON.stringify(tableKeysAlreadyInJson) !== JSON.stringify(existingPveKeys)) {
  keyMismatch = true;
  console.error("KEY ORDER/SET MISMATCH for keys already shipped in the existing JSON:");
  console.error("  difficulty-table.ts order:", tableKeysAlreadyInJson.join(", "));
  console.error("  existing JSON order:      ", existingPveKeys.join(", "));
} else {
  console.log(`Key order matches the existing JSON exactly for all ${tableKeysAlreadyInJson.length} already-shipped PvE slots.`);
}
if (newTableKeys.length > 0) {
  console.log(`${newTableKeys.length} new PvE slot(s) not yet in ignition/data/*.json (pending this pass): ${newTableKeys.join(", ")}\n`);
} else {
  console.log();
}

// ---- roster-size cross-check (flag, don't silently change) ----

for (const key of tableKeys) {
  if (rosterSizeFor(key) === 0) {
    console.warn(`WARNING: no roster found for ${key} (no placement of its own and no campaign counterpart) -- skipping formation.`);
  }
}

// ---- generate + validate + export ----

let totalErrors = 0;
let totalWarnings = 0;
const previewedArchetypes = new Set<ArchetypeName>();
const rosterReport: { key: string; archetype: ArchetypeName; formation: string; rosterSize: number }[] = [];

for (const map of maps) {
  const spec = specByKey.get(map.key!)!;
  const rosterSize = spec.mode === "PvE" ? rosterSizeFor(map.key!) : 0;
  const formation =
    spec.mode === "PvE" && rosterSize > 0
      ? generateFormationPositions(spec, map, rosterSize)
      : [];

  if (spec.mode === "PvE") {
    rosterReport.push({ key: map.key!, archetype: spec.archetype, formation: spec.formation, rosterSize });
  }

  const result = validateMap(map, spec, formation);
  const errors = result.issues.filter((i) => i.severity === "error");
  const warnings = result.issues.filter((i) => i.severity === "warning");
  totalErrors += errors.length;
  totalWarnings += warnings.length;

  const status = errors.length > 0 ? "FAIL" : "ok  ";
  console.log(
    `${status} ${map.key} (${spec.archetype}/${spec.symmetryMode}/${spec.balanceIntent}, roster ${rosterSize}) — ` +
      `${map.blockedTiles.length} blocked, ${map.impassableTiles.length} impassable, ` +
      `${map.scoringTiles.length} scoring, sightline ${(result.sightlineProfile * 100).toFixed(0)}%`,
  );
  for (const issue of result.issues) {
    console.log(`     [${issue.severity}] ${issue.message}`);
  }

  const dense = sparseToDense(map, {
    createdBy: map.key === EXEMPLAR_KEY ? "Map Editor" : "map-design generator",
  });
  exportDenseGridFile(OUT_DIR, map.key!, dense);

  if (!previewedArchetypes.has(spec.archetype)) {
    previewedArchetypes.add(spec.archetype);
    console.log("\n" + renderAscii(map, formation) + "\n");
  }
}

console.log("\n--- Roster/formation summary (real counts from existing JSON) ---");
for (const r of rosterReport) {
  console.log(`  ${r.key.padEnd(6)} ${r.archetype.padEnd(14)} ${r.formation.padEnd(8)} roster ${r.rosterSize}`);
}

console.log(
  `\n${maps.length} maps prepared (${rosterReport.length} PvE + ${maps.length - rosterReport.length} PvP). ` +
    `${totalErrors} error(s), ${totalWarnings} warning(s). Key order match: ${!keyMismatch}.`,
);
console.log(`Dense-grid exports written to ${OUT_DIR} -- open these in the Map Editor tool to review.`);
console.log(
  "\nNOTHING has been written to ignition/data/*.json or DeployAndConfig.ts yet " +
    "-- that only happens after this output is reviewed and signed off.",
);

if (totalErrors > 0 || keyMismatch) {
  process.exit(1);
}
