// The thematic archetype library (Phase 0's design-principles pass, §3/§5):
// six named, parameterized cover-layout generators for a sci-fi fleet-combat
// setting, each producing a full 17x11 grid's worth of `blocked`/
// `impassable` terrain plus a deployment-zone shape, symmetric around
// column 8 (vertical), row 5 (horizontal), or the point (5,8) (radial) — or
// deliberately asymmetric (`symmetryMode: "none"`) for a PvE map that
// favors the attacker or defender.
//
// These are NOT random noise: every archetype places cover through a small
// number of structural rules (row-lane bands, ring/blob shapes with
// angle-punched gaps, a single pillar mirrored into a pair) so the result
// always has the chokepoint-lane structure Phase 0 §4 requires, verified
// later by validate-map.ts's connectivity scan — not left to chance.
//
// Cover is generated only within the "core" battlefield (cols 4-12) —
// never inside the engine's default deployment columns (creator 0-3,
// joiner 13-16) — so every archetype satisfies the spawn-zone-clearance
// rule by construction. Custom deployment-zone SHAPES (Phase 0 §5's
// "each archetype also defines its deployment-zone shape") reshape a
// map's zone within those same columns -- vertical (the full-height
// default), horizontal (a compact row-band at one edge), or diagonal (a
// staggered stripe) -- see buildZones below. None of the three ever
// extends into the core, so this stays true regardless of shape.

import { GRID_HEIGHT, GRID_WIDTH } from "./los";

export interface Position {
  row: number;
  col: number;
}

export type SymmetryMode = "vertical" | "horizontal" | "radial" | "none";
export type BalanceIntent = "fair" | "favorAttacker" | "favorDefender";

export type ArchetypeName =
  | "asteroidField"
  | "debrisRing"
  | "trenchRun"
  | "twinPillars"
  | "reactorCore"
  | "openVoid";

export interface DifficultyParams {
  // How many full-width lane-rows (or, for ring/blob archetypes, angular
  // gaps) stay completely free of cover — Phase 0 §4's "3-4 chokepoint
  // lanes, none defensible from a single tile" (a lane is a whole row, or a
  // gap several cells wide, never a single tile).
  laneCount: 3 | 4;
  // Max contiguous run length for a single cover cluster.
  clusterSizeMax: number;
  // Roughly the fraction of non-lane "wall" cells that get covered —
  // archetype-interpreted (asteroidField scatters at this density;
  // trenchRun/twinPillars/reactorCore treat it as near-solid fill within
  // their shape; debrisRing/openVoid use it to size the ring/sparse rate).
  density: number;
  // Fraction of placed cover cells that are HARD cover (blocked AND
  // impassable) vs soft cover (blocked only, still flyable-through).
  hardCoverRatio: number;
}

// Deployment-zone shapes -- directly answers docs/internal-todos.md's
// long-open "update maps creation to support horizontal or vertical
// deployment... consider additional custom deployments (diagonals)" item.
// "vertical" is today's engine default (the full 4-column x 11-row band);
// "horizontal" and "diagonal" reshape it WITHIN THE SAME columns (creator
// 0-3, joiner 13-16) -- deliberately never extending into the core
// battlefield (cols 4-12), so a custom zone can never collide with
// generated cover and never needs its own cover-avoidance logic.
export type ZoneShape = "vertical" | "horizontal" | "diagonal";

export interface ArchetypeInput {
  key: string; // deterministic PRNG seed (the map's slot key, e.g. "m07")
  archetype: ArchetypeName;
  symmetryMode: SymmetryMode;
  balanceIntent: BalanceIntent; // only meaningful when symmetryMode === "none"
  params: DifficultyParams;
  zoneShape: ZoneShape;
}

export interface GeneratedTerrain {
  blocked: Position[];
  impassable: Position[];
  // Empty arrays mean "use the engine default zone" (see
  // Maps.sol's isValidDeploymentTile) -- zoneShape "vertical" is exactly
  // that default, so it's represented as [] rather than spelled out.
  creatorZone: Position[];
  joinerZone: Position[];
}

