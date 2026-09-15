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

## Second Pass (2026-09-13)

_Follow-up sweep, prompted by: "Do another look for time or space complexity flaws, or
unnecessary SLOADs or SSTOREs."_ Widened coverage to contracts the first pass didn't focus on
(`DroneYard.sol`, `GenerateNewShip.sol`, `RoguelikeNodeMap.sol`, `NodeMap.sol`,
`NodeContentRegistry.sol`, `RandomManager.sol`, `ShipPurchaser.sol`, `RoguelikeRun.sol`,
`RoguelikeResupply.sol`, `AIEncounters.sol`, `AIShips.sol`, `ShipsRouter.sol`, `DroneNames.sol`,
`GameResults.sol`, `PvPMatch.sol`, `UTCLotteryHook.sol`, `RenderMetadata.sol`, `TutorialClaim.sol`,
`FreeShipClaim.sol`, `ShatteredHiveMedal.sol`), plus a second, more mechanical look at
`Game.sol`/`Ships.sol`/`Lobbies.sol`/`Tournament.sol`/`Maps.sol` themselves for the specific
patterns asked about: a storage slot/struct field read more than once when a local could cache it,
a `Struct storage` reference re-derived multiple times instead of held once, and any realistic
O(n²)-or-worse growth. Same ground rules as the first pass (Yul, `unchecked{}`, `++i`/`i++`,
calldata-vs-memory nitpicks, and single-field struct packing stay out of scope; `docs/pre-audit.md`
GR-01 through GR-06 stay un-relitigated).

Four more findings cleared the bar — three Significant, one Moderate.

### ~~G-04 — Four Orchestrator Call Sites Pay `Game.getGame()`'s Full O(active+gone ships) Cost Just to Read a Few `metadata`/`turnState` Scalars~~

**File:** `contracts/PvPMatch.sol`, `flee` (103-104) and `endGameOnTimeout` (122-123);
`contracts/RoguelikeMatch.sol`, inline in the node-completion handler (444);
`contracts/Tournament.sol`, `resolveDraw` (496-509)

