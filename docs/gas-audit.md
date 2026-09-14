# Void Tactics — Gas Efficiency Audit

_Created 2026-09-12._ Scope: on-chain runtime/deployment gas cost, not correctness or security
(see `docs/pre-audit.md`/`docs/audit-2.md` for those). Explicitly out of scope per the request
that prompted this doc: Yul/inline assembly, `unchecked{}` micro-optimizations, `++i` vs `i++`,
single-parameter calldata/memory nitpicks, and single-field struct-packing tweaks — the bar here
is "this materially wastes gas for a real caller, and the fix is normal, readable Solidity."

This is audit-only, matching this project's established workflow: findings are recorded here,
not implemented, until the project owner picks one to fix. No `.sol` files were changed while
writing this doc.

This pass also deliberately does **not** re-litigate `docs/pre-audit.md`'s "Growth Audit at
Scale" addendum (`GR-01` through `GR-06`) — that addendum already thoroughly covers unbounded
`view`-function array growth (the "off-chain caller can no longer fetch this" class of problem).
This doc instead focuses on **on-chain transaction cost**: redundant work paid for by a real
caller in a normal turn/action, found by reading through the largest, most frequently-executed
write paths (`Game.sol`, `AIBehavior.sol`, `Fleets.sol`, `Maps.sol`, `Tournament.sol`,
`RoguelikeMatch.sol`/`SinglePlayerMatch.sol`, `Ships.sol`, `Lobbies.sol`, `ShipAttributes.sol`,
`SpecialEffectsLib.sol`, and the effect-resolver contracts) and verifying each candidate against
real call sites before flagging it as material.

After a thorough sweep, only two findings clearly cleared the "large, real, readable-fix" bar,
plus one moderate one — this doc reports exactly that rather than padding it out.

---

## Significant

### ~~G-01 — `AIBehavior`'s Per-Candidate Attribute Lookup Is an Unnecessary O(n) Scan Inside an O(n) Loop~~

**File:** `contracts/AIBehavior.sol`, `findAttributes` (66-75), called from `_bestEnemyInRange`
(96-159), `_bestAllyToHeal` (177-213), `_nearestEnemyPosition` (221-256), `_allyCanCoverTile`
(355-371), `_enemyThreatensTile` (376-403); also `contracts/RoguelikeMatch.sol` /
`contracts/SinglePlayerMatch.sol`, both `_findUnmovedShip` (identical in each file)

Every one of `AIBehavior`'s targeting/threat helpers loops once over `ctx.g.shipPositions`
(bounded by the 44-ships-per-side fleet cap, so up to 88 total), and for **each candidate**
inside that loop calls `findAttributes(ctx.g, shipId)` — which does its own full linear scan over
`ctx.g.shipIds` (up to 88) just to find the matching `Attributes` entry. That makes every one of
these helpers O(n²) (up to ~7,700 comparisons) where it should be O(n), and `takeAITurn` calls
several of these helpers per decision (e.g. `_shouldHoldScoringTile` alone calls
`_nearestEnemyPosition`, `_bestEnemyInRange`, `_allyCanCoverTile`, and `_enemyThreatensTile` in
sequence), stacking multiple O(n²) sweeps into a single AI turn. This is entirely memory-only
work (no storage read inside the inner scan), but the sheer iteration count is real and scales
with fleet size — the gas reporter's own `takeAITurn` numbers (424k–788k gas/call across the
existing test suite, small test fleets) show this is already a meaningfully expensive call before
accounting for what happens at the 44-ship-per-side cap this scan is bounded by.

**Root cause, confirmed by reading `Game.getGame`:** `findAttributes`'s linear scan is redundant
by construction, not just in principle. `Game.getGame()` (`Game.sol:1323-1392`) builds
`shipIds`/`shipAttributes` from `creatorActiveShipIds` then `joinerActiveShipIds`, in that order,
and `shipPositions` (via `getAllShipPositions` → `_fillActiveShipPositions`) from the exact same
two id sets in the exact same order, before appending a separate tail of "gone" (fled/destroyed)
ship entries. That means for every index `i` where `shipPositions[i].status == 0` (i.e. an active
ship — the only case any of these helpers ever calls `findAttributes` for, since every helper
already filters on `status != 0` first), `shipPositions[i].shipId == shipIds[i]` and
`shipAttributes[i]` is already that exact ship's attributes — the scan is looking for something
already sitting at the same index.

