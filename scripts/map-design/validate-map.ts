// The real validator (Phase 5) — runs every check Phase 0/4's design
// principles call for against a generated (or hand-imported) map, before
// it's ever allowed into Phase 7's human-review/JSON-migration step.
//
// A note on the "lane" checks: this game has no real pathfinding on-chain
// (movement is a straight-line budget, not a routed path — see
// contracts/Maps.sol's hasMovementPath) so "is there a lane here" can only
// ever be approximated offline, not proven against the actual game rules.
// Two checks, both documented as approximations:
//   - fullyOpenLaneRows: an exact count for row-lane archetypes (Asteroid
//     Field, Trench Run, Twin Pillars build lanes as literal free rows).
//   - coreConnected: a 4-directional flood-fill over non-impassable cells,
//     used as a general (conservative, not exact) sanity check for every
//     archetype, including the ring/blob ones whose lanes are angular gaps
//     rather than free rows.

import {
  CENTER_COL,
  CENTER_ROW,
  CORE_MAX_COL,
  CORE_MIN_COL,
  mirrorFor,
} from "./archetypes";
import { GRID_HEIGHT, GRID_WIDTH, hasLineOfSight, TileGrid, emptyGrid } from "./los";
import { SlotSpec } from "./difficulty-table";
import { SparseMap } from "./dense-grid-format";
import { Position } from "./formations";

export interface Issue {
  severity: "error" | "warning";
  message: string;
}

export interface ValidationResult {
  key: string;
  issues: Issue[];
  // Fraction of sampled core cell-pairs with clear LOS beyond range 1 —
  // feeds Phase 6's balance-sim correlation and is a useful per-difficulty
  // sanity check on its own (should trend down as difficulty rises).
  sightlineProfile: number;
}

function positionKey(p: Position): string {
  return `${p.row},${p.col}`;
}

function toGrid(positions: Position[]): TileGrid {
  const grid = emptyGrid();
  for (const p of positions) grid[p.row][p.col] = true;
  return grid;
}

// ---- symmetry ----

function checkSymmetry(map: SparseMap, spec: SlotSpec, issues: Issue[]) {
  if (spec.symmetryMode === "none") {
    checkImbalanceDirection(map, spec, issues);
    return;
  }
  const mirror = mirrorFor(spec.symmetryMode);
  for (const [label, positions] of [
    ["blocked", map.blockedTiles],
    ["impassable", map.impassableTiles],
  ] as const) {
    const set = new Set(positions.map(positionKey));
    for (const p of positions) {
      const m = mirror(p.row, p.col);
      if (!set.has(positionKey(m))) {
        issues.push({
          severity: "error",
          message: `${label} tile (${p.row},${p.col}) has no mirror at (${m.row},${m.col}) under ${spec.symmetryMode} symmetry`,
        });
      }
    }
  }
}

// For a deliberately imbalanced ("none") map, checks that the favored
// side (per balanceIntent) actually ended up MORE COVERED than the
// disadvantaged side — this should always hold given how skewedParams
// works in archetypes.ts, so a violation here means a real generator bug,
// not RNG noise.
//
// Compares DENSITY (cover cells / cells in that side's territory), not raw
// counts: attacker territory is cols 4-8 (CENTER_COL is generator-side
// "attacker" ground) and defender is cols 9-12 -- 5 columns vs 4, an
// intentional asymmetry from CENTER_COL living in the attacker's range,
// nothing to do with the difficulty skew. Raw counts let that width
// difference mask (or even invert) a real, correctly-applied skew for
// archetypes that fill most of their territory regardless of density
// (Trench Run) -- found via this exact check during Phase 5 review.
function checkImbalanceDirection(map: SparseMap, spec: SlotSpec, issues: Issue[]) {
  if (spec.balanceIntent === "fair") return;
  const attackerFavored = spec.balanceIntent === "favorAttacker";
  let attackerCover = 0;
  let defenderCover = 0;
  for (const p of [...map.blockedTiles, ...map.impassableTiles]) {
    if (p.col <= CENTER_COL) attackerCover++;
    else defenderCover++;
  }
  const attackerCells = (CENTER_COL - CORE_MIN_COL + 1) * GRID_HEIGHT;
  const defenderCells = (CORE_MAX_COL - CENTER_COL) * GRID_HEIGHT;
  const attackerDensity = attackerCover / attackerCells;
  const defenderDensity = defenderCover / defenderCells;
  const favoredDensity = attackerFavored ? attackerDensity : defenderDensity;
  const disfavoredDensity = attackerFavored ? defenderDensity : attackerDensity;
  if (favoredDensity <= disfavoredDensity) {
    issues.push({
      severity: "error",
      message:
        `${spec.balanceIntent}: favored side density ${(favoredDensity * 100).toFixed(1)}%, ` +
        `disfavored side density ${(disfavoredDensity * 100).toFixed(1)}% — imbalance did not apply in the intended direction`,
    });
  }
}

