// Phase 7 step 4: writes the reviewed map set into the real ignition data
// files. Source of truth is the SAME generation pipeline the gallery/
// prepare-content.ts used (buildDifficultyTable + generateAllMaps +
// generateFormationPositions) -- nothing here is hand-transcribed, so the
// output is guaranteed to match what was actually reviewed.
//
// What this script does:
//  - singlePlayerStarterContent.json: the 30 existing campaign map entries
//    get their blockedTiles/impassableTiles/scoringTiles/name/creatorZone/
//    joinerZone replaced with the generated content; their mapPlacements
//    get new `positions` (same `configKeys` roster, unchanged -- only
//    terrain and layout change, never roster composition, per the plan's
//    explicit "not touched" list).
//  - roguelikeStarterContent.json: `maps` is rebuilt to 30 entries (rlM01-
//    15/rlD01-06/rlS01-03/rlF01-06), each dedicated (no more sharing a
//    campaign map's data). `mapPlacements` gets one entry per rl* key: the
//    5 already-dedicated ones keep their existing configKeys roster; the 25
//    new ones copy their campaign counterpart's roster. `nodes[].mapKey` is
//    set uniformly to "rl"+Capitalize(node.key) for every Combat node (this
//    already matches the 5 pre-existing dedicated nodes' mapKey exactly, so
//    the same formula covers both "was already dedicated" and "newly
//    dedicated" with no special-casing).
//  - ignition/data/pvpStarterContent.json (NEW FILE): the 5 PvP maps
//    (pvp01-05), not attached to any node graph -- no mapPlacements (no AI
//    ships in PvP).
//
// Does NOT touch: campaign/roguelike graph topology (edges, prerequisites,
// costLimit/turnTime/maxScore), AIEncounters rosters (which configKeys a
// slot uses), aiShipConfigs/aiShipColors. Run with:
//   npx hardhat run scripts/map-design/write-content.ts
// Re-run prepare-content.ts and the test suite afterward.

import * as fs from "fs";
import * as path from "path";
import { buildDifficultyTable, SlotSpec } from "./difficulty-table";
import { generateAllMaps, generateFormationPositions } from "./generate-map";
import { Position } from "./archetypes";
import { ScoringPosition } from "./scoring";
import { SparseMap } from "./dense-grid-format";

const DATA_DIR = path.join(__dirname, "..", "..", "ignition", "data");

interface MapEntry {
  key: string;
  name: string;
  mode: string;
  type: string;
  blockedTiles: Position[];
  impassableTiles: Position[];
  scoringTiles: ScoringPosition[];
  creatorZone: Position[];
  joinerZone: Position[];
}

interface Placement {
  mapKey: string;
  positions: Position[];
  configKeys: string[];
}

function toMapEntry(map: SparseMap, spec: SlotSpec): MapEntry {
  return {
    key: map.key!,
    name: map.name!,
    mode: spec.mode,
    type: "full",
    blockedTiles: map.blockedTiles,
    impassableTiles: map.impassableTiles,
    scoringTiles: map.scoringTiles,
    creatorZone: map.creatorZone,
    joinerZone: map.joinerZone,
  };
}

function campaignCounterpartKey(key: string): string | undefined {
  if (!key.startsWith("rl") || key.length < 3) return undefined;
  const rest = key.slice(2);
  return rest[0].toLowerCase() + rest.slice(1);
}

function writeJSON(file: string, data: unknown) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2) + "\n");
}

// ---- build everything from the pipeline ----

const table = buildDifficultyTable();
const specByKey = new Map<string, SlotSpec>(table.map((s) => [s.key, s]));
const maps = generateAllMaps(table);
const mapByKey = new Map<string, SparseMap>(maps.map((m) => [m.key!, m]));

// ---- singlePlayerStarterContent.json ----

const spPath = path.join(DATA_DIR, "singlePlayerStarterContent.json");
const sp = JSON.parse(fs.readFileSync(spPath, "utf8"));

sp.maps = sp.maps.map((entry: MapEntry) => {
  const generated = mapByKey.get(entry.key);
  const spec = specByKey.get(entry.key);
  if (!generated || !spec) {
    throw new Error(`singlePlayerStarterContent.json map "${entry.key}" has no generated counterpart`);
  }
  return toMapEntry(generated, spec);
});

