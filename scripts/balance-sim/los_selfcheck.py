"""
Fixture cross-check for los.py's port of Maps.sol's LOS/movement-path walk.
Same cases as scripts/map-design/los.selfcheck.ts (each itself copied from a
passing test/Maps.test.ts assertion), so all three implementations
(Solidity, TypeScript, Python) are checked against the same ground truth.

Run with: python3 scripts/balance-sim/los_selfcheck.py
"""
from los import has_line_of_sight, has_movement_path

failures = 0


def check_los(name, blocked_list, row0, col0, row1, col1, expected):
    global failures
    blocked = set(blocked_list)
    actual = has_line_of_sight(blocked, row0, col0, row1, col1)
    if actual != expected:
        failures += 1
        print(f"FAIL has_line_of_sight: {name} -- expected {expected}, got {actual}")
    else:
        print(f"ok   has_line_of_sight: {name}")


def check_path(name, impassable_list, row0, col0, row1, col1, expected):
    global failures
    impassable = set(impassable_list)
    actual = has_movement_path(impassable, row0, col0, row1, col1)
    if actual != expected:
        failures += 1
        print(f"FAIL has_movement_path: {name} -- expected {expected}, got {actual}")
    else:
        print(f"ok   has_movement_path: {name}")


check_los("clear LOS on horizontal line", [], 5, 2, 5, 8, True)
check_los("clear LOS on vertical line", [], 2, 5, 8, 5, True)
check_los("clear LOS on diagonal line", [], 2, 2, 6, 6, True)
check_los("clear LOS on same position", [], 5, 5, 5, 5, True)

check_los("blocked by single obstacle on horizontal line", [(5, 5)], 5, 2, 5, 8, False)
check_los("blocked by single obstacle on vertical line", [(5, 5)], 2, 5, 8, 5, False)
check_los("blocked by single obstacle on diagonal line", [(4, 4)], 2, 2, 6, 6, False)

check_los("permissive corner -- single flanker blocked stays clear", [(3, 2)], 2, 2, 4, 4, True)
check_los("permissive corner -- both flankers blocked blocks LOS", [(3, 2), (2, 3)], 2, 2, 4, 4, False)

check_los("steep diagonal line stays clear", [], 1, 1, 8, 2, True)
check_los("shallow diagonal line stays clear", [], 1, 1, 2, 8, True)

check_path("clear with no impassable tiles", [], 5, 2, 5, 8, True)
check_path("blocks landing ON an impassable destination", [(5, 8)], 5, 2, 5, 8, False)
check_path("blocks passing THROUGH an impassable cell strictly between start/end", [(5, 5)], 5, 2, 5, 8, False)
check_path("NOT blocked by an impassable tile adjacent but off the line", [(4, 5)], 5, 2, 5, 8, True)
check_path("a ship may always leave a tile that is itself impassable", [(5, 2)], 5, 2, 5, 8, True)
check_path("staying on the same tile is always clear", [(5, 5)], 5, 5, 5, 5, True)

if failures > 0:
    print(f"\n{failures} fixture(s) failed.")
    raise SystemExit(1)
else:
    print("\nAll los.py fixtures match Maps.sol's on-chain behavior.")