**Suggested fix:** don't rely on that index alignment implicitly inside `AIBehavior` (a fragile
coupling to `Game.getGame`'s current construction order) — instead, build a proper `shipId =>
Attributes` lookup **once** per `takeAITurn` call, in plain memory, and pass it through `Ctx`.
Concretely: since `Game.getGame()` already knows the boundary between "active" and "gone" ships
(and already iterates the same id sets twice to build the two arrays), the cheapest genuinely
correct fix is for `Game.sol` itself to expose the two arrays pre-joined (either by writing
`Attributes` directly onto `ShipPosition` in `GameDataView`, or by guaranteeing/documenting the
index-alignment `AIBehavior` already relies on informally) so `findAttributes` can become a
straight `ctx.g.shipAttributes[i]` index read wherever the caller already has `i` from the
`shipPositions` loop, with no scan at all. This turns every one of the O(n²) helpers above into a
straight O(n) pass — a real, large reduction at the 44v44 fleet cap, using only plain, readable
Solidity (documenting/asserting an existing invariant, or restructuring one struct), no
assembly.

**Bytecode tradeoff:** `AIBehavior` is a pure/view library, inlined into whichever contract
imports it. It's imported by `SinglePlayerMatch.sol` (19.129/24.576 KiB deployed — ~5.4 KiB
headroom) and `RoguelikeMatch.sol` (22.249/24.576 KiB deployed — **only ~2.3 KiB headroom**,
tighter than it looks). The suggested fix removes a scanning loop and replaces it with a direct
index read, so it should shrink bytecode in both, not grow it — but that must be confirmed by
measuring after implementation, especially given `RoguelikeMatch.sol`'s thin margin.

**Status: Fixed 2026-09-13.** Re-verified the index-alignment claim directly against
`Game.sol:getGame`/`getAllShipPositions`/`_fillActiveShipPositions` before touching anything:
confirmed `shipAttrs`/`shipIds` and `shipPositions`' active range are both built from
`creatorShipIds` then `joinerShipIds` (the same two `EnumerableSet`s, same `EnumerableSet.at(set,
i)` calls, same order), within one atomic `view` call, and that `_removeShipFromGame` always sets
a nonzero `status` on the same ship it pushes to `goneShipIds`, in the same transaction — so
`shipPositions[i].status == 0` is a sound, storage-level guarantee that index `i` is in the active
range with `shipAttributes[i]` matching, not a fragile coincidence.

Went with the audit's option (b), not the bigger `GameDataView` restructuring floated as an
alternative: kept `findAttributes`/`GameDataView`'s shape entirely unchanged (still used correctly
for the genuine one-off single-`shipId` lookups in `SinglePlayerMatch._decideMove`/
`RoguelikeMatch._decideMove`, which are O(n) once per ship turn and fine), and only changed the
five in-loop callers that already have index `i` in scope: `AIBehavior._bestEnemyInRange`,
`_bestAllyToHeal`, `_nearestEnemyPosition`, `_allyCanCoverTile`, `_enemyThreatensTile` now read
`ctx.g.shipAttributes[i]` directly instead of calling `findAttributes(ctx.g, sp.shipId)`. Also
found and fixed the same pattern in a spot the audit doc's line citation didn't quite land on
correctly (it named `_findUnmovedShip`; the actual call site is `_hasAnyLiveShip`, identical in
both `SinglePlayerMatch.sol` and `RoguelikeMatch.sol`): it looped `g.joinerActiveShipIds[i]`
through `findAttributes` per candidate — fixed by reading `g.shipAttributes[creatorActiveShipIds.
length + i]` directly, using the same construction-order guarantee. Added an `INVARIANT` doc
comment directly on `Game.sol:getGame` (not just in this doc) warning that changing this
construction order would silently break these callers' direct index reads — a future refactor of
`getGame` should see it there, not only here.

Bytecode measured after: `RoguelikeMatch.sol` **21.686/24.576 KiB deployed (22.252 KiB
initcode)** — essentially flat (+3 bytes deployed vs. before the fix, within noise; the "should
shrink" prediction above didn't quite hold for this contract specifically, though the effect is
negligible against its ~2.9 KiB headroom). `SinglePlayerMatch.sol` **19.115/24.576 KiB deployed
(19.617 KiB initcode)** — shrank ~14 bytes, matching the prediction. Both comfortably within the
limit either way; noted here rather than silently letting the doc's prediction stand uncorrected.

Verified genuine: rather than a from-scratch new test (this is a pure refactor of already-tested
decision logic — same inputs must produce byte-identical outputs), deliberately broke the fix
(XOR'd every new direct index with 1, and added a `+ 1` offset bug to both `_hasAnyLiveShip`
copies), recompiled, and confirmed 19 existing tests across `SinglePlayerMatch.test.ts`/
`RoguelikeMatch.test.ts`/`Game.test.ts` went red — proving the existing suite already provides
real regression coverage for this exact logic, not just superficial pass-through. Restored the
real fix from a backup and reconfirmed clean. Full suite re-run afterward: exit code 0, no
regressions (`PRODUCTION` confirmed `false` beforehand).

### ~~G-02 — `Fleets.removeShipFromFleet` Shifts the Entire Array Instead of Swap-and-Pop, Costing Up to ~43 Extra `SSTORE`s~~

**File:** `contracts/Fleets.sol`, `removeShipFromFleet` (195-220)

```solidity
for (uint i = 0; i < fleet.shipIds.length; i++) {
    if (fleet.shipIds[i] == _shipId) {
        // Remove ship from array by shifting elements
        for (uint j = i; j < fleet.shipIds.length - 1; j++) {
            fleet.shipIds[j] = fleet.shipIds[j + 1];
        }
        fleet.shipIds.pop();
        ...
```

Removing a ship writes every subsequent element back one slot to preserve order — each
`fleet.shipIds[j] = fleet.shipIds[j + 1]` is a real `SSTORE`. Fleets are capped at 44 ships per
side (the same grid-column cap referenced throughout `docs/pre-audit.md`'s growth audit), so
removing the *first* ship added to a full fleet costs **43 storage writes** to shift everything
down by one slot, plus the final `pop()` — versus the two storage operations a swap-and-pop
would need (overwrite the removed slot with the last element, then `pop()`). At today's real gas
costs that's the difference between roughly 2 `SSTORE`s and over 40, a large, direct cost paid by
whichever player/contract call triggers this (fleet management during roster changes, `DroneYard`
modifications, roguelike resupply roster edits — anywhere `Fleets.removeShipFromFleet` is
reachable).

**No ordering dependency found:** checked every read of `fleet.shipIds` in this codebase (`Fleets.sol`
itself, `Game.sol`) — nothing indexes into `fleet.shipIds` positionally or otherwise depends on
insertion order surviving a removal; it's consumed purely as a membership list.

**Suggested fix — swap-and-pop, already this repo's own established pattern for exactly this
situation:** `NodeMap.sol`'s `_removeFromCampaignNodeIds` (240-258) and
`RoguelikeNodeMap.sol`'s `removeChild` (276-288) both already use, and explicitly comment, this
exact technique ("swap-and-pop — order doesn't matter... same pattern as..."). `Fleets.sol` is
the one place in this codebase still using the expensive shift approach for an order-independent
collection — bringing it in line with the existing convention is a small, obviously-correct,
already-precedented change:

```solidity
for (uint i = 0; i < fleet.shipIds.length; i++) {
    if (fleet.shipIds[i] == _shipId) {
        fleet.shipIds[i] = fleet.shipIds[fleet.shipIds.length - 1];
        fleet.shipIds.pop();
        // ... unchanged cost-read/emit logic below ...
        break;
    }
}
```

**Bytecode tradeoff:** `Fleets.sol` is at 7.607 KiB deployed against the 24.576 KiB limit — ample
headroom (~17 KiB). This fix is also very unlikely to grow bytecode at all (it deletes the inner
`for` loop entirely), so there's no tradeoff to weigh here.

**Status: Fixed 2026-09-13.** Before implementing, traced a real ordering dependency the "no
ordering dependency found" claim above missed: `Fleet.shipIds[i]` and `Fleet.startingPositions[i]`
*are* positionally paired (both filled together in `createFleet`, and `Game._placeShipsOnGrid`
reads them back paired: `Position memory pos = creatorPositions[i]` against `creatorShipIds[i]`).
Confirmed this doesn't block the fix, though: `removeShipFromFleet`'s only callers are
`Game._removeShipFromGame` (`Game.sol:1201/1203`), reachable only *after* a game has already
started — i.e. after `_placeShipsOnGrid`/`_initializeFleetAttributes` already consumed
`startingPositions` positionally for that fleet, once. `Fleets.createFleet` increments
`fleetCount` unconditionally (no fleetId is ever reused for a second game), so no later read ever
re-pairs `shipIds` against `startingPositions` for a fleet that's had a removal. `startingPositions`
was already left stale (untouched, wrong length) by the *old* shift-based code too — swap-and-pop
doesn't newly break anything here, it's dead data either way by the time removal can happen. Not
writing this up as a separate finding since it's provably unreachable (same standard as
`pre-audit.md`'s L-03).

Applied the suggested swap-and-pop exactly as sketched. Bytecode measured: **7.308/24.576 KiB
deployed (7.576 KiB initcode)**, down from 7.339 KiB deployed pre-fix — shrank as predicted, ~17
KiB headroom untouched.

New test in `test/Game.test.ts` (`"Fleets.removeShipFromFleet (G-02)"` describe block): creates a
3-ship fleet directly against `Fleets` (bypassing `Lobbies`, via `setIsAllowedToManageFleets`, to
isolate the removal logic), removes the **middle** ship (index 1 of 3 — exercises the actual swap,
not a trivial last-element pop), and asserts the remaining `shipIds` are exactly the other two
(order-independent), `totalCost` decremented correctly, and `inFleet` flipped false only for the
removed ship.

Verified genuine: since a correct swap-and-pop and the old shift-based code produce the *same*
external membership result (only their storage mechanics differ), reverting to the old shift code
wouldn't turn this test red. Instead, deliberately broke the *new* code the way a plausible
swap-and-pop bug would look — dropped the swap line, leaving a bare `fleet.shipIds.pop()` — which
incorrectly discards the *last* element instead of the targeted one; confirmed the new test caught
it (red), then restored the real fix from a backup and reconfirmed clean. Full suite re-run
afterward: exit code 0, no regressions (`PRODUCTION` confirmed `false` beforehand).

---

## Moderate

### ~~G-03 — `Maps.hasMaps`/`_bresenhamMaps` Re-Reads `blockedTilesBitmap[_gameId]` From Storage on Every Step Instead of Caching It Once~~

**File:** `contracts/Maps.sol`, `_isTileBlockedSafe` (752-761), called repeatedly from
`hasMaps`/`_bresenhamMaps` (790-905)

`_isTileBlockedSafe` re-derives `blockedTilesBitmap[_gameId]`'s mapping slot and reads it from
storage on every call, and `_bresenhamMaps`'s Bresenham walk calls it up to 2-3 times per step
across a path that can be ~25+ steps long (this game's grid is 17×11) — so a single `hasMaps`
call (itself called once per ranged shot with line-of-sight, i.e. on every non-adjacent `Shoot`
action in `Game._performShoot`) can re-read the exact same, unchanging storage value 50-80 times
within one call. Thanks to EIP-2929 warm-slot pricing, repeat accesses to the same slot within one
transaction cost ~100 gas rather than a fresh cold-read's ~2,100, so this isn't a "large" cost in
isolation the way G-01/G-02 are, but it is real, avoidable, per-shot overhead on one of the most
frequently executed actions in the game (every ranged attack beyond range 1).

**Suggested fix:** read `blockedTilesBitmap[_gameId]` into a local `uint256` once at the top of
`hasMaps` (or `_bresenhamMaps`), and change `_isTileBlockedSafe` (or an overload of it) to accept
that cached bitmap by value instead of re-indexing the mapping on every call — a small, purely
mechanical change (thread one extra parameter through a handful of internal calls), no change to
the actual bit-check logic or the Bresenham algorithm itself.

**Bytecode tradeoff:** `Maps.sol` is at 12.453 KiB deployed — comfortable headroom (~12 KiB), no
size concern for a fix this small.

**Status: Fixed 2026-09-13.** Applied exactly the suggested fix: `_isTileBlockedSafe` now takes
the bitmap as a `uint256` parameter instead of a `_gameId` (and dropped from `view` to `pure`,
since it no longer touches storage — a small correctness signal that it's genuinely side-effect-
free now, not just a style nicety). `hasMaps` reads `blockedTilesBitmap[_gameId]` into a local
once and threads it to both its own `_isTileBlockedSafe` calls and into `_bresenhamMaps`, whose
`_gameId` parameter was replaced with the same bitmap (it had no other use for `_gameId` — verified
by checking its full body before removing the parameter) and which also dropped to `pure`. All 6
call sites inside the Bresenham walk updated to match. `isTileBlocked` (the separate public
single-call getter at line ~683) was left untouched — it's one read per call, not in a loop, so
outside G-03's scope.

Bytecode measured after: **12.329/24.576 KiB deployed (12.485 KiB initcode)** — a small net
increase (~13 bytes) rather than a decrease; the extra `pure`-vs-`view` bookkeeping and parameter
threading outweighed the loop-body simplification at this scale. Negligible against Maps.sol's
~12 KiB headroom, noted honestly rather than left unmeasured.

Verified genuine: existing `test/Maps.test.ts` already has extensive `hasMaps`/line-of-sight
coverage, so rather than adding a redundant new test for unchanged behavior, deliberately broke
the fix (set the cached `bitmap` to a hardcoded `0`, i.e. "nothing is ever blocked") and confirmed
10 existing tests in that file went red. Restored the real fix from a backup and reconfirmed
clean. Full suite re-run afterward: exit code 0, no regressions (`PRODUCTION` confirmed `false`
beforehand).

All three findings in this doc (G-01, G-02, G-03) are now fixed.

---

## Reviewed, no material issue found

- **`UTCLotteryHook.resolveDraw`'s winner-search loop** (`UTCLotteryHook.sol:409-415`) — reads
  `weightInDraw[_drawId][participants[i]]` once per participant and breaks the instant the
  winner is found (average-case early exit, not a full traversal); each read is genuinely needed
  data, not redundant. No fix suggested.
- **`SpecialEffectsLib.resolveAndApply`'s allocate-worst-case-then-shrink pattern**
  (`SpecialEffectsLib.sol:94-129`) — already uses a single-pass fill plus an `assembly`
  length-shrink (Yul, and explicitly out of scope for this doc, but noted as evidence this
  codebase already knows and uses the efficient pattern elsewhere).
- **`Maps._unpackBitmap`'s two-pass count-then-fill** (`Maps.sol:505-524`) — already has an
  in-code comment explaining why the fixed 187-cell double pass was kept: it's only ever reached
  from `view` functions with no on-chain caller, so this is an off-chain-cost tradeoff already
  made deliberately, not an oversight.
- **`Game._getMovedShipIds`'s two-pass count-then-fill** (`Game.sol:897-931`) — called on-chain
  (via `Game.getGame()`, itself called from `SinglePlayerMatch`/`RoguelikeMatch`/`PvPMatch`).
  Looked closely at this since it re-walks each player's active-ship set twice via
  `EnumerableSet.at`/`.contains`. Under EIP-2929, the second pass's repeat accesses to the same
  slots are warm (~100 gas) rather than a full re-read, so the real waste here is modest (roughly
  200 gas per ship in the worst case) — real, but well short of the "large" bar this doc is
  holding to, especially next to G-01/G-02 above.
- **`RoguelikeMatch`/`SinglePlayerMatch._findUnmovedShip`'s nested "is this ship in the moved
  list" scan** — same root cause as G-01 (calls `AIBehavior.findAttributes`, and separately does
  an O(active × moved) membership scan, both memory-only). Not written up as its own finding
  since fixing G-01's `findAttributes` root cause removes the `findAttributes` portion of this
  cost automatically; the remaining moved-list scan is bounded by 44×44 memory comparisons
  (cheap) and not worth a separate, less-readable fix (e.g. a memory bitmap) on its own.
