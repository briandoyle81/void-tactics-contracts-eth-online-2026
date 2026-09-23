// One-off: dumps every generated map (sparse form, real roster-sized AI
// formations) plus its spec metadata into a single compact JSON file for
// the map-gallery artifact to embed. Not part of the Phase 7 pipeline
// itself -- purely a rendering convenience.
//
// Run with: npx hardhat run scripts/map-design/export-gallery-data.ts

import * as fs from "fs";
import * as path from "path";
import { buildDifficultyTable, SlotSpec } from "./difficulty-table";
import { generateAllMaps, generateFormationPositions } from "./generate-map";

interface ExistingMapPlacement {
  mapKey: string;
  configKeys: string[];
}
interface ExistingContent {
  mapPlacements: ExistingMapPlacement[];
}

const DATA_DIR = path.join(__dirname, "..", "..", "ignition", "data");
function loadRosterSizes(): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const file of ["singlePlayerStarterContent.json", "roguelikeStarterContent.json"]) {
    const content: ExistingContent = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, file), "utf8"),
    );
    for (const p of content.mapPlacements) sizes.set(p.mapKey, p.configKeys.length);
  }
  return sizes;
}

// A roguelike-dedicated key ("rlM04") standing in for a campaign key
// ("m04") -- undefined for anything that isn't "rl"+CapitalizedKey shaped.
// Mirrors prepare-content.ts's campaignCounterpartKey.
function campaignCounterpartKey(key: string): string | undefined {
  if (!key.startsWith("rl") || key.length < 3) return undefined;
  const rest = key.slice(2);
  return rest[0].toLowerCase() + rest.slice(1);
}

function rosterSizeFor(key: string, sizes: Map<string, number>): number {
  if (sizes.has(key)) return sizes.get(key)!;
  const counterpart = campaignCounterpartKey(key);
  if (counterpart && sizes.has(counterpart)) return sizes.get(counterpart)!;
  return 0;
}

const table = buildDifficultyTable();
const specByKey = new Map<string, SlotSpec>(table.map((s) => [s.key, s]));
const maps = generateAllMaps(table);
const rosterSizes = loadRosterSizes();

const out = maps.map((map) => {
  const spec = specByKey.get(map.key!)!;
  const rosterSize = spec.mode === "PvE" ? rosterSizeFor(map.key!, rosterSizes) : 0;
  const formation =
    spec.mode === "PvE" && rosterSize > 0
      ? generateFormationPositions(spec, map, rosterSize)
      : [];
  return {
    key: map.key,
    name: map.name,
    mode: map.mode,
    archetype: spec.archetype,
    symmetryMode: spec.symmetryMode,
    balanceIntent: spec.balanceIntent,
    formation: spec.formation,
    zoneShape: spec.zoneShape,
    rosterSize,
    blocked: map.blockedTiles,
    impassable: map.impassableTiles,
    scoring: map.scoringTiles,
    creatorZone: map.creatorZone,
    joinerZone: map.joinerZone,
    formationPositions: formation,
  };
});

const outPath = path.join(__dirname, "out", "gallery-data.json");
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`Wrote ${out.length} maps to ${outPath} (${fs.statSync(outPath).size} bytes)`);
