// Entry point tying archetypes.ts (terrain) + scoring.ts (objectives) +
// difficulty-table.ts (per-slot parameters) together into the full sparse
// map shape ignition/data/*.json's `maps` entries use.

import * as fs from "fs";
import * as path from "path";
import { generateArchetype } from "./archetypes";
import { placeScoring } from "./scoring";
import { SlotSpec } from "./difficulty-table";
import { placeFormation, Position } from "./formations";
import { denseToSparse, DenseMapFile, SparseMap } from "./dense-grid-format";

// pvp04 isn't generated -- it's exemplar-pvp-map.json itself, imported
// through the dense-grid converter (Phase 3) rather than procedurally
// built, since it's a hand-built, already-confirmed-balanced reference the
// person supplying this task gave us directly. It predates impassable
// terrain and deployment zones, so both come back empty (Maps.sol falls
// back to the engine default zone, and there's simply no impassable data
// to add without second-guessing a map we were told is already good).
const EXEMPLAR_KEY = "pvp04";

function loadExemplarAsSparseMap(): SparseMap {
  const exemplarPath = path.join(__dirname, "..", "..", "exemplar-pvp-map.json");
  const dense: DenseMapFile = JSON.parse(fs.readFileSync(exemplarPath, "utf8"));
  const sparse = denseToSparse(dense);
  return {
    ...sparse,
    key: EXEMPLAR_KEY,
    name: dense.metadata.name && dense.metadata.name !== "New Map"
      ? dense.metadata.name
      : "Exemplar Contract — Open Field",
    mode: "PvP",
  };
}

export function generateMap(spec: SlotSpec): SparseMap {
  const terrain = generateArchetype({
    key: spec.key,
    archetype: spec.archetype,
    symmetryMode: spec.symmetryMode,
    balanceIntent: spec.balanceIntent,
    params: spec.params,
    zoneShape: spec.zoneShape,
  });
  const scoringTiles = placeScoring(terrain, spec.symmetryMode, spec.scoring);

  return {
    key: spec.key,
    name: spec.name,
    mode: spec.mode,
    blockedTiles: terrain.blocked,
    impassableTiles: terrain.impassable,
    scoringTiles,
    creatorZone: terrain.creatorZone,
    joinerZone: terrain.joinerZone,
  };
}

// Generates every slot in the difficulty table, substituting the imported
// exemplar for EXEMPLAR_KEY instead of generating it.
export function generateAllMaps(table: SlotSpec[]): SparseMap[] {
  return table.map((spec) =>
    spec.key === EXEMPLAR_KEY ? loadExemplarAsSparseMap() : generateMap(spec),
  );
}

// AI fleet spawn positions for a slot, in its formation shape, within its
// joiner deployment zone (custom, if the generated map has one — none do
// today — or the engine default). Roster SIZE is not something map-design
// generates; it comes from the existing per-map AIEncounters roster (see
// ignition/data/*.json's `mapPlacements`), which Phase 7's migration step
// reads and passes in here unchanged.
export function generateFormationPositions(
  spec: SlotSpec,
  map: SparseMap,
  rosterSize: number,
): Position[] {
  return placeFormation(spec.formation, rosterSize, map.joinerZone);
}

export { EXEMPLAR_KEY, loadExemplarAsSparseMap };
