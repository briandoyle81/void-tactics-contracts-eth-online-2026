// Bidirectional converter between two map representations:
//
//  - The DENSE grid schema used by the real external Map Editor tool (see
//    /exemplar-pvp-map.json at the repo root for a hand-built reference
//    example) — one row-major boolean/number array per property, easy for a
//    human-facing visual editor to read/write directly.
//  - The SPARSE coordinate-list schema contracts/Maps.sol and
//    ignition/modules/DeployAndConfig.ts actually consume (Position[] /
//    ScoringPosition[] — see ignition/data/*.json's `maps` entries).
//
// The generator (archetypes.ts/generate-map.ts) works in the sparse shape
// (it's what gets written to the starter-content JSON either way), but
// every generated map should also round-trip through the dense shape so it
// can be opened, reviewed, and hand-tweaked in the real editor before it's
// ever committed — see validate-map.ts/preview.ts's human-review path.
//
// Schema additions vs. the exemplar (forward-compatible — an old dense file
// with none of these is still readable, they're just treated as empty/
// default): `impassableTiles` (movement-blocking, independent of
// `blockedTiles` — the exemplar predates this entirely, per the person who
// supplied it), `deploymentZones.creatorZone`/`joinerZone` (per-map
// deployment zones — empty/absent means "use the engine default", exactly
// matching Maps.sol's isValidDeploymentTile fallback), and `mode` (PvE/PvP/
// Both — the exemplar's own file has none, campaign content defaults to
// PvE). Flagging these three as a cross-team note for whoever owns the
// external Map Editor tool: it will need to gain them to author impassable
// terrain, deployment zones, or PvP maps directly — until then, those
// fields simply won't round-trip through it and need Phase 4's generator
// to add them after import, or before export.

import { GRID_HEIGHT, GRID_WIDTH } from "./los";

export interface Position {
  row: number;
  col: number;
}

export interface ScoringPosition extends Position {
  points: number;
  onlyOnce: boolean;
}

// The sparse shape Maps.sol/Ignition consume — same field names as
// ignition/data/*.json's `maps` entries, so a SparseMap can be spread
// directly into one of those array elements.
export interface SparseMap {
  key?: string;
  name?: string;
  mode?: "PvP" | "PvE" | "Both";
  blockedTiles: Position[];
  impassableTiles: Position[];
  scoringTiles: ScoringPosition[];
  creatorZone: Position[];
  joinerZone: Position[];
}

// The dense shape the real Map Editor tool reads/writes — matches
// exemplar-pvp-map.json's fields exactly, plus the optional additions
// described above.
export interface DenseMapFile {
  version: string;
  gridDimensions: { WIDTH: number; HEIGHT: number };
  blockedTiles: boolean[][];
  impassableTiles?: boolean[][];
  scoringTiles: number[][];
  onlyOnceTiles: boolean[][];
  deploymentZones?: {
    creatorZone?: boolean[][];
    joinerZone?: boolean[][];
  };
  mode?: "PvP" | "PvE" | "Both";
  metadata: {
    name?: string;
    createdAt?: string;
    createdBy?: string;
  };
}

function emptyBoolGrid(): boolean[][] {
  return Array.from({ length: GRID_HEIGHT }, () =>
    new Array<boolean>(GRID_WIDTH).fill(false),
  );
}

function emptyNumberGrid(): number[][] {
  return Array.from({ length: GRID_HEIGHT }, () =>
    new Array<number>(GRID_WIDTH).fill(0),
  );
}

function assertDimensions(grid: unknown[][], label: string) {
  if (grid.length !== GRID_HEIGHT) {
    throw new Error(
      `${label}: expected ${GRID_HEIGHT} rows, got ${grid.length}`,
    );
  }
  for (let row = 0; row < grid.length; row++) {
    if (grid[row].length !== GRID_WIDTH) {
      throw new Error(
        `${label}: row ${row} expected ${GRID_WIDTH} cols, got ${grid[row].length}`,
      );
    }
  }
}