// ---- deterministic PRNG (mulberry32), seeded from the map's key ----

function seedFromString(s: string): number {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

// ---- grid plumbing ----

interface CoverCell {
  blocked: boolean;
  impassable: boolean;
}

function emptyCoverGrid(): CoverCell[][] {
  return Array.from({ length: GRID_HEIGHT }, () =>
    Array.from({ length: GRID_WIDTH }, () => ({
      blocked: false,
      impassable: false,
    })),
  );
}

function toGeneratedTerrain(
  grid: CoverCell[][],
  zones: { creatorZone: Position[]; joinerZone: Position[] },
): GeneratedTerrain {
  const blocked: Position[] = [];
  const impassable: Position[] = [];
  for (let row = 0; row < GRID_HEIGHT; row++) {
    for (let col = 0; col < GRID_WIDTH; col++) {
      const cell = grid[row][col];
      if (cell.blocked) blocked.push({ row, col });
      if (cell.impassable) impassable.push({ row, col });
    }
  }
  return { blocked, impassable, ...zones };
}

// Core battlefield columns -- never touches the engine's default deployment
// zones (creator col 0-3, joiner col 13-16).
export const CORE_MIN_COL = 4;
export const CORE_MAX_COL = 12;
export const CENTER_ROW = Math.floor(GRID_HEIGHT / 2); // 5
export const CENTER_COL = Math.floor(GRID_WIDTH / 2); // 8

export function mirrorFor(mode: SymmetryMode): (r: number, c: number) => Position {
  switch (mode) {
    case "vertical":
      return (r, c) => ({ row: r, col: GRID_WIDTH - 1 - c });
    case "horizontal":
      return (r, c) => ({ row: GRID_HEIGHT - 1 - r, col: c });
    case "radial":
      return (r, c) => ({ row: GRID_HEIGHT - 1 - r, col: GRID_WIDTH - 1 - c });
    case "none":
      return (r, c) => ({ row: r, col: c }); // unused for "none"
  }
}

// The half of the core battlefield a given symmetry mode generates directly
// (the mirror fills the rest) -- vertical/radial share the same primary
// domain (cols 4-8) since both mirror around column 8; horizontal instead
// mirrors around row 5.
function isPrimary(mode: SymmetryMode, row: number, col: number): boolean {
  if (mode === "horizontal") return row <= CENTER_ROW;
  return col <= CENTER_COL; // vertical, radial
}

function setCell(
  grid: CoverCell[][],
  row: number,
  col: number,
  hard: boolean,
) {
  grid[row][col] = { blocked: true, impassable: hard };
}

// Places (row,col) and, unless symmetryMode is "none", its mirror too.
function placeMirrored(
  grid: CoverCell[][],
  mode: SymmetryMode,
  row: number,
  col: number,
  hard: boolean,
) {
  setCell(grid, row, col, hard);
  if (mode !== "none") {
    const m = mirrorFor(mode)(row, col);
    setCell(grid, m.row, m.col, hard);
  }
}

// laneCount evenly-spread rows (out of 0-10) that must stay completely
// free of cover -- guarantees a lane is a whole row (width 11, never
// defensible from one tile) rather than something that needs a post-hoc
// connectivity check to confirm.
//
// `rowMirrors` MUST be true for any symmetry mode whose mirror function
// changes the row (radial, horizontal) -- otherwise a "wall" row picked
// independently of its own mirror can have its mirror land on a row that
// was separately picked to stay open, silently filling in a lane that was
// never actually free. Vertical symmetry only ever mirrors the column, so
// a lane row's mirror is always itself -- free choice is safe there (and
// for the unmirrored "none"/imbalanced generation path).
function laneRows(count: number, rng: Rng, rowMirrors: boolean): Set<number> {
  const rows = new Set<number>();
  if (!rowMirrors) {
    const span = GRID_HEIGHT / count;
    for (let i = 0; i < count; i++) {
      const jitter = Math.floor(rng() * Math.max(1, Math.floor(span) - 1));
      const row = Math.min(
        GRID_HEIGHT - 1,
        Math.floor(i * span + span / 2 - 1 + jitter),
      );
      rows.add(Math.max(0, row));
    }
    return rows;
  }

  // Row-flipping modes: pick from the primary half (rows 0..CENTER_ROW)
  // and mirror each pick (GRID_HEIGHT-1-r) so a lane row's partner is
  // always also a lane row. CENTER_ROW itself is self-mirrored.
  const half = Math.ceil(count / 2);
  const span = (CENTER_ROW + 1) / half;
  let i = 0;
  while (rows.size < count && i < half + 2) {
    const jitter = Math.floor(rng() * Math.max(1, Math.floor(span) - 1));
    const row = Math.min(
      CENTER_ROW,
      Math.max(0, Math.floor(i * span + span / 2 - 1 + jitter)),
    );
    rows.add(row);
    if (row !== CENTER_ROW) rows.add(GRID_HEIGHT - 1 - row);
    i++;
  }
  return rows;
}

function rowMirrorsFor(mode: SymmetryMode): boolean {
  return mode === "radial" || mode === "horizontal";
}

function pickHardness(rng: Rng, hardCoverRatio: number): boolean {
  return rng() < hardCoverRatio;
}

// Trench Run's per-cell wall-fill probability, derived from density rather
// than a flat constant -- stays "near-solid" (>0.5) across the whole
// density range so the archetype's own flavor never breaks, but still
// responds to density so the "none" (imbalanced) path's favored/disfavored
// skew actually shows up as a real fill-rate difference (found via Phase 5's
// validator: a flat constant here silently ate the skew signal entirely).
function trenchFillProbability(density: number): number {
  return Math.min(0.95, 0.5 + density * 0.7);
}

// ---- archetype 1: Asteroid Field — scattered small clusters in the wall rows ----

function asteroidField(
  grid: CoverCell[][],
  mode: SymmetryMode,
  params: DifficultyParams,
  rng: Rng,
) {
  const lanes = laneRows(params.laneCount, rng, rowMirrorsFor(mode));
  for (let row = 0; row < GRID_HEIGHT; row++) {
    if (lanes.has(row)) continue;
    let col = CORE_MIN_COL;
    while (col <= CENTER_COL) {
      if (isPrimary(mode, row, col) && rng() < params.density) {
        const runLen = 1 + Math.floor(rng() * params.clusterSizeMax);
        const hard = pickHardness(rng, params.hardCoverRatio);
        for (let k = 0; k < runLen && col + k <= CENTER_COL; k++) {
          placeMirrored(grid, mode, row, col + k, hard);
        }
        col += runLen + 1; // small gap after a cluster
      } else {
        col++;
      }
    }
  }
}

// ---- archetype 2: Trench/Corridor Run — near-solid walls in the wall rows ----

function trenchRun(
  grid: CoverCell[][],
  mode: SymmetryMode,
  params: DifficultyParams,
  rng: Rng,
) {
  // Fewer, thicker walls than asteroidField: at most 2 wall bands even at
  // laneCount=3, so each wall reads as a long trench, not scattered rubble.
  const lanes = laneRows(Math.max(params.laneCount, 3), rng, rowMirrorsFor(mode));
  for (let row = 0; row < GRID_HEIGHT; row++) {
    if (lanes.has(row)) continue;
    for (let col = CORE_MIN_COL; col <= CENTER_COL; col++) {
      if (!isPrimary(mode, row, col)) continue;
      // Near-solid, with an occasional single-cell notch for minor variance
      // (never enough to open a second lane through a wall row).
      if (rng() < trenchFillProbability(params.density)) {
        const hard = pickHardness(rng, Math.max(params.hardCoverRatio, 0.6));
        placeMirrored(grid, mode, row, col, hard);
      }
    }
  }
}

// ---- archetype 3: Twin Pillars — one block in the primary half; the mirror makes it two ----

function twinPillars(
  grid: CoverCell[][],
  mode: SymmetryMode,
  params: DifficultyParams,
  rng: Rng,
) {
  const lanes = laneRows(params.laneCount, rng, rowMirrorsFor(mode));
  // A narrow column band (not the whole core width) so the result reads as
  // a pillar, not a full trench wall.
  const pillarColStart = CENTER_COL - Math.max(2, params.clusterSizeMax);
  for (let row = 0; row < GRID_HEIGHT; row++) {
    if (lanes.has(row)) continue;
    for (let col = pillarColStart; col < CENTER_COL; col++) {
      if (col < CORE_MIN_COL || !isPrimary(mode, row, col)) continue;
      if (rng() < Math.max(params.density, 0.7)) {
        const hard = pickHardness(rng, Math.max(params.hardCoverRatio, 0.5));
        placeMirrored(grid, mode, row, col, hard);
      }
    }
  }
}

// ---- shared: ring/blob shapes with angle-punched gaps (Debris Ring, Reactor-Core) ----

function angleDegrees(row: number, col: number): number {
  return (Math.atan2(row - CENTER_ROW, col - CENTER_COL) * 180) / Math.PI;
}

function chebyshev(row: number, col: number): number {
  return Math.max(Math.abs(row - CENTER_ROW), Math.abs(col - CENTER_COL));
}

// Evenly-spaced gap angles, each wide enough (angleWidth) that the opening
// stays at least a couple of cells across at the shape's radius, not a
// single-tile notch.
function isInGap(
  row: number,
  col: number,
  laneCount: number,
  angleWidthDeg: number,
): boolean {
  const a = angleDegrees(row, col);
  const step = 360 / laneCount;
  for (let i = 0; i < laneCount; i++) {
    const gapCenter = -180 + i * step;
    let delta = Math.abs(a - gapCenter);
    if (delta > 180) delta = 360 - delta;
    if (delta <= angleWidthDeg / 2) return true;
  }
  return false;
}

// The maximum possible chebyshev distance from the true center to any cell
// in the core battlefield: max(CENTER_ROW, CENTER_COL - CORE_MIN_COL) = 5.
// `outer` must never exceed this -- growing it past the grid's own reach
// doesn't make the ring/blob any bigger (no cell is that far away), it just
// shrinks a THIN ring down to almost nothing (found via Phase 7 review:
// several Debris Ring maps came back nearly empty at higher difficulty,
// the opposite of the intended effect, because `outer` and `inner` were
// both being pushed past the only distance values that actually exist).
const MAX_CORE_DIST = Math.max(CENTER_ROW, CENTER_COL - CORE_MIN_COL);

// Once `outer` saturates at MAX_CORE_DIST, further difficulty (higher
// clusterSizeMax) instead thickens the ring by shrinking `inner` -- a
// Debris Ring genuinely gets denser as it gets harder, up to nearly a
// solid disk, rather than wasting its "radius budget" past the grid's edge.
function ringRadii(clusterSizeMax: number, solid: boolean): { inner: number; outer: number } {
  const half = Math.floor(clusterSizeMax / 2);
  const outer = solid
    ? Math.min(MAX_CORE_DIST, 3 + clusterSizeMax)
    : Math.min(MAX_CORE_DIST, 3 + half);
  const inner = solid ? 0 : Math.max(1, outer - 1 - half);
  return { inner, outer };
}

function ringOrBlob(
  grid: CoverCell[][],
  mode: SymmetryMode,
  params: DifficultyParams,
  rng: Rng,
  solid: boolean, // true = Reactor-Core (filled disk), false = Debris Ring (band only)
) {
  const { inner, outer } = ringRadii(params.clusterSizeMax, solid);
  // Wider gaps for a thin ring (its thickness alone won't keep a lane
  // open) than for a solid blob (any radial cut already opens a lane).
  const angleWidth = solid ? 26 : 40;

  const mirror = mirrorFor(mode);
  for (let row = 0; row < GRID_HEIGHT; row++) {
    for (let col = CORE_MIN_COL; col <= CENTER_COL; col++) {
      if (!isPrimary(mode, row, col)) continue;
      const dist = chebyshev(row, col);
      if (dist < inner || dist > outer) continue;
      if (isInGap(row, col, params.laneCount, angleWidth)) continue;
      // Distance from center is mirror-invariant for all three transforms
      // (each is an isometry centered on (CENTER_ROW,CENTER_COL)), but gap
      // membership is an ANGLE test, and not every (mode, laneCount)
      // combination keeps a cell's angle-gap status equal to its mirror's
      // (odd laneCount is the common case this bites) -- checking only the
      // primary cell let a "gap" get silently filled in by its own mirror,
      // found via Phase 5's validator (f04 lost core connectivity
      // entirely). Require BOTH cells to agree they're not in a gap.
      const m = mirror(row, col);
      if (isInGap(m.row, m.col, params.laneCount, angleWidth)) continue;
      if (rng() < Math.max(params.density, solid ? 0.8 : 0.6)) {
        const hard = pickHardness(
          rng,
          solid ? Math.max(params.hardCoverRatio, 0.6) : params.hardCoverRatio,
        );
        placeMirrored(grid, mode, row, col, hard);
      }
    }
  }
}

// ---- archetype 6: Open Void — minimal, sparse soft cover only ----

function openVoid(
  grid: CoverCell[][],
  mode: SymmetryMode,
  params: DifficultyParams,
  rng: Rng,
) {
  const sparseRate = Math.min(params.density, 0.3) * 0.15;
  for (let row = 0; row < GRID_HEIGHT; row++) {
    for (let col = CORE_MIN_COL; col <= CENTER_COL; col++) {
      if (!isPrimary(mode, row, col)) continue;
      if (rng() < sparseRate) {
        // Soft cover only -- an Open Void map is about long sightlines,
        // not walls; never hard cover, regardless of hardCoverRatio.
        placeMirrored(grid, mode, row, col, false);
      }
    }
  }
}

// ---- "none" symmetry: independently-parameterized, imbalanced halves ----

// Applies a multiplier to density/clusterSizeMax for one territory, used to
// give the favored side (per balanceIntent) denser cover and the
// disadvantaged side more open, exposed ground. Attacker = creator = low
// columns (4-8); defender = joiner = high columns (9-12) -- matches this
// codebase's own convention that the AI is always the joiner and treats
// high columns as its own side (see AIBehavior._bestScoringTile).
function skewedParams(
  params: DifficultyParams,
  favored: boolean,
): DifficultyParams {
  const mult = favored ? 1.35 : 0.55;
  return {
    ...params,
    density: Math.min(0.95, params.density * mult),
    clusterSizeMax: Math.max(
      1,
      params.clusterSizeMax + (favored ? 1 : -1),
    ),
  };
}

function generateImbalanced(
  grid: CoverCell[][],
  archetype: ArchetypeName,
  balanceIntent: BalanceIntent,
  params: DifficultyParams,
  rng: Rng,
) {
  const attackerFavored = balanceIntent === "favorAttacker";
  const attackerParams = skewedParams(params, attackerFavored);
  const defenderParams = skewedParams(params, !attackerFavored);

  // Lane rows are chosen ONCE and shared by both territories -- an
  // imbalanced map is still one connected battlefield, not two separate
  // ones, so a lane has to be a real corridor spanning the whole width.
  // Left to each side's own independent pick (the original approach),
  // "lane" rows on one side routinely landed on "wall" rows on the other,
  // and the merged map failed the fully-open-lane-row check entirely
  // (found via Phase 5's validator on s03).
  const sharedLanes = laneRows(params.laneCount, rng, false);

  // Generate each side as its own "vertical-primary" pattern (cols 4-8 for
  // the attacker/creator territory, 9-12 mirrored-by-hand for the
  // defender/joiner territory — reusing the same pattern functions with
  // symmetryMode "vertical" would mirror them together, so instead each
  // side is generated directly with mode "none" passed through to
  // placeMirrored, which is a no-op mirror (writes only the given cell)).
  runPattern(
    grid,
    archetype,
    "none",
    attackerParams,
    rng,
    CORE_MIN_COL,
    CENTER_COL,
    sharedLanes,
  );
  runPattern(
    grid,
    archetype,
    "none",
    defenderParams,
    rng,
    CENTER_COL + 1,
    CORE_MAX_COL,
    sharedLanes,
  );
}

// Runs an archetype's pattern function restricted to [minCol,maxCol] by
// temporarily treating every cell in that range as "primary" (via a
// one-off isPrimary override baked into a scoped mirror mode) -- reuses
// the exact same pattern functions asteroidField/trenchRun/etc. use for
// the mirrored modes, just with a column-range guard instead of a mirror.
function runPattern(
  grid: CoverCell[][],
  archetype: ArchetypeName,
  mode: SymmetryMode,
  params: DifficultyParams,
  rng: Rng,
  minCol: number,
  maxCol: number,
  sharedLanes: Set<number>,
) {
  const guarded = emptyCoverGrid();
  switch (archetype) {
    case "asteroidField":
      asteroidFieldRanged(guarded, params, rng, minCol, maxCol, sharedLanes);
      break;
    case "debrisRing":
      ringOrBlobRanged(guarded, params, rng, false, minCol, maxCol, sharedLanes);
      break;
    case "trenchRun":
      trenchRunRanged(guarded, params, rng, minCol, maxCol, sharedLanes);
      break;
    case "twinPillars":
      // A single pillar has no independent left/right variant worth
      // imbalancing separately -- fall back to asteroidField's density
      // model for "none" mode so favorAttacker/favorDefender still reads
      // as a real terrain-density difference between territories.
      asteroidFieldRanged(guarded, params, rng, minCol, maxCol, sharedLanes);
      break;
    case "reactorCore":
      ringOrBlobRanged(guarded, params, rng, true, minCol, maxCol, sharedLanes);
      break;
    case "openVoid":
      openVoidRanged(guarded, params, rng, minCol, maxCol);
      break;
  }
  for (let row = 0; row < GRID_HEIGHT; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      if (guarded[row][col].blocked) grid[row][col] = guarded[row][col];
    }
  }
}