`Game.getGame(_gameId)` is expensive by design — it iterates both players' `EnumerableSet`s to
build `shipIds`/`shipAttributes`, calls `getAllShipPositions` (a full active-ships-plus-`goneShipIds`
walk), and calls `_getMovedShipIds` twice (once per player, each already a two-pass scan — see this
doc's own "Reviewed" section on that). That's the right cost for a caller that actually needs ship
data (`SinglePlayerMatch.takeAITurn`/`RoguelikeMatch.takeAITurn` both do, and were checked — not a
finding). But four call sites call it and then only ever touch `g.metadata.*`/`g.turnState.*`,
scalar fields that don't depend on ship data at all:

- `PvPMatch.flee` — reads only `metadata.ended`/`metadata.creator`/`metadata.joiner`, to let either
  player concede on the spot. One of the most ordinary actions in the game.
- `PvPMatch.endGameOnTimeout` — reads only `turnState.turnStartTime`/`turnState.turnTime`/
  `turnState.currentTurn`/`metadata.creator`/`metadata.joiner`, to let the non-stalling player force
  a timeout loss.
- `RoguelikeMatch`'s node-completion handler — `fleets.clearFleet(game.getGame(_gameId).metadata.
  creatorFleetId)` discards the *entire* returned `GameDataView` for one `uint` field.
- `Tournament.resolveDraw` — reads only `gd.metadata.ended`/`.winner`/`.creator`/`.joiner`, to
  verify a bracket match actually ended in a draw before advancing it.

`games` (the underlying `mapping(uint => GameData)`) can't be made `public` for a cheap
auto-getter — `GameData` has mappings nested inside it (`shipAttributes`, `shipPositions`, `grid`,
etc.), which Solidity doesn't allow in a public-getter return type. No existing lighter getter
covers this either (checked every `function get*` in `Game.sol`).

**Suggested fix:** add one small, dedicated view function to `Game.sol`, e.g.:

```solidity
function getGameMetadataAndTurnState(
    uint _gameId
) external view returns (GameMetadata memory, GameTurnState memory) {
    _requireGameExists(_gameId);
    GameData storage game = games[_gameId];
    return (game.metadata, game.turnState);
}
```

Both structs are plain value types (no nested mappings), so this is two flat struct copies, no
loops, no external calls, no `EnumerableSet` work — O(1) instead of `getGame`'s O(active+gone
ships). Switch all four call sites above to it.

**Bytecode tradeoff — the real constraint here:** `Game.sol` is at **24.000/24.576 KiB deployed —
zero spare bytes** (confirmed via `npx hardhat compile`'s contract-sizer table; this is the same
zero-headroom state the HA2-01 security fix landed it at). Any new external function, however
small, needs an equal-or-greater offsetting reduction found elsewhere in `Game.sol` first (or as
part of the same change) — this fix cannot land as a pure addition today. `PvPMatch.sol` (5.153
KiB deployed, ample headroom) and `Tournament.sol` (17.839 KiB deployed, ample headroom) have no
such constraint on the caller side; switching them to a smaller return type should cost those two
contracts a few bytes at most, likely nothing.

**Headroom update 2026-09-15:** G-07 alone only freed 19 bytes — not enough. See G-08 below: a
targeted follow-up sweep (dead-code removal + duplicated-loop dedup, unrelated to any specific
finding above) freed **607 more bytes**, landing `Game.sol` at **23,950/24,576 bytes deployed
(626 bytes of real headroom)**. G-04 is now unblocked — implemented below.

**Status: Fixed 2026-09-15.** Added `getGameMetadataAndTurnState(uint _gameId)` to `Game.sol`
exactly as suggested — `_requireGameExists` then `return (game.metadata, game.turnState);`, two
flat struct copies, no loops. Switched all four call sites: `PvPMatch.flee`/`endGameOnTimeout` now
destructure `(GameMetadata memory metadata, GameTurnState memory turnState)` instead of the full
`GameDataView`; `RoguelikeMatch`'s node-completion handler now destructures just the metadata it
needs for `fleets.clearFleet(gameMetadata.creatorFleetId)`; `Tournament.sol`'s `IGameReader`
interface (a project-local minimal interface for the deployed `Game` contract) gained a matching
`getGameMetadataAndTurnState` signature, and `resolveDraw` was switched to it. Every field
reference at all four call sites was re-verified against current source before touching anything
(re-confirmed `Tournament.resolveDraw` also reads `.startedAt`, not just the three fields the
original finding listed — still just a `.metadata` field, covered either way).

Bytecode measured: `Game.sol` **24,329/24,576 bytes deployed (247 bytes headroom left)** — the new
function cost 379 bytes, more than the "100+ bytes" estimate but comfortably inside the 626-byte
budget G-08 freed. The bigger surprise was on the caller side: the doc predicted "a few bytes at
most, likely nothing" for `PvPMatch`/`Tournament`, but both **shrank substantially** —
`PvPMatch.sol` 5.153 → 3.506 KiB deployed (−1.647 KiB), `Tournament.sol` 17.839 → 16.259 KiB
deployed (−1.580 KiB). Reason, confirmed by reasoning through Solidity's codegen: `GameDataView`
contains several dynamic arrays (`shipAttributes`, `shipPositions`, `shipIds`,
`creatorActiveShipIds`, `joinerActiveShipIds`, `creatorMovedShipIds`, `joinerMovedShipIds`) —
decoding that full return type at a call site needs real ABI-decode bytecode, which the compiler
was generating at every `getGame()` call site in these files. `GameMetadata`/`GameTurnState` are
plain fixed-size structs, so their decode routine is far smaller — removing the last/only
`getGame()` call in each of these two files eliminated the large decoder entirely, not just
shrunk it. `RoguelikeMatch.sol` grew slightly (21.686 → 21.744 KiB, +59 bytes) since it still has
a separate `getGame()` call elsewhere (`takeAITurn`, which genuinely needs ship data) — it pays
for both decoders now, a net addition as expected.

Verified genuine: existing test suites already exercise all four call sites end-to-end
(`test/PvPMatch.test.ts`, `test/RoguelikeMatch.test.ts`, `test/Tournament.test.ts` — 137 tests
combined across the four affected files, all passing with zero rewrites, confirming this is a
behavior-preserving refactor). Deliberately broke each of the three non-`Game.sol` call sites the
way a plausible field-mixup would look: swapped `PvPMatch.flee`'s winner-selection ternary
(assigns the *caller* as winner instead of the other player), swapped `RoguelikeMatch`'s fleet
clear to `joinerFleetId` instead of `creatorFleetId`, and dropped one branch of
`Tournament.resolveDraw`'s `ok` check (only accepted one creator/joiner-vs-player1/player2
ordering instead of both). Confirmed **12 tests went red** across the three files. Restored all
three from backups and reconfirmed byte-identical. Full suite re-run afterward: exit code 0, no
regressions (`PRODUCTION` confirmed `false` beforehand).

### ~~G-05 — `DroneYard.modifyShip` Fetches `ships.getShip(_shipId)` Three Separate Times for the Same Immutable-Within-the-Call Ship~~

**File:** `contracts/DroneYard.sol`, `modifyShip` (146-196), `validateShip` (104-139),
`calculateCostToModify` (66-97)

`modifyShip` is the single entry point a player uses to re-equip/re-customize a ship they own. Its
body:

```solidity
function modifyShip(uint _shipId, Ship memory _newShip) public nonReentrant {
    Ship memory currentShip = ships.getShip(_shipId);      // call #1
    ...
    validateShip(_shipId, _newShip);                       // -> ships.getShip(_shipId) again, call #2
    ...
    uint cost = calculateCostToModify(_shipId, _newShip);  // -> ships.getShip(_shipId) again, call #3
    ...
}
```

`validateShip` and `calculateCostToModify` are each `public view` (so a frontend can call either
standalone to preview validity/cost before submitting) and each independently re-fetches
`ships.getShip(_shipId)` from scratch rather than accepting the ship data as a parameter. Nothing
about `_shipId`'s on-chain ship state can change between these three reads within one
`modifyShip` transaction, so calls #2 and #3 are pure waste: each is a full cross-contract `CALL`
(base overhead plus argument/return ABI encoding of a `Ship` struct — nested `Traits`,
`Equipment`, `ShipData` sub-structs), not just a repeat `SLOAD` — meaningfully more expensive than
a same-contract redundant read, and the kind of cost `EIP-2929` warm-slot pricing does **not**
discount.

**Suggested fix:** keep the public `validateShip(uint, Ship memory)`/`calculateCostToModify(uint,
Ship memory)` signatures for frontend previewing, but have each be a thin wrapper that fetches
once and delegates to an internal, `Ship`-accepting version:

```solidity
function validateShip(uint _shipId, Ship memory _newShip) public view returns (bool) {
    return _validateShip(ships.getShip(_shipId), _newShip);
}