function boolGridToPositions(grid: boolean[][]): Position[] {
  assertDimensions(grid, "boolGridToPositions");
  const out: Position[] = [];
  for (let row = 0; row < GRID_HEIGHT; row++) {
    for (let col = 0; col < GRID_WIDTH; col++) {
      if (grid[row][col]) out.push({ row, col });
    }
  }
  return out;
}

function positionsToBoolGrid(positions: Position[]): boolean[][] {
  const grid = emptyBoolGrid();
  for (const { row, col } of positions) {
    if (row < 0 || row >= GRID_HEIGHT || col < 0 || col >= GRID_WIDTH) {
      throw new Error(`positionsToBoolGrid: (${row},${col}) out of bounds`);
    }
    grid[row][col] = true;
  }
  return grid;
}

/** Converts a dense (Map Editor tool) file into the sparse shape Ignition consumes. */
export function denseToSparse(dense: DenseMapFile): SparseMap {
  if (
    dense.gridDimensions.WIDTH !== GRID_WIDTH ||
    dense.gridDimensions.HEIGHT !== GRID_HEIGHT
  ) {
    throw new Error(
      `denseToSparse: grid is ${dense.gridDimensions.WIDTH}x${dense.gridDimensions.HEIGHT}, expected ${GRID_WIDTH}x${GRID_HEIGHT}`,
    );
  }
  assertDimensions(dense.blockedTiles, "blockedTiles");
  assertDimensions(dense.scoringTiles, "scoringTiles");
  assertDimensions(dense.onlyOnceTiles, "onlyOnceTiles");

  const blockedTiles = boolGridToPositions(dense.blockedTiles);

  // impassableTiles is a schema addition — absent (e.g. reading the
  // pre-impassable exemplar) means "no impassable tiles", not an error.
  const impassableTiles = dense.impassableTiles
    ? boolGridToPositions(dense.impassableTiles)
    : [];

  const scoringTiles: ScoringPosition[] = [];
  for (let row = 0; row < GRID_HEIGHT; row++) {
    for (let col = 0; col < GRID_WIDTH; col++) {
      const points = dense.scoringTiles[row][col];
      if (points > 0) {
        scoringTiles.push({
          row,
          col,
          points,
          onlyOnce: !!dense.onlyOnceTiles[row][col],
        });
      }
    }
  }

  const creatorZone = dense.deploymentZones?.creatorZone
    ? boolGridToPositions(dense.deploymentZones.creatorZone)
    : [];
  const joinerZone = dense.deploymentZones?.joinerZone
    ? boolGridToPositions(dense.deploymentZones.joinerZone)
    : [];

  return {
    name: dense.metadata.name,
    mode: dense.mode,
    blockedTiles,
    impassableTiles,
    scoringTiles,
    creatorZone,
    joinerZone,
  };
}

/** Converts a sparse map (generator output, or an Ignition JSON entry) into the dense shape the Map Editor tool reads. */
export function sparseToDense(
  sparse: SparseMap,
  opts?: { createdBy?: string; createdAt?: string },
): DenseMapFile {
  const scoringTiles = emptyNumberGrid();
  const onlyOnceTiles = emptyBoolGrid();
  for (const s of sparse.scoringTiles) {
    if (s.row < 0 || s.row >= GRID_HEIGHT || s.col < 0 || s.col >= GRID_WIDTH) {
      throw new Error(`sparseToDense: scoring (${s.row},${s.col}) out of bounds`);
    }
    scoringTiles[s.row][s.col] = s.points;
    onlyOnceTiles[s.row][s.col] = s.onlyOnce;
  }

  return {
    version: "1.0",
    gridDimensions: { WIDTH: GRID_WIDTH, HEIGHT: GRID_HEIGHT },
    blockedTiles: positionsToBoolGrid(sparse.blockedTiles),
    impassableTiles: positionsToBoolGrid(sparse.impassableTiles),
    scoringTiles,
    onlyOnceTiles,
    deploymentZones: {
      creatorZone: positionsToBoolGrid(sparse.creatorZone),
      joinerZone: positionsToBoolGrid(sparse.joinerZone),
    },
    mode: sparse.mode,
    metadata: {
      name: sparse.name,
      createdAt: opts?.createdAt ?? new Date().toISOString(),
      createdBy: opts?.createdBy ?? "map-design generator",
    },
  };
}