// ---- deployment zone shape (2026-09-23 custom-zone pass) ----

// creatorZone must be exactly the mirror of joinerZone under the SAME
// transform archetypes.ts's buildZones used to generate it (vertical, for
// "none"/imbalanced maps, regardless of the terrain's own symmetryMode --
// deployment fairness is kept independent of terrain fairness). An empty
// zone (both sides) means "use the engine default" and needs no check.
function checkZoneMirror(map: SparseMap, spec: SlotSpec, issues: Issue[]) {
  if (map.creatorZone.length === 0 && map.joinerZone.length === 0) return;
  const mirror = mirrorFor(spec.symmetryMode === "none" ? "vertical" : spec.symmetryMode);
  const creatorSet = new Set(map.creatorZone.map(positionKey));
  for (const p of map.joinerZone) {
    const m = mirror(p.row, p.col);
    if (!creatorSet.has(positionKey(m))) {
      issues.push({
        severity: "error",
        message: `joiner zone tile (${p.row},${p.col}) has no mirror at (${m.row},${m.col}) in the creator zone`,
      });
    }
  }
  if (map.creatorZone.length !== map.joinerZone.length) {
    issues.push({
      severity: "error",
      message: `creator zone (${map.creatorZone.length} tiles) and joiner zone (${map.joinerZone.length} tiles) are different sizes`,
    });
  }
}

// A custom zone must never extend into the core battlefield (cols 4-12) --
// archetypes.ts's cover generation relies on this to avoid needing its own
// zone-collision logic (see that file's header).
function checkZoneStaysOutOfCore(map: SparseMap, issues: Issue[]) {
  for (const p of map.joinerZone) {
    if (p.col < CORE_MAX_COL + 1) {
      issues.push({ severity: "error", message: `joiner zone tile (${p.row},${p.col}) extends into the core battlefield` });
    }
  }
  for (const p of map.creatorZone) {
    if (p.col > CORE_MIN_COL - 1) {
      issues.push({ severity: "error", message: `creator zone tile (${p.row},${p.col}) extends into the core battlefield` });
    }
  }
}

// ---- no scoring tile on an impassable cell ----

function checkScoringNotImpassable(map: SparseMap, issues: Issue[]) {
  const impassable = new Set(map.impassableTiles.map(positionKey));
  for (const s of map.scoringTiles) {
    if (impassable.has(positionKey(s))) {
      issues.push({
        severity: "error",
        message: `scoring tile (${s.row},${s.col}) sits on an impassable cell — no ship could ever stand there to claim it`,
      });
    }
  }
}

// ---- lanes ----

function countFullyOpenLaneRows(map: SparseMap): number {
  const impassable = new Set(map.impassableTiles.map(positionKey));
  let count = 0;
  for (let row = 0; row < GRID_HEIGHT; row++) {
    let open = true;
    for (let col = CORE_MIN_COL; col <= CORE_MAX_COL; col++) {
      if (impassable.has(positionKey({ row, col }))) {
        open = false;
        break;
      }
    }
    if (open) count++;
  }
  return count;
}

// 4-directional flood-fill over non-impassable cells, checked between the
// left core edge (col 4) and the right core edge (col 12) — a conservative
// lower-bound check ("if directly adjacent-connected, movement can
// certainly get there too"), not a full simulation of the on-chain
// straight-line movement rule.
function coreConnected(map: SparseMap): boolean {
  const impassable = new Set(map.impassableTiles.map(positionKey));
  const visited = new Set<string>();
  const queue: Position[] = [];
  for (let row = 0; row < GRID_HEIGHT; row++) {
    const start = { row, col: CORE_MIN_COL };
    if (!impassable.has(positionKey(start))) {
      queue.push(start);
      visited.add(positionKey(start));
    }
  }
  while (queue.length > 0) {
    const p = queue.shift()!;
    if (p.col === CORE_MAX_COL) return true;
    for (const [dr, dc] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const r = p.row + dr;
      const c = p.col + dc;
      if (r < 0 || r >= GRID_HEIGHT || c < CORE_MIN_COL || c > CORE_MAX_COL) continue;
      const key = positionKey({ row: r, col: c });
      if (visited.has(key) || impassable.has(key)) continue;
      visited.add(key);
      queue.push({ row: r, col: c });
    }
  }
  return false;
}

