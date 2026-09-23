// Faithful TypeScript port of contracts/Maps.sol's Bresenham line walk
// (_bresenhamMaps / _isTileBlockedSafe / hasMaps / hasMovementPath), used
// offline by the map generator/validator (see difficulty-table.ts,
// validate-map.ts) so sightline and movement-path checks match on-chain
// behavior bit-for-bit, without needing a deployed contract.
//
// Ported, not shared, deliberately: there is no practical way to share code
// across the Solidity/TypeScript/Python boundary (scripts/balance-sim/los.py
// has its own port), so all three are cross-checked against the same
// fixture cases instead (see los.selfcheck.ts and test/Maps.test.ts's own
// hasMaps assertions). If hasMaps/_bresenhamMaps/hasMovementPath ever change
// in Maps.sol, this file must be updated to match.

export const GRID_WIDTH = 17;
export const GRID_HEIGHT = 11;

// A tile grid: grid[row][col] === true means "occupied" — pass the blocked
// grid for line-of-sight checks, or the impassable grid for movement-path
// checks. Always GRID_HEIGHT rows of GRID_WIDTH columns each.
export type TileGrid = boolean[][];

export function emptyGrid(): TileGrid {
  return Array.from({ length: GRID_HEIGHT }, () =>
    new Array<boolean>(GRID_WIDTH).fill(false),
  );
}

export function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < GRID_HEIGHT && col >= 0 && col < GRID_WIDTH;
}

// Mirrors Maps.sol's _isTileBlockedSafe: out-of-bounds counts as occupied
// ("blocked"), matching the convention hasMaps/_bresenhamMaps rely on for a
// defensive line-walk that could in principle step off-grid.
function isOccupiedSafe(grid: TileGrid, row: number, col: number): boolean {
  if (!inBounds(row, col)) return true;
  return grid[row][col];
}

// Mirrors Maps.sol's _bresenhamMaps exactly, including its control flow and
// variable names, to keep this easy to diff against the Solidity source.
// Permissive-corner mode: a diagonal step is blocked only if BOTH
// orthogonal flanker cells are occupied, not just one.
function bresenham(
  grid: TileGrid,
  row0: number,
  col0: number,
  row1: number,
  col1: number,
): boolean {
  const dRow = row1 > row0 ? row1 - row0 : row0 - row1;
  const dCol = col1 > col0 ? col1 - col0 : col0 - col1;
  const sRow = row1 > row0 ? 1 : row1 < row0 ? -1 : 0;
  const sCol = col1 > col0 ? 1 : col1 < col0 ? -1 : 0;

  let err = dCol - dRow;
  let row = row0;
  let col = col0;

  while (true) {
    if (row === row1 && col === col1) {
      return !isOccupiedSafe(grid, row, col);
    }

    const e2 = err << 1;

    if (e2 === 0) {
      // Check flankers before moving.
      if (
        isOccupiedSafe(grid, row, col + sCol) &&
        isOccupiedSafe(grid, row + sRow, col)
      ) {
        return false;
      }
      col += sCol;
      err -= dRow;
      row += sRow;
      err += dCol;
      if ((row !== row1 || col !== col1) && isOccupiedSafe(grid, row, col)) {
        return false;
      }
      continue;
    }

    if (e2 > -dRow) {
      err -= dRow;
      col += sCol;
      if ((row !== row1 || col !== col1) && isOccupiedSafe(grid, row, col)) {
        return false;
      }
    }

    if (e2 < dCol) {
      err += dCol;
      row += sRow;
      if ((row !== row1 || col !== col1) && isOccupiedSafe(grid, row, col)) {
        return false;
      }
    }
  }
}

// Mirrors Maps.sol's hasMaps: line-of-sight against a blocked grid. The
// START tile counts — a shooter standing on a blocked (LOS-obstructing)
// tile can't see out either (matches the special/AI-targeting semantics
// this backs on-chain).
export function hasLineOfSight(
  blocked: TileGrid,
  row0: number,
  col0: number,
  row1: number,
  col1: number,
): boolean {
  if (!inBounds(row0, col0) || !inBounds(row1, col1)) {
    throw new Error("hasLineOfSight: coordinates out of bounds");
  }
  if (isOccupiedSafe(blocked, row0, col0)) return false;
  if (row0 === row1 && col0 === col1) {
    return !isOccupiedSafe(blocked, row1, col1);
  }
  return bresenham(blocked, row0, col0, row1, col1);
}

// Mirrors Maps.sol's hasMovementPath: whether a ship can move from
// (row0,col0) to (row1,col1) without its path crossing an impassable tile
// — blocks landing ON an impassable tile AND passing THROUGH one, via the
// same straight-line walk as hasLineOfSight, against the impassable grid
// instead of the blocked one.
//
// Deliberately does NOT apply hasLineOfSight's "start tile counts" rule —
// a ship already standing on a tile must always be able to leave it, even
// if that tile is later marked impassable.
export function hasMovementPath(
  impassable: TileGrid,
  row0: number,
  col0: number,
  row1: number,
  col1: number,
): boolean {
  if (!inBounds(row0, col0) || !inBounds(row1, col1)) {
    throw new Error("hasMovementPath: coordinates out of bounds");
  }
  if (row0 === row1 && col0 === col1) return true; // already there; not a move
  return bresenham(impassable, row0, col0, row1, col1);
}
