// Named AI-fleet spawn formations, confined to a map's joiner deployment
// zone (custom, if the map defines one — none of the six archetypes do
// today, see archetypes.ts's header — or the engine default band: col
// 13-16, row 0-10). Replaces today's ad hoc scatter (a doc note found
// during Phase 0's research confirms 8 of 10 early campaign maps used to
// be a literal single vertical column of AI ships before a manual "mix it
// up" pass — these are the systematic version of that fix.

import { GRID_HEIGHT, GRID_WIDTH } from "./los";

export interface Position {
  row: number;
  col: number;
}

export type FormationName = "wedge" | "picket" | "echelon";

const DEFAULT_JOINER_MIN_COL = 13;
const DEFAULT_JOINER_MAX_COL = 16;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function clampRow(row: number): number {
  return clamp(row, 0, GRID_HEIGHT - 1);
}

function clampCol(col: number): number {
  return clamp(col, DEFAULT_JOINER_MIN_COL, DEFAULT_JOINER_MAX_COL);
}

// A spearhead: one ship at the front-center (closest to the fight), pairs
// trailing back and fanning out above/below as they recede toward the rear
// column — the classic "wedge" shape, tip pointed at the enemy.
function wedge(count: number): Position[] {
  const positions: Position[] = [];
  const centerRow = 5;
  positions.push({ row: centerRow, col: DEFAULT_JOINER_MIN_COL });
  let rank = 1;
  while (positions.length < count) {
    const col = clampCol(DEFAULT_JOINER_MIN_COL + rank);
    positions.push({ row: clampRow(centerRow - rank), col });
    if (positions.length < count) {
      positions.push({ row: clampRow(centerRow + rank), col });
    }
    rank++;
  }
  return positions.slice(0, count);
}

// A defensive line: ships spread evenly across the available rows, one
// column back from the front edge — holding ground rather than pushing.
function picket(count: number): Position[] {
  const positions: Position[] = [];
  const col = clampCol(DEFAULT_JOINER_MIN_COL + 1);
  if (count === 1) {
    positions.push({ row: 5, col });
    return positions;
  }
  for (let i = 0; i < count; i++) {
    const row = Math.round((i * (GRID_HEIGHT - 1)) / (count - 1));
    positions.push({ row: clampRow(row), col });
  }
  return positions;
}

// A staggered diagonal line, stepping back and across one cell at a time —
// each ship covers the one ahead of it at an angle rather than standing
// shoulder-to-shoulder.
function echelon(count: number): Position[] {
  const positions: Position[] = [];
  let row = 1;
  let col = DEFAULT_JOINER_MIN_COL;
  for (let i = 0; i < count; i++) {
    positions.push({ row: clampRow(row), col: clampCol(col) });
    row += 2;
    col += 1;
  }
  return positions;
}

// Nudges any duplicate position to the nearest free cell within the same
// column band (formations can clamp multiple ships onto the same edge cell
// once they run past the band's bounds) — Fleets.createFleet rejects
// duplicate starting positions outright, so this must never happen.
function dedupe(positions: Position[]): Position[] {
  const taken = new Set<string>();
  const out: Position[] = [];
  for (const p of positions) {
    let { row, col } = p;
    let key = `${row},${col}`;
    let radius = 0;
    while (taken.has(key)) {
      radius++;
      let found = false;
      for (let dr = -radius; dr <= radius && !found; dr++) {
        for (let dc = -radius; dc <= radius && !found; dc++) {
          const r = clampRow(p.row + dr);
          const c = clampCol(p.col + dc);
          const k = `${r},${c}`;
          if (!taken.has(k)) {
            row = r;
            col = c;
            key = k;
            found = true;
          }
        }
      }
      if (radius > GRID_HEIGHT + GRID_WIDTH) break; // band is full; give up cleanly
    }
    taken.add(key);
    out.push({ row, col });
  }
  return out;
}

// If the map defines a custom joiner zone, snaps each formation position to
// the nearest tile actually in that zone (formations are computed against
// the default band's geometry; a custom zone may have a different shape).
function snapToZone(positions: Position[], zone: Position[]): Position[] {
  if (zone.length === 0) return positions; // no custom zone -- use as-is
  const taken = new Set<string>();
  return positions.map((p) => {
    let best = zone[0];
    let bestDist = Infinity;
    for (const z of zone) {
      const key = `${z.row},${z.col}`;
      if (taken.has(key)) continue;
      const dist = Math.abs(z.row - p.row) + Math.abs(z.col - p.col);
      if (dist < bestDist) {
        bestDist = dist;
        best = z;
      }
    }
    taken.add(`${best.row},${best.col}`);
    return best;
  });
}

export function placeFormation(
  name: FormationName,
  count: number,
  joinerZone: Position[] = [],
): Position[] {
  if (count <= 0) return [];
  let positions: Position[];
  switch (name) {
    case "wedge":
      positions = wedge(count);
      break;
    case "picket":
      positions = picket(count);
      break;
    case "echelon":
      positions = echelon(count);
      break;
  }
  positions = dedupe(positions);
  return snapToZone(positions, joinerZone);
}