// Column-ranged variants of the pattern functions above, used only by the
// "none" (imbalanced) path — same rules, no mirroring, bounded to
// [minCol,maxCol] instead of the primary-half predicate.
function asteroidFieldRanged(
  grid: CoverCell[][],
  params: DifficultyParams,
  rng: Rng,
  minCol: number,
  maxCol: number,
  lanes: Set<number>,
) {
  for (let row = 0; row < GRID_HEIGHT; row++) {
    if (lanes.has(row)) continue;
    let col = minCol;
    while (col <= maxCol) {
      if (rng() < params.density) {
        const runLen = 1 + Math.floor(rng() * params.clusterSizeMax);
        const hard = pickHardness(rng, params.hardCoverRatio);
        for (let k = 0; k < runLen && col + k <= maxCol; k++) {
          setCell(grid, row, col + k, hard);
        }
        col += runLen + 1;
      } else {
        col++;
      }
    }
  }
}

function trenchRunRanged(
  grid: CoverCell[][],
  params: DifficultyParams,
  rng: Rng,
  minCol: number,
  maxCol: number,
  lanes: Set<number>,
) {
  for (let row = 0; row < GRID_HEIGHT; row++) {
    if (lanes.has(row)) continue;
    for (let col = minCol; col <= maxCol; col++) {
      if (rng() < trenchFillProbability(params.density)) {
        const hard = pickHardness(rng, Math.max(params.hardCoverRatio, 0.6));
        setCell(grid, row, col, hard);
      }
    }
  }
}