const ROW_LANE_ARCHETYPES = new Set(["asteroidField", "trenchRun", "twinPillars"]);

function checkLanes(map: SparseMap, spec: SlotSpec, issues: Issue[]) {
  if (!coreConnected(map)) {
    issues.push({
      severity: "error",
      message: "no connected path exists between the left and right core edges (col 4 to col 12) at all",
    });
    return;
  }
  if (ROW_LANE_ARCHETYPES.has(spec.archetype)) {
    const open = countFullyOpenLaneRows(map);
    if (open < spec.params.laneCount) {
      issues.push({
        severity: "error",
        message: `only ${open} fully-open lane row(s), expected at least ${spec.params.laneCount} for ${spec.archetype}`,
      });
    }
  }
  // debrisRing/reactorCore/openVoid: no row-count check (their lanes are
  // angular gaps, not free rows) — coreConnected above is the check.
}

// ---- degenerate-empty rejection ----

function checkNonDegenerate(map: SparseMap, spec: SlotSpec, issues: Issue[]) {
  const totalCover = map.blockedTiles.length + map.impassableTiles.length;
  if (spec.archetype !== "openVoid" && totalCover === 0) {
    issues.push({
      severity: "error",
      message: "map has zero cover and is not tagged Open Void",
    });
  }
}

// ---- spawn-zone clearance ----

function checkSpawnZoneClearance(
  map: SparseMap,
  formationPositions: Position[],
  issues: Issue[],
) {
  const blocked = new Set(map.blockedTiles.map(positionKey));
  const impassable = new Set(map.impassableTiles.map(positionKey));

  for (const [label, zone] of [
    ["creator", map.creatorZone],
    ["joiner", map.joinerZone],
  ] as const) {
    for (const p of zone) {
      if (blocked.has(positionKey(p)) || impassable.has(positionKey(p))) {
        issues.push({
          severity: "error",
          message: `${label} zone tile (${p.row},${p.col}) is covered by terrain`,
        });
      }
    }
  }

  for (const p of formationPositions) {
    if (blocked.has(positionKey(p)) || impassable.has(positionKey(p))) {
      issues.push({
        severity: "error",
        message: `AI formation position (${p.row},${p.col}) is covered by terrain`,
      });
    }
  }
  const seen = new Set<string>();
  for (const p of formationPositions) {
    const key = positionKey(p);
    if (seen.has(key)) {
      issues.push({
        severity: "error",
        message: `AI formation has a duplicate position (${p.row},${p.col})`,
      });
    }
    seen.add(key);
  }
}

// ---- sightline profile ----

// Samples LOS between every pair of core cells drawn from the two edge
// columns (a reasonable proxy for "how much of the map can shoot across
// it") and reports the fraction with clear line of sight — the map's
// terrain-driven sniping potential Phase 6 correlates against the
// balance-sim's kite-vs-kite win rate.
function computeSightlineProfile(map: SparseMap): number {
  const blocked = toGrid(map.blockedTiles);
  let clear = 0;
  let total = 0;
  for (let row0 = 0; row0 < GRID_HEIGHT; row0 += 2) {
    for (let row1 = 0; row1 < GRID_HEIGHT; row1 += 2) {
      total++;
      if (hasLineOfSight(blocked, row0, CORE_MIN_COL, row1, CORE_MAX_COL)) {
        clear++;
      }
    }
  }
  return total === 0 ? 0 : clear / total;
}

export function validateMap(
  map: SparseMap,
  spec: SlotSpec,
  formationPositions: Position[],
): ValidationResult {
  const issues: Issue[] = [];
  checkSymmetry(map, spec, issues);
  checkZoneMirror(map, spec, issues);
  checkZoneStaysOutOfCore(map, issues);
  checkScoringNotImpassable(map, issues);
  checkLanes(map, spec, issues);
  checkNonDegenerate(map, spec, issues);
  checkSpawnZoneClearance(map, formationPositions, issues);

  return {
    key: map.key ?? spec.key,
    issues,
    sightlineProfile: computeSightlineProfile(map),
  };
}
