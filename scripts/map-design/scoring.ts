// Scoring-tile placement as a deliberate mini-narrative (Phase 0 §7), not
// scattered arbitrary points: one contested objective at (or nudged off)
// the map's true center, reachable via the lanes the archetype already
// guarantees exist, plus a small number of mirrored flanking "hold" tiles.
//
// Two patterns, both legitimate (the real exemplar map uses "uniform" —
// every tile worth the same, all recurring, no onlyOnce):
//  - "uniform": every tile (center + holds) is worth the same and never
//    onlyOnce — a round-over-round contest for several equal objectives.
//  - "tiered": the center is worth more than the holds, and the holds are
//    onlyOnce (a one-time grab) — a "hold the core" narrative with smaller
//    side prizes along the way.

import { GRID_HEIGHT, GRID_WIDTH } from "./los";
import {
  CENTER_COL,
  CENTER_ROW,
  CORE_MAX_COL,
  CORE_MIN_COL,
  GeneratedTerrain,
  Position,
  SymmetryMode,
  mirrorFor,
} from "./archetypes";

export interface ScoringPosition extends Position {
  points: number;
  onlyOnce: boolean;
}

export interface ScoringParams {
  pattern: "uniform" | "tiered";
  objectivePoints: number;
  holdPoints: number; // ignored for "uniform" (holds use objectivePoints too)
  holdCount: 0 | 1 | 2; // pairs under vertical/radial symmetry; singles under "none"; 0 = center objective only
}

// Fixed offsets (row,col delta from center) for hold tiles, in the primary
// half — loosely matching the real exemplar's own hold-tile placement
// (roughly 4-5 tiles out from center, off-axis). Only the first `holdCount`
// are used.
const HOLD_OFFSETS: [number, number][] = [
  [-4, -5],
  [4, -5],
];

function isImpassable(terrain: GeneratedTerrain, row: number, col: number): boolean {
  return terrain.impassable.some((p) => p.row === row && p.col === col);
}

// Nearest passable cell to (row,col), searching outward in a small spiral —
// used so a solid-centered archetype (Reactor-Core) never gets asked to
// place the central objective on top of its own impassable core.
function nearestPassable(
  terrain: GeneratedTerrain,
  row: number,
  col: number,
): Position {
  if (!isImpassable(terrain, row, col)) return { row, col };
  for (let radius = 1; radius < Math.max(GRID_HEIGHT, GRID_WIDTH); radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || r >= GRID_HEIGHT || c < 0 || c >= GRID_WIDTH) continue;
        if (!isImpassable(terrain, r, c)) return { row: r, col: c };
      }
    }
  }
  return { row, col }; // unreachable in practice (map is never 100% impassable)
}

export function placeScoring(
  terrain: GeneratedTerrain,
  symmetryMode: SymmetryMode,
  params: ScoringParams,
): ScoringPosition[] {
  const out: ScoringPosition[] = [];

  const center = nearestPassable(terrain, CENTER_ROW, CENTER_COL);
  out.push({
    ...center,
    points: params.objectivePoints,
    onlyOnce: false, // the contested center is always recurring, both patterns
  });

  const holdPoints =
    params.pattern === "uniform" ? params.objectivePoints : params.holdPoints;
  const onlyOnce = params.pattern === "tiered";

  for (let i = 0; i < params.holdCount; i++) {
    const [dr, dc] = HOLD_OFFSETS[i];
    const primaryRow = CENTER_ROW + dr;
    const primaryCol = Math.min(CENTER_COL, CENTER_COL + dc);
    const clampedCol = Math.max(CORE_MIN_COL, Math.min(CORE_MAX_COL, primaryCol));
    const clampedRow = Math.max(0, Math.min(GRID_HEIGHT - 1, primaryRow));
    const pos = nearestPassable(terrain, clampedRow, clampedCol);
    out.push({ ...pos, points: holdPoints, onlyOnce });

    // Scoring stays fairly contested even on a deliberately imbalanced
    // ("none") terrain map -- both sides get the same objectives to fight
    // over, only the cover around them differs. So hold tiles are always
    // mirrored across the vertical (column) axis, regardless of the
    // terrain's own symmetryMode.
    const mirrorMode = symmetryMode === "none" ? "vertical" : symmetryMode;
    const m = mirrorFor(mirrorMode)(pos.row, pos.col);
    const mirrored = nearestPassable(terrain, m.row, m.col);
    out.push({ ...mirrored, points: holdPoints, onlyOnce });
  }

  return out;
}