function _validateShip(Ship memory currentShip, Ship memory _newShip) internal pure returns (bool) {
    if (currentShip.id == 0) revert InvalidModification();
    ... // unchanged body, operating on the passed-in struct
}
```

(same shape for `calculateCostToModify`/`_calculateCostToModify`), then have `modifyShip` call
`_validateShip(currentShip, _newShip)` and `_calculateCostToModify(currentShip, _newShip)` directly
with the `currentShip` it already fetched once — eliminating both redundant external calls on the
actual state-changing path while leaving the convenient standalone preview functions intact.

**Bytecode tradeoff:** `DroneYard.sol` is at 7.171/24.576 KiB deployed — ample headroom (~17.4
KiB). Splitting each function into a thin public wrapper plus an internal core adds a small amount
of function-dispatch code, likely offset by removing two `ships.getShip` external-call sites'
worth of call-setup code from the hot path; net bytecode effect should be roughly a wash either
way, well within headroom regardless.

**Status: Fixed 2026-09-14.** Applied exactly the suggested split: `calculateCostToModify`/
`validateShip` are now thin public wrappers (`return _calculateCostToModify(ships.getShip(_shipId),
_newShip);` / `return _validateShip(ships.getShip(_shipId), _newShip);`) delegating to internal
`Ship`-accepting cores (`_calculateCostToModify`/`_validateShip`) that hold the rest of the
original logic unchanged. Both internal cores stay `view` (not `pure`, unlike the doc's
illustrative snippet) since `_calculateCostToModify` still calls `shipPurchaser.tierPrices(0)` and
`_validateShip` still calls `ships.maxVariant()` — genuine external reads, not eliminable.
`modifyShip` now calls `_validateShip(currentShip, _newShip)` and
`_calculateCostToModify(currentShip, _newShip)` directly with the `currentShip` it already fetched
at the top, eliminating both redundant `ships.getShip` calls on the state-changing path. The
standalone public `validateShip`/`calculateCostToModify` preview functions are untouched in
signature and behavior — still usable by a frontend exactly as before.

Bytecode measured: **7.190/24.576 KiB deployed (7.639 KiB initcode)**, up ~20 bytes from 7.171 —
a small net increase rather than the predicted wash, from the extra wrapper-function dispatch
code. Negligible against ~17.4 KiB headroom.

Verified genuine: existing `test/Ships.test.ts` has a full `"DroneYard"` describe block (12
tests) already exercising `modifyShip` end-to-end, so no new test was needed. Deliberately broke
the fix the way a plausible argument-mixup would look — swapped `modifyShip`'s calls to
`_validateShip(_newShip, _newShip)` / `_calculateCostToModify(_newShip, _newShip)` (passing the
new config as both arguments instead of `currentShip, _newShip`) — and confirmed it caught: the
"reject a variant change" test went red, because the variant-mismatch check
(`_newShip.traits.variant != currentShip.traits.variant`) became a self-comparison that's always
false. Restored the real fix from a backup and reconfirmed clean (bytecode back to 7.190/7.639).
Full suite re-run afterward: exit code 0, no regressions (`PRODUCTION` confirmed `false`
beforehand).

### ~~G-06 — `ShipAttributes.calculateShipAttributes`'s Three Helper Functions Each Re-Derive the Same Nested `variantData` Storage Reference Instead of Reusing the Caller's~~

**File:** `contracts/ShipAttributes.sol`, `calculateShipAttributes` (53-119, `variantData` derived
once at 74-76), `_calculateHullPoints` (169-179), `_calculateMovement` (181-213),
`_calculateDamageReduction` (215-232)

`calculateShipAttributes` already does this correctly for its *own* inline reads (`range`,
`gunDamage`): it derives `VariantAttributeData storage variantData = attributesVersions[
currentAttributesVersion].variantData[_ship.traits.variant];` **once**, up front, and reuses that
local. But it then calls three internal helpers — `_calculateHullPoints(_ship)`,
`_calculateMovement(_ship)`, `_calculateDamageReduction(_ship)` — and each one independently
re-derives the *exact same* nested-mapping reference from scratch:

```solidity
function _calculateHullPoints(Ship memory _ship) internal view returns (uint8) {
    VariantAttributeData storage variantData = attributesVersions[currentAttributesVersion]
        .variantData[_ship.traits.variant];   // same lookup, done 3 more times total
    ...
}
```

Each of these is a *nested* mapping access (`attributesVersions[version].variantData[variant]`) —
two `keccak256`-based slot derivations per re-derivation, not one — so this function makes 4 total
derivations of one value (1 useful + 3 pointless), 8 hash operations where 2 would do. Verified all
three helpers are `internal` and called from nowhere else in the codebase but these three sites, so
their signatures are safe to change. This isn't a rarely-hit corner: `calculateShipAttributes`
(via `calculateShipAttributesById`) runs once per ship at every game's `_initializeFleetAttributes`
(`Game.sol`, up to 88 ships for a full 44v44 match) and again for every roguelike resupply-node
repair — a real, frequently-hit multiplier on an otherwise-small per-call cost.

**Suggested fix:** pass the already-derived `variantData` storage reference into the three helpers
instead of re-deriving it inside each — Solidity allows passing `storage` pointers between
`internal` functions in the same contract, no restructuring needed beyond the signatures:

```solidity
function _calculateHullPoints(
    VariantAttributeData storage variantData,
    Ship memory _ship
) internal view returns (uint8) {
    uint8 baseHull = variantData.baseHull;
    uint8 traitBonus = variantData.hull[_ship.traits.hull];
    return baseHull + traitBonus;
}
```

and call sites become `_calculateHullPoints(variantData, _ship)` etc., reusing the one reference
`calculateShipAttributes` already holds.

**Bytecode tradeoff:** `ShipAttributes.sol` is at 12.904/24.576 KiB deployed — ample headroom
(~11.7 KiB). Adding one parameter to three internal function signatures is negligible; removing
three duplicated nested-mapping-derivation code blocks should net shrink bytecode slightly, not
grow it.

**Status: Fixed 2026-09-14.** Applied exactly the suggested fix: `_calculateHullPoints`,
`_calculateMovement`, `_calculateDamageReduction` all now take `VariantAttributeData storage
variantData` as their first parameter instead of re-deriving it internally (`_calculateMovement`'s
local was previously named `variant`, not `variantData` — renamed throughout its body for
consistency with the other two, purely cosmetic). `calculateShipAttributes`'s three call sites
now pass the `variantData` reference it already holds. Confirmed before touching anything that all
three helpers are `internal` with no other call sites in the codebase, so the signature change is
safe (re-verified the audit's own claim via a fresh grep, not just trusted it).

Bytecode measured: **12.774/24.576 KiB deployed (13.110 KiB initcode)**, down ~130 bytes from
12.904 — shrank as predicted, ample headroom (~11.8 KiB) untouched.

Verified genuine: existing tests already cover this directly (`test/Game.test.ts`'s hull-points/
movement/weapon-range/damage assertions, 11 tests total). Deliberately broke the fix the way a
plausible caching bug would look — pointed the `movement` call site at
`attributesVersions[currentAttributesVersion + 1].variantData[...]` (a real, one-line
copy-paste-off-by-one that's easy to imagine when passing a parameter instead of a fixed inline
expression) — and confirmed all 8 movement-related tests went red. Restored the real fix from a
backup and reconfirmed clean (bytecode back to 12.774/13.110). Full suite re-run afterward: exit
code 0, no regressions (`PRODUCTION` confirmed `false` beforehand).

---

### Moderate (Second Pass)

### ~~G-07 — `Game._incrementReactorCriticalTimerForZeroHPShips` Re-Derives `game.shipAttributes[shipId]`'s Storage Slot Three Times Per Zero-HP Ship, Every Round~~

**File:** `contracts/Game.sol`, `_incrementReactorCriticalTimerForZeroHPShips` (1245-1269), called
from the round-completion path (1516) — once per round, in every game, unconditionally

```solidity
if (
    !(ships.isShipDestroyed(shipId)) &&
    game.shipAttributes[shipId].hullPoints == 0                 // derivation #1
) {
    game.shipAttributes[shipId].reactorCriticalTimer++;         // derivation #2 (read-modify-write)
    if (game.shipAttributes[shipId].reactorCriticalTimer >= 3) { // derivation #3
        ...
    }
}
```

`game.shipAttributes` is a storage mapping; each `game.shipAttributes[shipId]` re-indexes it from
scratch, which for a mapping means recomputing a `keccak256`-based slot address, not just an
`SLOAD`. This function runs once per ship currently sitting at 0 HP (mid the 3-round
reactor-critical grace period), every single round of every game — a real, if modest, per-hit
cost, structurally identical to what this doc already treats as material for `Maps`' bitmap
caching (G-03): individually cheap, but paid repeatedly on a hot, unconditional path.

**Suggested fix:** hold the storage reference once, exactly the mechanical pattern the user asked
about this round:

```solidity
Attributes storage attrs = game.shipAttributes[shipId];
if (!(ships.isShipDestroyed(shipId)) && attrs.hullPoints == 0) {
    attrs.reactorCriticalTimer++;
    if (attrs.reactorCriticalTimer >= 3) {
        ...
    }
}
```

**Bytecode tradeoff:** `Game.sol` is at 24.000/24.576 KiB deployed — **zero headroom**, same
constraint as G-04. Unlike G-04, this fix *shrinks* code (three mapping-index expressions collapse
into one local-variable declaration plus three field accesses), so it's a plausible candidate to
help offset G-04's addition if both are implemented together — but this must be measured, not
assumed, given how tight this contract already is.

**Status: Fixed 2026-09-13.** Applied exactly the suggested fix: `Attributes storage attrs =
game.shipAttributes[shipId];` held once at the top of the loop body, with the three inline
`game.shipAttributes[shipId]` derivations replaced by `attrs.hullPoints`/`attrs.reactorCriticalTimer`
field accesses.

Bytecode measured via exact deployed-bytecode byte length (not just the rounded KiB the
contract-sizer table shows): **24,557 bytes deployed, 19 bytes of real headroom** under the 24,576
EIP-170 limit — up from the exact-zero headroom the HA2-01 fix (earlier this session) had landed
Game.sol at. Confirmed this 19-byte reduction is attributable entirely to this fix (nothing else
touched Game.sol's logic since HA2-01 — only a doc comment, which doesn't affect bytecode).

Verified genuine: since a correct cached-reference and the old three-derivation code are
behaviorally identical, reverting to the old code wouldn't turn a test red. Instead, deliberately
broke the new code the way a plausible caching bug would look — pointed `attrs` at
`game.shipAttributes[shipId + 1]` (the wrong ship) — and confirmed 3 of the 13 existing
reactor-critical-timer tests in `test/Game.test.ts` went red. Restored the real fix from a backup
and reconfirmed clean (byte count matches: 24,557/19 headroom again). Full suite re-run
afterward: exit code 0, no regressions (`PRODUCTION` confirmed `false` beforehand).

**G-04 status:** still open (as of the G-07 fix). 19 bytes of headroom is real but very thin —
nowhere near enough on its own for a new getter function (even a minimal one costs on the order of
100+ bytes for dispatch/return plumbing). G-04 will need either further size reduction elsewhere in
`Game.sol` first, or a fix shape that doesn't add a new public/external function (e.g. reusing
space some other way) — flagged here rather than assumed away. **Update: see G-08 below — this was
resolved 2026-09-15.**

### ~~G-08 — Dead Code and Duplicated Per-Side Loops in `Game.sol`, Found Specifically to Clear Headroom for G-04~~

**File:** `contracts/Game.sol` — `calculateFleetAttributes` (dead code, was ~line 377-385),
`_checkPlayerHasMovableShips`/`_checkPlayerHasUnmovedShips` (near-duplicate loops, were ~lines
999-1040), `_initializeFleetAttributes`/`_placeShipsOnGrid` (duplicated per-side loop pairs, were
~lines 232-297)

Not found during either of the two general sweeps above — found in a targeted follow-up pass
specifically hunting for `Game.sol` bytecode (not gas-cost) reductions once G-07 alone proved
insufficient to unblock G-04. Three independent candidates:

1. **`calculateFleetAttributes`** — a public function with **zero callers anywhere in the repo**
   (confirmed via a repo-wide grep across every `.sol`, `.ts` file: nothing references it, not
   even the test suite). A stale wrapper around `calculateShipAttributes` from an earlier design,
   never cleaned up.
2. **`_checkPlayerHasMovableShips`/`_checkPlayerHasUnmovedShips`** — two loops over
   `game.playerActiveShipIds[_player]`, identical except one has an extra `&&` condition
   (`!EnumerableSet.contains(game.shipMovedThisRound, shipId)`). Both called together (once per
   player) from `_switchTurnIfOtherPlayerHasShips`.
3. **`_initializeFleetAttributes`/`_placeShipsOnGrid`** — each has two copy-pasted per-side loops
   (creator, then joiner) doing identical work apart from which `EnumerableSet`/fleet id they
   read.

**Fix:** (1) deleted outright. (2) merged into one `_checkPlayerShips(_gameId, _player,
_requireUnmoved)`, with the extra condition gated behind the new bool — both original call sites
updated to pass `true`/`false` for what used to be two different function names. (3) each pair
extracted into one shared `private` helper (`_registerFleetShips`/`_placeFleetShipsOnGrid`) called
once per side — same behavior, one copy of the loop body instead of two.

**Bytecode tradeoff:** the entire point — measured together, these three changes took `Game.sol`
from 24,557 to 23,950 deployed bytes, **607 bytes saved**, comfortably clearing G-04's ~100+ byte
need with 626 bytes of headroom left over. All three are internal-only refactors or dead-code
removal with no external signature changes.

**Status: Fixed 2026-09-15.** No new tests needed for (1) (nothing called it) or (3) (both
original functions were already `internal`, external behavior unchanged). Verified genuine for (2)
and (3) via the usual revert-and-confirm-red cycle: flipped the merged condition's boolean logic
in (2) — 8 of `test/Game.test.ts`'s tests went red; swapped which fleet id `_registerFleetShips`
received per side in (3) — 22 tests went red. Restored the real fix from a backup both times,
confirmed byte-identical. Full suite re-run afterward: exit code 0, no regressions (`PRODUCTION`
confirmed `false` beforehand). `Game.sol` now sits at 23,950/24,576 bytes deployed.

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

**Second-pass additions:**

- **`RoguelikeResupply.resupplyModifyRoster`'s nested "is this roster ship being removed" scan**
  (`RoguelikeResupply.sol:173-185`) — `for` over `oldRoster` with an inner `for` over
  `_shipIdsToRemove`, both memory-only, both bounded by the same 44-ship fleet cap (worst case
  44×44 = 1,936 comparisons). Structurally identical to the `_findUnmovedShip` moved-list scan
  already reviewed above under the same reasoning — bounded, memory-only, below the bar this doc
  holds to.
- **`RoguelikeResupply.resupplyRepair`'s per-ship `getShipHP`-then-`setShipHP` pair**
  (`RoguelikeResupply.sol:131-144`) — two separate external calls into `RoguelikeRun` per repaired
  ship, each independently re-deriving `runs[_player].generation`. Looked at this as a possible
  G-05-style finding, but a get-then-set pair is inherent to the operation (can't merge a read and
  a write into one call without a larger ledger-API redesign), and each `generation` lookup is a
  single already-warm `SLOAD` after the first touch in the transaction — real but small, and the
  fix would be a bigger, less "small and readable" API change than this doc's bar calls for.
- **`ShipAttributes.calculateShipAttributesByIds`'s per-ship external `ships.getShip` call**
  (`ShipAttributes.sol:153-165`) — one `getShip` call per requested ship id, each id distinct.
  Not redundant (each call fetches genuinely different data), so not a finding on its own; only
  the *within-one-ship* repeated fetch pattern (G-05, in `DroneYard`) cleared the bar.
- **`GenerateNewShip.generateShip`'s per-trait `keccak256` rolls** (`GenerateNewShip.sol:27-167`)
  — roughly 15 independent `keccak256(abi.encodePacked(randomBase))` calls, one per rolled trait.
  Each roll needs its own entropy (reusing one hash across traits would correlate them), so this
  is inherent to the design, not redundant work — out of scope even setting aside that it's
  memory/pure-only, no storage involved.