function ringOrBlobRanged(
  grid: CoverCell[][],
  params: DifficultyParams,
  rng: Rng,
  solid: boolean,
  minCol: number,
  maxCol: number,
  lanes: Set<number>,
) {
  const { inner, outer } = ringRadii(params.clusterSizeMax, solid);
  // Row-based shared lanes here, NOT isInGap's angle-slice gaps (unlike the
  // mirrored ringOrBlob below) -- isInGap's gaps are evenly spaced around
  // the full 360° grid center regardless of the attacker/defender column
  // split, so depending on laneCount, a different NUMBER of gaps can land
  // in each side's angular half (e.g. laneCount=3 put 2 of the 3 gaps in
  // the defender's half and only 1 in the attacker's), carving away a much
  // bigger fraction of one side's area than the other -- enough to fully
  // invert the intended favored/disfavored skew regardless of density
  // (found the same way, and on the very same map slot, as the sharedLanes
  // fix above: s03 -> its rlS03 roguelike-extension counterpart, 2026-09-23).
  // Row lanes are shared across the col-8 split by construction, so this
  // can't happen.
  for (let row = 0; row < GRID_HEIGHT; row++) {
    if (lanes.has(row)) continue;
    for (let col = minCol; col <= maxCol; col++) {
      const dist = chebyshev(row, col);
      if (dist < inner || dist > outer) continue;
      // No density floor here, unlike the mirrored ringOrBlob below --
      // this path is ONLY used for "none" (imbalanced) generation, where
      // params.density already carries the intended favored/disfavored
      // skew (see skewedParams); a floor as high as 0.8 would clamp both
      // sides to the same value and silently erase that skew (found via
      // Phase 5's validator: s01/s03 came out with the disfavored side
      // MORE covered than the favored one).
      if (rng() < params.density) {
        const hard = pickHardness(
          rng,
          solid ? Math.max(params.hardCoverRatio, 0.6) : params.hardCoverRatio,
        );
        setCell(grid, row, col, hard);
      }
    }
  }
}

