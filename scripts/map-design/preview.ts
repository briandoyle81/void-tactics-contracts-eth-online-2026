// Human-review aids. The PRIMARY review path is exporting a generated map
// through dense-grid-format.ts's sparseToDense and opening the result in
// the real external Map Editor tool (see difficulty-table.ts's header and
// review-all.ts) — there's no on-chain/visual map renderer, so that's by
// far the strongest way to actually judge a layout. renderAscii here is
// the secondary, CLI-only fast sanity check: no editor round-trip needed,
// good for scanning many maps at once or debugging headlessly.

import * as fs from "fs";
import { GRID_HEIGHT, GRID_WIDTH } from "./los";
import { SparseMap } from "./dense-grid-format";
import { Position } from "./formations";

function positionKey(p: Position): string {
  return `${p.row},${p.col}`;
}

// One character per cell:
//   .  open
//   #  hard cover (blocked + impassable)
//   %  soft cover (blocked only -- flyable through, blocks LOS)
//   !  movement hazard (impassable only -- transparent, un-landable)
//   O  the main (highest-value) scoring tile
//   o  a flanking hold scoring tile
//   c  / j  creator / joiner deployment zone (only shown if a custom zone
//      is set -- the default band is never annotated, to keep dense maps
//      readable)
//   A  an AI formation spawn position, if supplied
export function renderAscii(map: SparseMap, formationPositions: Position[] = []): string {
  const blocked = new Set(map.blockedTiles.map(positionKey));
  const impassable = new Set(map.impassableTiles.map(positionKey));
  const creatorZone = new Set(map.creatorZone.map(positionKey));
  const joinerZone = new Set(map.joinerZone.map(positionKey));
  const formation = new Set(formationPositions.map(positionKey));

  const maxPoints = map.scoringTiles.reduce((m, s) => Math.max(m, s.points), 0);
  const scoringByPos = new Map(map.scoringTiles.map((s) => [positionKey(s), s]));

  const lines: string[] = [];
  lines.push(`Map: ${map.key ?? "(unnamed)"} — ${map.name ?? ""} [${map.mode ?? "?"}]`);
  lines.push(
    "   " + Array.from({ length: GRID_WIDTH }, (_, c) => (c % 10).toString()).join(""),
  );
  for (let row = 0; row < GRID_HEIGHT; row++) {
    let line = `${row.toString().padStart(2)} `;
    for (let col = 0; col < GRID_WIDTH; col++) {
      const key = `${row},${col}`;
      const scoring = scoringByPos.get(key);
      let ch: string;
      if (scoring) {
        ch = scoring.points >= maxPoints ? "O" : "o";
      } else if (formation.has(key)) {
        ch = "A";
      } else if (blocked.has(key) && impassable.has(key)) {
        ch = "#";
      } else if (blocked.has(key)) {
        ch = "%";
      } else if (impassable.has(key)) {
        ch = "!";
      } else if (creatorZone.has(key)) {
        ch = "c";
      } else if (joinerZone.has(key)) {
        ch = "j";
      } else {
        ch = ".";
      }
      line += ch;
    }
    lines.push(line);
  }
  lines.push(
    "Legend: . open | # hard cover | % soft cover | ! movement hazard | O objective | o hold | A AI spawn | c/j custom deployment zone",
  );
  return lines.join("\n");
}

// Writes a dense-grid JSON file for the real Map Editor tool. Returns the
// path written to.
export function exportDenseGridFile(
  outDir: string,
  key: string,
  denseJson: unknown,
): string {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const filePath = `${outDir}/${key}.json`;
  fs.writeFileSync(filePath, JSON.stringify(denseJson, null, 2));
  return filePath;
}
