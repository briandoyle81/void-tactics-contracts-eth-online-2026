"""
Python port of contracts/Maps.sol's Bresenham line walk (_bresenhamMaps /
_isTileBlockedSafe / hasMaps / hasMovementPath), matching
scripts/map-design/los.ts's TypeScript port line-for-line where the two
languages allow. Deliberately re-implemented rather than shared across the
Solidity/TypeScript/Python boundary (see los.ts's own header for why) --
kept textually close to both so all three can be diffed against each other
if hasMaps/hasMovementPath ever change in Maps.sol.

`occupied` here is a Python set of (row, col) tuples -- pass the map's
blocked-tile set for a line-of-sight check, or its impassable-tile set for a
movement-path check.
"""

GRID_WIDTH = 17
GRID_HEIGHT = 11


def in_bounds(row, col):
    return 0 <= row < GRID_HEIGHT and 0 <= col < GRID_WIDTH


def _is_occupied_safe(occupied, row, col):
    # Mirrors Maps.sol's _isTileBlockedSafe: out-of-bounds counts as
    # occupied ("blocked").
    if not in_bounds(row, col):
        return True
    return (row, col) in occupied


def _bresenham(occupied, row0, col0, row1, col1):
    # Mirrors Maps.sol's _bresenhamMaps exactly (permissive-corner mode: a
    # diagonal step is blocked only if BOTH orthogonal flanker cells are
    # occupied, not just one).
    d_row = row1 - row0 if row1 > row0 else row0 - row1
    d_col = col1 - col0 if col1 > col0 else col0 - col1
    s_row = 1 if row1 > row0 else (-1 if row1 < row0 else 0)
    s_col = 1 if col1 > col0 else (-1 if col1 < col0 else 0)

    err = d_col - d_row
    row, col = row0, col0

    while True:
        if row == row1 and col == col1:
            return not _is_occupied_safe(occupied, row, col)

        e2 = err << 1

        if e2 == 0:
            if _is_occupied_safe(occupied, row, col + s_col) and _is_occupied_safe(occupied, row + s_row, col):
                return False
            col += s_col
            err -= d_row
            row += s_row
            err += d_col
            if (row != row1 or col != col1) and _is_occupied_safe(occupied, row, col):
                return False
            continue

        if e2 > -d_row:
            err -= d_row
            col += s_col
            if (row != row1 or col != col1) and _is_occupied_safe(occupied, row, col):
                return False

        if e2 < d_col:
            err += d_col
            row += s_row
            if (row != row1 or col != col1) and _is_occupied_safe(occupied, row, col):
                return False


def has_line_of_sight(blocked, row0, col0, row1, col1):
    """Mirrors Maps.sol's hasMaps. The START tile counts (a shooter standing
    on a blocked tile can't see out either)."""
    if not in_bounds(row0, col0) or not in_bounds(row1, col1):
        raise ValueError("has_line_of_sight: coordinates out of bounds")
    if _is_occupied_safe(blocked, row0, col0):
        return False
    if row0 == row1 and col0 == col1:
        return not _is_occupied_safe(blocked, row1, col1)
    return _bresenham(blocked, row0, col0, row1, col1)


def has_movement_path(impassable, row0, col0, row1, col1):
    """Mirrors Maps.sol's hasMovementPath: whether a ship can move from
    (row0,col0) to (row1,col1) without its path crossing an impassable
    tile -- blocks landing ON one AND passing THROUGH one. Deliberately
    does NOT apply has_line_of_sight's "start tile counts" rule -- a ship
    already standing on a tile must always be able to leave it."""
    if not in_bounds(row0, col0) or not in_bounds(row1, col1):
        raise ValueError("has_movement_path: coordinates out of bounds")
    if row0 == row1 and col0 == col1:
        return True
    return _bresenham(impassable, row0, col0, row1, col1)