function openVoidRanged(
  grid: CoverCell[][],
  params: DifficultyParams,
  rng: Rng,
  minCol: number,
  maxCol: number,
) {
  const sparseRate = Math.min(params.density, 0.3) * 0.15;
  for (let row = 0; row < GRID_HEIGHT; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      if (rng() < sparseRate) setCell(grid, row, col, false);
    }
  }
}

// ---- deployment zone shapes ----

// Matches Maps.sol's/Fleets.sol's own hardcoded default column bands
// exactly (see Maps.sol's DEFAULT_CREATOR_MIN_COL etc.) -- a custom zone
// stays confined to these same columns, just reshaped within them.
const JOINER_MIN_COL = 13;
const JOINER_MAX_COL = 16;

// A compact row-band at one edge (top or bottom) of the joiner's own
// columns -- ships deploy along a horizontal line rather than spread down
// the whole height. `frontAtTop` picked per-map (deterministic) for
// variety across the maps that use this shape.
function joinerHorizontalBand(frontAtTop: boolean): Position[] {
  const rows = frontAtTop ? [0, 1, 2, 3] : [GRID_HEIGHT - 4, GRID_HEIGHT - 3, GRID_HEIGHT - 2, GRID_HEIGHT - 1];
  const out: Position[] = [];
  for (const row of rows) {
    for (let col = JOINER_MIN_COL; col <= JOINER_MAX_COL; col++) out.push({ row, col });
  }
  return out;
}