for (const placement of sp.mapPlacements as Placement[]) {
  const generated = mapByKey.get(placement.mapKey);
  const spec = specByKey.get(placement.mapKey);
  if (!generated || !spec) {
    throw new Error(`singlePlayerStarterContent.json mapPlacement "${placement.mapKey}" has no generated counterpart`);
  }
  const rosterSize = placement.configKeys.length;
  const positions = generateFormationPositions(spec, generated, rosterSize);
  if (positions.length !== rosterSize) {
    throw new Error(`${placement.mapKey}: generated ${positions.length} formation positions, need ${rosterSize}`);
  }
  placement.positions = positions;
}

writeJSON("singlePlayerStarterContent.json", sp);
console.log(`Updated ${sp.maps.length} campaign maps and ${sp.mapPlacements.length} placements in singlePlayerStarterContent.json`);

// ---- roguelikeStarterContent.json ----

const rlPath = path.join(DATA_DIR, "roguelikeStarterContent.json");
const rl = JSON.parse(fs.readFileSync(rlPath, "utf8"));

const BRANCH_ORDER: Record<string, number> = { m: 0, d: 1, s: 2, f: 3 };
function rlSortKey(key: string): [number, number] {
  // "rlM04" -> branch 'm', number 4
  const branch = key[2].toLowerCase();
  const num = parseInt(key.slice(3), 10);
  return [BRANCH_ORDER[branch] ?? 9, num];
}

const rlKeys = table
  .filter((s) => s.key.startsWith("rl"))
  .map((s) => s.key)
  .sort((a, b) => {
    const [ba, na] = rlSortKey(a);
    const [bb, nb] = rlSortKey(b);
    return ba - bb || na - nb;
  });

const existingRlPlacementByKey = new Map<string, Placement>(
  (rl.mapPlacements as Placement[]).map((p) => [p.mapKey, p]),
);

rl.maps = rlKeys.map((key) => {
  const generated = mapByKey.get(key)!;
  const spec = specByKey.get(key)!;
  return toMapEntry(generated, spec);
});

rl.mapPlacements = rlKeys.map((key) => {
  const generated = mapByKey.get(key)!;
  const spec = specByKey.get(key)!;
  const existing = existingRlPlacementByKey.get(key);
  let configKeys: string[];
  if (existing) {
    configKeys = existing.configKeys;
  } else {
    const counterpart = campaignCounterpartKey(key)!;
    const counterpartPlacement = (sp.mapPlacements as Placement[]).find((p) => p.mapKey === counterpart);
    if (!counterpartPlacement) {
      throw new Error(`${key}: no existing roster and no campaign counterpart "${counterpart}" found`);
    }
    configKeys = counterpartPlacement.configKeys;
  }
  const positions = generateFormationPositions(spec, generated, configKeys.length);
  if (positions.length !== configKeys.length) {
    throw new Error(`${key}: generated ${positions.length} formation positions, need ${configKeys.length}`);
  }
  return { mapKey: key, positions, configKeys };
});

// Every Combat node now points at its own dedicated map -- this formula
// already matches the 5 pre-existing dedicated nodes' mapKey exactly
// (node.key "m01" -> "rlM01"), so it uniformly covers both "was already
// dedicated" and "newly dedicated" with no special-casing.
for (const node of rl.nodes) {
  if (node.kind !== "Combat") continue;
  node.mapKey = "rl" + node.key[0].toUpperCase() + node.key.slice(1);
}

writeJSON("roguelikeStarterContent.json", rl);
console.log(`Updated roguelikeStarterContent.json: ${rl.maps.length} dedicated maps, ${rl.mapPlacements.length} placements, ${rl.nodes.filter((n: any) => n.kind === "Combat").length} Combat nodes repointed`);

// ---- pvpStarterContent.json (new file) ----

const pvpKeys = table.filter((s) => s.mode === "PvP").map((s) => s.key);
const pvp = {
  maps: pvpKeys.map((key) => toMapEntry(mapByKey.get(key)!, specByKey.get(key)!)),
};
writeJSON("pvpStarterContent.json", pvp);
console.log(`Wrote pvpStarterContent.json: ${pvp.maps.length} PvP maps`);