// A solid staircase triangle across the joiner's own columns -- a
// flanking-formation shape (docs/internal-todos.md's "diagonals" note).
//
// Replaced a "band centered on a diagonal line" approach (bandHalfWidth
// tuning up to 3.5) after user feedback on the rendered gallery: that
// shape put a gap on BOTH sides of the diagonal stripe in every column
// except the very ends, reading as disconnected "blocky lines" rather
// than a triangle, and never actually touched a wall along its full run.
//
// This version instead fills each column solidly from ONE anchor edge
// (always the same edge, every column) out to a per-column height that
// grows column-by-column -- a proper right-triangle silhouette made of
// square steps, flush with that wall for its entire run, with the tallest
// column filling the full height (so it also touches the opposite wall
// and the outer side edge). `anchorTop` is picked per-map (deterministic)
// for variety: some maps' triangles grow downward from the top, others
// grow upward from the bottom.
function joinerDiagonalBand(anchorTop: boolean): Position[] {
  const out: Position[] = [];
  const span = JOINER_MAX_COL - JOINER_MIN_COL; // 3
  for (let col = JOINER_MIN_COL; col <= JOINER_MAX_COL; col++) {
    const local = col - JOINER_MIN_COL; // 0..3
    // Grows from a thin sliver at the near column to the full column
    // height at the far column (local === span) -- max capacity here is
    // 3+6+8+11 = 28 cells, comfortably above the largest roster this zone
    // shape needs to hold (13 ships, f05).
    const height = Math.round(((local + 1) / (span + 1)) * GRID_HEIGHT);
    for (let i = 0; i < height; i++) {
      const row = anchorTop ? i : GRID_HEIGHT - 1 - i;
      out.push({ row, col });
    }
  }
  return out;
}

// Builds both sides' zones together: the joiner's shape is generated
// directly, the creator's is its mirror under the SAME transform terrain
// uses (or vertical, for "none"/imbalanced maps -- deployment fairness is
// kept independent of terrain fairness, same precedent as scoring.ts's
// hold-tile placement). "vertical" returns [] for both -- Maps.sol already
// treats an unset zone as exactly that default, so there's nothing to
// spell out.
function buildZones(
  shape: ZoneShape,
  symmetryMode: SymmetryMode,
  key: string,
): { creatorZone: Position[]; joinerZone: Position[] } {
  if (shape === "vertical") return { creatorZone: [], joinerZone: [] };

  const rng = mulberry32(seedFromString(key + ":zone"));
  const joinerZone =
    shape === "horizontal" ? joinerHorizontalBand(rng() < 0.5) : joinerDiagonalBand(rng() < 0.5);

  const mirror = mirrorFor(symmetryMode === "none" ? "vertical" : symmetryMode);
  const creatorZone = joinerZone.map((p) => mirror(p.row, p.col));
  return { creatorZone, joinerZone };
}

// ---- entry point ----

export function generateArchetype(input: ArchetypeInput): GeneratedTerrain {
  const rng = mulberry32(seedFromString(input.key));
  const grid = emptyCoverGrid();

  if (input.symmetryMode === "none") {
    generateImbalanced(
      grid,
      input.archetype,
      input.balanceIntent,
      input.params,
      rng,
    );
  } else {
    switch (input.archetype) {
      case "asteroidField":
        asteroidField(grid, input.symmetryMode, input.params, rng);
        break;
      case "trenchRun":
        trenchRun(grid, input.symmetryMode, input.params, rng);
        break;
      case "twinPillars":
        twinPillars(grid, input.symmetryMode, input.params, rng);
        break;
      case "debrisRing":
        ringOrBlob(grid, input.symmetryMode, input.params, rng, false);
        break;
      case "reactorCore":
        ringOrBlob(grid, input.symmetryMode, input.params, rng, true);
        break;
      case "openVoid":
        openVoid(grid, input.symmetryMode, input.params, rng);
        break;
    }
  }

  const zones = buildZones(input.zoneShape, input.symmetryMode, input.key);
  return toGeneratedTerrain(grid, zones);
}
