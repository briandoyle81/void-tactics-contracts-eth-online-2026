# Void Tactics — Open Security/Audit Items

_Created 2026-09-12. This is the live, actionable tracker — every item below is currently open
(not fixed, not accepted-as-a-non-issue). `docs/pre-audit.md` is the full historical audit record
(every finding ever made, including everything already fixed or resolved) and is kept exactly as
it stands as of this date — going forward, **new findings and status changes belong here, not
there.** Where useful, an item below links back to its original write-up in `docs/pre-audit.md`
(searchable by the finding code, e.g. `H-07`) for the full original investigation notes; this doc
gives the concise, current version._

**When an item here gets fixed:** mark it with strikethrough (`~~text~~`), same convention
`pre-audit.md` already uses — keep the original text intact, add a short "Fixed <date>" note.
Don't delete resolved items from this doc; move on to a `docs/audit-3.md` only if this one grows
unwieldy the same way `pre-audit.md` did.

---

## High

### H-07 — `Game.flee` Is Missing a `_requireGameExists` Check

**File:** `contracts/Game.sol`, lines 1358–1380 · **Full history:** `pre-audit.md`, search `H-07`

A dead, commented-out check means `flee` operates on a default-zeroed `GameData` reference for a
non-existent `_gameId`. A call with `address(0)` as the player would pass the owner-mismatch guard
(since `address(0) == address(0)`) and write garbage winner state into game slot 0. Live
exploitability is low (`msg.sender == address(0)` has no known private key), but the guard should
exist as defense-in-depth.

**Fix:** replace the dead check with a real call to the existing `_requireGameExists(_gameId)`
helper, already shared by 6 other call sites in this file.

**Why still open:** `Game.sol` was at 23.879 KiB against the 24 KiB limit as of the original
finding (~124 bytes headroom) — deferred until there's confirmed room to absorb it alongside other
pending fixes. **Re-check current headroom before landing this** — it may have shrunk or grown
since.

---

### H-08 — `Ships.purchaseWithFlow` Referral Transfer Occurs Before State Finality

**File:** `contracts/Ships.sol`, lines 163–165 · **Full history:** `pre-audit.md`, search `H-08`

`_processReferral`'s raw `.call{value: referralAmount}("")` can be made to revert by a malicious
contract named as `_referral`, which reverts the entire `purchaseWithFlow` transaction. Confirmed
this is pure griefing/DoS, not fund loss — a reverted transaction takes no `msg.value` and mints no
ships, so the buyer only loses gas on the failed attempt, then can retry without that referral.

**Self-referral half:** accepted as intended behavior, not a bug — no fix needed for that part.

**Fix (revert-on-receive half only), designed 2026-09-12, not yet implemented — no bytecode
headroom in `Ships.sol` right now:** decouple the referral payout from the mint via a pull-payment/
credit-balance model, so a hostile referrer can only forfeit their own payout, not block the
buyer's purchase. This is the same shape `ShipPurchaser.withdrawUC()`/`withdrawFlow()` and the
`DroneYard` H-04 fix already use elsewhere in this repo, not a new pattern.

```solidity
mapping(address => uint256) public referralBalance;
uint256 public totalReferralLiability;

function _processReferral(address _referrer, uint _shipsSold, uint _salePrice) internal {
    referralCount[_referrer] += _shipsSold;
    // ... same tier math as today ...
    uint referralAmount = (_salePrice * referralPercentage) / 100;
    referralBalance[_referrer] += referralAmount;       // credit, not send
    totalReferralLiability += referralAmount;
}

function withdrawReferralBalance() external nonReentrant {
    uint256 amount = referralBalance[msg.sender];
    referralBalance[msg.sender] = 0;                    // zero before the external call (CEI)
    totalReferralLiability -= amount;
    (bool success, ) = payable(msg.sender).call{value: amount}("");
    if (!success) revert ReferralTransferFailed();
}
```

**Risk this design must account for, found while working out the fix (2026-09-12):** the plain
version of this fix (mapping + withdrawal function only, no `totalReferralLiability`) would
introduce a real, adjacent problem — `Ships.sol` already has an owner-only `withdraw()`:
```solidity
function withdraw() external onlyOwner {
    (bool success, ) = payable(owner()).call{value: address(this).balance}("");
    if (!success) revert WithdrawalFailed();
}
```
Today this is safe because referral ETH is paid out immediately (same transaction as the
purchase), so it never sits in the contract long enough for `withdraw()` to reach it. Once
referral payouts become deferred balances sitting *inside* `address(this).balance` with nothing
distinguishing them from the owner's legitimate proceeds, `withdraw()` would sweep them right
along with everything else — draining the very balance `withdrawReferralBalance()` needs to pay
out, even though each referrer's mapping entry still (correctly) shows them as owed. Not
exploitable by an outside attacker (`withdraw()` is `onlyOwner`), but a real foot-gun for an
honest owner who doesn't think about it, and it hands the single owner key (already flagged as a
centralization risk in **I-02** above) a new way to strand real value even by accident, not just
by design.

**Confirmed fix for that adjacent risk:** track `totalReferralLiability` (shown above) and change
`withdraw()` to only sweep the surplus:
```solidity
function withdraw() external onlyOwner {
    uint256 available = address(this).balance - totalReferralLiability;
    (bool success, ) = payable(owner()).call{value: available}("");
    if (!success) revert WithdrawalFailed();
}
```
This makes `withdraw()` structurally incapable of touching money earmarked to referrers, whether
the owner is careless or actively hostile.

**Why not implemented yet:** `Ships.sol` is chronically near the 24 KiB contract-size limit (the
same constraint `H-07` above is deferred for) — this fix needs a new mapping, a new uint256, a new
external function, and a modified `withdraw()`, which is a nontrivial amount of bytecode for a
contract that's already tight. Revisit once there's confirmed headroom, or once a size-reduction
pass creates room — this repo's established pattern for a `Ships.sol` feature that won't fit in
place is to extract it into its own standalone contract wired through the existing
`isAllowedToCreateShips`-style authorized-caller allowlist, rather than trimming unrelated code to
make space (see e.g. how `FreeShipClaim.sol`/`TutorialClaim.sol` were split out).

---

### ~~HA2-01 — `Game._performShoot`/`calculateShipAttributes` Let Any Player Permanently Freeze a Live PvP Match~~

**File:** `contracts/Game.sol` — `calculateShipAttributes` (338-356), `_performShoot` (770-837),
`_removeShipFromGame` (1138-1200), `_incrementReactorCriticalTimerForZeroHPShips` (1223+)
**Status:** Fixed 2026-09-12 (see below). **Full write-up:** `pre-audit.md`, search `HA2-01` (also
**reopened and superseded `L-01`**, whose "won't fix, nothing ever reads a stray entry" resolution
was disproven — see that entry).

`calculateShipAttributes` is public and permissionless with no check that `_shipId` actually
belongs to `_gameId`; `_performShoot` never checks the target's per-game status (alive/fled/
destroyed) or fleet membership. An attacker can "revive" a fled/absent enemy ship's attributes for
free, shoot it to 0 HP, and once its reactor-critical timer would hit 3, the mandatory
`_removeShipFromGame` call reverts `ShipNotFound()` (it's in neither fleet) — which rolls back the
timer increment too, so **every future attempt to complete that round hits the identical revert,
forever.** The only escape is `PvPMatch.flee`, which forces the fleeing player to eat an unfair
loss.

**Originally proposed fix:** mirror the existing SP-02 fix already applied to `RamResolver`/
`EMPResolver`/`DroneSwarmResolver` — add a target-status check to `_performShoot`, and an
active-participant check to `calculateShipAttributes` itself (closes `L-01` fully too).

**Fixed 2026-09-12 — narrower than originally proposed, and confirmed necessary this way.**
Traced the exploit further before implementing: the "never placed in this game at all" variant
doesn't even need `calculateShipAttributes` — a never-touched `game.shipAttributes[X]` already
defaults to `hullPoints == 0`, which `_performShoot`'s existing 0-HP branch happily walks into the
same reactor-timer/`_removeShipFromGame` freeze regardless. So gating `calculateShipAttributes`
alone would **not** have closed this — the fix had to live in `_performShoot` itself. Added one
check there (`targetShipPos.shipId == 0 || targetShipPos.status != 0`, mirroring the exact SP-02
pattern), merged into the block's existing range/line-of-sight `if` to avoid three separate
`if/revert` blocks — purely a bytecode-size move, `Game.sol` had zero room for a fourth branch.
Also inlined a single-use local (`shooterPos`) for the same reason. Net result: `Game.sol` sits
at **exactly** 24,576/24,576 bytes (0 headroom) — any future change to this file will need to find
savings elsewhere first. `calculateShipAttributes`/`calculateFleetAttributes` were deliberately
**not** touched — with `_performShoot` now rejecting non-participant targets, a stray populated
entry is harmless again, restoring `L-01`'s original (now-accurate-again) reasoning. Regression
test: `test/Game.test.ts`, `"rejects shooting a ship that was never placed in this game (HA2-01)"`
— verified to actually fail without the fix (temporarily reverted, confirmed red, restored) before
being trusted. Full suite: 655/655 passing.

---

### ~~HA2-02 — `UTCLotteryHook._beforeInitialize` Has No Caller Check — Any Third Party Can Permanently Hijack the Pool Lock~~

**File:** `contracts/UTCLotteryHook.sol`, lines 194-211 · **Status:** Fixed 2026-09-12 (see below)
· **Full write-up:** `pre-audit.md`, search `HA2-02`

**Was the most time-sensitive item in this document.** `_beforeInitialize` discarded the real
caller (`sender`) entirely and only checked the currency pair. `PoolManager.initialize` is fully
permissionless on the real Uniswap v4 contract (independently confirmed against
`node_modules/@uniswap/v4-core`). `scripts/deployUTCLotteryPool.ts` deploys the hook and calls
`initialize` as **two separate transactions** — any third party who noticed the hook deployed in
that window could have called `initialize` first with the correct currency pair but a bogus
fee/price, permanently locking the hook to their empty pool, with no owner reset for `poolLocked`.

**Fixed 2026-09-12.** Added `if (sender != owner()) revert OwnableUnauthorizedAccount(sender);` as
the first check in `_beforeInitialize` — reuses `Ownable`'s own error rather than a new one, for
consistency with every other access-control revert on this contract. `sender` is the parameter
Uniswap's `Hooks.beforeInitialize` forwards (the real, original caller of `PoolManager.initialize`,
confirmed against `@uniswap/v4-core` source), not this contract's own `msg.sender` — that
distinction is why a plain `onlyOwner` modifier couldn't be used directly here. `UTCLotteryHook.sol`
has plenty of bytecode headroom (11.535 → 12.886 KiB deployed, nowhere near its own limit), so no
size pressure.

**`scripts/deployUTCLotteryPool.ts` updated to match:** step 11's `PoolManager.initialize` call now
sends from `shipMinterClient` (the same wallet already used for the `Ships.setIsAllowedToCreateShips`
grant) instead of the general deploy wallet, with an explicit check that it actually matches
`hookOwnerAddress` before use — they default to the same `MAP_EDITOR` address but aren't guaranteed
to, so the script verifies rather than assumes. If no matching wallet is available, the script now
prints the calldata for manual submission and halts (this step is a hard prerequisite for
everything after it, unlike the ship-minting grant, which is safely skippable) rather than
continuing in a broken state.

**Regression test:** `test/UTCLotteryHookSwap.test.ts`, `"rejects a non-owner calling
PoolManager.initialize on this hook's pool (HA2-02)"` — verified to actually fail without the fix
before being trusted. One wrinkle worth documenting: Uniswap wraps a reverting hook's error in its
own `WrappedError(...)` (`@uniswap/v4-core`'s `CustomRevert`/`Hooks.sol`), so a plain string match
against `"OwnableUnauthorizedAccount"` doesn't find it in the bubbled-up message — the test asserts
on the actual encoded error selector instead, confirmed present in the wrapped revert data. All 21
pre-existing tests in that file still passed unmodified — their `poolManager.write.initialize(...)`
calls already happened to be signed by the fixture's default account, which coincidentally is the
hook's owner (no `PRODUCTION`-style ownership handover runs in tests). Full suite: 656/656 passing.

---

### ~~HA2-03 — `Ships.setInFleet` Doesn't Check `timestampDestroyed`, Letting a Destroyed Ship Re-Enter a Fleet as an Unkillable Ghost~~

**File:** `contracts/Ships.sol`, `setInFleet` (410-424) · **Status:** Fixed 2026-09-12 (see below) ·
**Full write-up:** `pre-audit.md`, search `HA2-03`

A ship destroyed in a past game (NFT never burned, still owned by the player) could be freely
resubmitted into a fresh fleet — `setInFleet` never checked `timestampDestroyed`, and neither did
`Fleets.createFleet`/`Game.startGame` (re-confirmed directly against current source before fixing —
`createFleet`'s five checks are ownership, `inFleet`, cost version, variant match, and cost limit;
none of them touch `timestampDestroyed`). It fought normally with full HP in the new game until
anyone tried to finish or retreat it, at which point `_removeShipFromGame` reverted
`ShipDestroyed()` — permanently, since the flag is never cleared. Froze that specific ship's
resolution in the new match; confirmed this does *not* enable reward double-farming.

**Fixed 2026-09-12.** Added `if (_inFleet && ships[_id].shipData.timestampDestroyed != 0) revert
ShipDestroyed();` to `setInFleet`, guarded to only block the "add to fleet" direction — removing a
destroyed ship from a fleet (e.g. game cleanup) still works. Reused the existing `ShipDestroyed`
error (already used for the same concept elsewhere in this contract) rather than adding a new one.
`Ships.sol` only had 73 bytes of headroom before this fix (same chronic tightness as `Game.sol`) —
this fix fit with 14 bytes to spare, no bytecode-saving restructuring needed this time.

**Regression test:** `test/Ships.test.ts`, `"rejects adding a destroyed ship to a fleet (HA2-03)"`
— verified to actually fail without the fix (temporarily reverted, confirmed red, restored) before
being trusted; also confirms the "remove" direction still works post-destruction. Full suite:
657/657 passing.

**Not bundled into this pass, still open:** the related, lower-severity bug found alongside this
one — `Ships._update` never resets `ship.owner` to `address(0)` on burn (`getShip(id).owner` for a
burned ship still shows the pre-burn owner). Not independently exploitable today, but a footgun for
any future code trusting `ship.owner` over `ownerOf()`. Severity: Low/Informational — left as a
separate, still-open item rather than assumed-fixed alongside HA2-03.

---

### ~~HA2-04 — `RoguelikeMatch.enterResupplyNode` Doesn't Check for an In-Flight Combat Game~~

**File:** `contracts/RoguelikeMatch.sol`, `enterResupplyNode` (246-257); also
`RoguelikeResupply.sol`'s `resupplyRepair`/`resupplyModifyRoster` · **Status:** Fixed 2026-09-12
(see below) · **Full write-up:** `pre-audit.md`, search `HA2-04`

Unlike `retreatRun(0)` (hardened under SP-05 with an `ActiveGameInProgress` check),
`enterResupplyNode` never checked `run.activeGameId`. A player could enter a resupply node while a
combat game was still open, then win that game — `onGameEnded`'s stale-callback guard only checks
*which game*, not *which node*, so the wrong node got `defeated`/win-effects credit. Verified
against the actual seeded campaign content (`ignition/data/roguelikeStarterContent.json`): the two
most severe variants (instant full-campaign win; reopening the already-fixed SP-05 farming exploit)
weren't reachable with *that* specific content shape, but the wrong-node-credited bug fired
unconditionally, and both aggravated variants would have become live the moment a `twoWay` edge or
a leaf Resupply node was added — both content shapes this codebase's own design already treats as
normal.

**Fixed 2026-09-12.** Added `if (run.activeGameId != 0) revert ActiveGameInProgress();` to
`enterResupplyNode`, mirroring `retreatRun(0)`'s existing guard exactly (same error, same
reasoning). Also added the equivalent check to `RoguelikeResupply._requireAtResupplyNode` (the
shared chokepoint both `resupplyRepair` and `resupplyModifyRoster` call), plus a new
`ActiveGameInProgress` error declaration there (the two contracts don't share error definitions).

**Correction made while implementing, worth recording:** the original finding described the
`RoguelikeResupply` gap as an equally live, independent exploit path. Tracing it more carefully
while fixing: `run.currentNodeId` can only ever change via `RoguelikeMatch._commitToNode`, called
from exactly two places — `enterCombatNode` (which always moves `currentNodeId` to the *combat*
node in the same call that sets `activeGameId`) and `enterResupplyNode`. With `enterResupplyNode`
now blocked while `activeGameId != 0`, there is no longer any reachable state where
`currentNodeId` points at a Resupply node *and* `activeGameId != 0` simultaneously — so
`RoguelikeResupply`'s check, while correct and cheap to keep, is genuinely unreachable
defense-in-depth given the primary fix, not a second independently-exploitable hole. Kept it
anyway (matches this repo's own defense-in-depth philosophy, and costs nothing), but didn't write
a test for it — there's no way to reach that state through the public API to test against, so a
test would only be exercising the check via direct internal-state manipulation, not a real
scenario.

Both files had ample bytecode headroom (2.4 KB / 16.4 KB respectively) — no size pressure.

**Regression test:** `test/RoguelikeMatch.test.ts`, `"reverts enterResupplyNode while a combat
match is still active at the current node"` — verified to actually fail without the fix
(temporarily reverted, confirmed red, restored) before being trusted; also asserts
`run.currentNodeId` is unchanged (still the combat node) after the reverted attempt. Full suite:
658/658 passing.

---

## Medium

### M-04 — `ShipAttributes` Attribute Version Arrays Can Be Out-of-Bounds Indexed

**File:** `contracts/ShipAttributes.sol`, lines 120-155; `contracts/GenerateNewShip.sol`, lines
88-109 · **Full history:** `pre-audit.md`, search `M-04`

`calculateShipAttributes` indexes `attributesVersions[version].guns[...]` etc. without a length
check. If a version is deployed with only 4 gun entries (today's default) and a ship has an
equipment enum value 4-7 (the `future*` placeholders), the call panics with an out-of-bounds
access. Accepted as-is (2026-07-16) — no fix planned, but genuinely not fixed, so tracked here
rather than silently dropped.

---

### ~~HA2-05 — `Lobbies`: `reservedJoiner` Is Never Cleared Outside `acceptGame`/`rejectGame`~~

**File:** `contracts/Lobbies.sol` — `joinLobby`, `leaveLobby` (all 3 branches), `timeoutJoiner`,
`quitWithPenalty` · **Status:** Fixed 2026-09-12 (see below) · **Full write-up:** `pre-audit.md`,
search `HA2-05`

A reserved player could join via plain `joinLobby` (not just `acceptGame`) without the reservation
ever clearing. If they then left/timed out, the lobby reopened but stayed permanently locked to
them — nobody else could join, at zero further cost to them. **Worse:** if the *creator* left
after the reserved player joined, that player got promoted to creator while still being
`reservedJoiner` — since `joinLobby` also blocks `creator == msg.sender`, the lobby became
permanently unjoinable by anyone.

**Fixed 2026-09-12.** Added `lobby.players.reservedJoiner = address(0);` (harmless no-op when
already unset) to every path identified: `joinLobby` (right after the reservation is consumed,
mirroring `acceptGame`'s existing clear), and all three ways a lobby resets back to genuinely
public "open" — `leaveLobby`'s creator-leaves-with-joiner-promoted branch, its
creator-leaves-abandoned branch, its joiner-leaves branch, `timeoutJoiner`, and
`quitWithPenalty`. Six new clear sites total, alongside the two pre-existing ones in
`acceptGame`/`rejectGame`. `Lobbies.sol` had ample headroom (14.8/24 KiB) — no size pressure.

**Regression tests:** `test/Lobbies.test.ts`'s `"Game Reservation"` block — two new tests, both
confirmed to actually fail without the fix (temporarily disabled all six new clear sites at once,
confirmed both went red, restored) before being trusted: one reproduces the base scenario (reserved
player joins then leaves, then a third party can join), one reproduces the worse variant (creator
leaves, reserved player is promoted to creator, then a third party can still join — proving the
lobby isn't permanently bricked). Notably, this feature had **zero** prior test coverage for the
plain-`joinLobby`-then-leave path at all (every existing reservation test used `acceptGame`, which
was already correct) — confirmed by grep before writing these. Full suite: 660/660 passing.

---

### ~~HA2-06 — `UTCLotteryHook` Entry Weight Is Gameable via a Flash-Loan Round-Trip~~

**File:** `contracts/UTCLotteryHook.sol` — `_recordSell`, `resolveDraw` · **Status:** Addressed
2026-09-12 (see below) · **Full write-up:** `pre-audit.md`, search `HA2-06`

Weight = a single sell's realized ETH proceeds, no retention requirement. An attacker could
flash-borrow UTC, sell it (registering a large weight to any address via `hookData`), then buy it
back to repay the loan — paying only round-trip slippage/fee rather than the real economic cost of
holding that capital.

**Design discussion, not a pure security fix.** No funds were ever at risk here (both legs are real
swaps against the real pool, paying real fees) — the actual question was fairness of the periodic
prize drawing, weighed directly against the project's stated priority that on-chain activity/volume
is a good thing in itself. Conclusion reached: a flash-loan round-trip is bounded-cost, fee-generating
activity; the real risk was a single well-funded (flash-loaned or genuine) address dominating a
draw's odds when few others participate, not the flash-loan technique specifically.

**Fixed 2026-09-12, two additions:**
1. **`maxWeightPerEntryWei`** (default `1 ether`) caps the *weight* a single sell can credit,
   independent of real (uncapped) proceeds — added to `_recordSell`. The qualifying-threshold check
   still uses real, uncapped proceeds; only the recorded weight is clamped.
2. **`maxWinProbabilityDenominator`** (default `10`) floors `resolveDraw`'s random-pick denominator
   at `maxWinProbabilityDenominator * maxWeightPerEntryWei`. Combined with the cap above, this
   guarantees no single address can ever exceed a `1/maxWinProbabilityDenominator` share of a draw
   — not just a bounded *absolute* weight, which alone would still let a whale claim close to 100%
   of a thinly-participated draw. A random pick landing beyond the real participants' cumulative
   weight now means **nobody wins that draw** (`DrawResolvedNoWinner(drawId)`, new event) — no
   special rollover logic needed, the next qualifying sell just starts accumulating toward the next
   draw as usual.

Both are owner-configurable, same pattern as the existing thresholds, and both defaults are
explicitly flagged (matching every other threshold on this contract) as sensible-but-unvalidated
starting points, not final tuned values.

**Regression tests**, `test/UTCLotteryHookSwap.test.ts`:
- Deterministic: defaults, owner-only setters, and a direct test that a sell far exceeding the cap
  is clamped to exactly `maxWeightPerEntryWei` in `weightInDraw`/`totalWeightInDraw`.
- Probabilistic: a test that deliberately floors the denominator far above real weight and asserts
  `DrawResolvedNoWinner` fires (cross-checked against ship-count non-mint) within two independent
  attempts — each attempt individually ~99.8%+ likely to land in the no-winner zone (bounded by
  RandomManager's `uint64` randomness range, not by how extreme the parameters get), so the chance
  *both* attempts land on a real winner is ~4e-6. A small, disclosed, standard residual flake
  probability for a genuinely random on-chain outcome — run 4 times during development with no
  failures.
- Both the cap and the no-winner mechanism confirmed to actually fail without their respective
  code (temporarily reverted, confirmed red, restored) before being trusted.
- Fixing this also required updating three pre-existing tests whose fixed sell amounts predated the
  cap (`runFullDrawCycle`'s shared helper, and the `minTotalWeightWei` gating test) to explicitly
  neutralize or account for the new cap, since they test unrelated mechanics (prize-minting,
  volume-gating) and shouldn't flake on the new probability-cap behavior.

Full suite: 664/664 passing.

---

### ~~HA2-07 — `Tournament.buildBracket()`'s Shuffle Inherits `RandomManager`'s Known "Patient Caller" Risk, Now Exposed to Real Prize Money~~

**File:** `contracts/Tournament.sol`, `buildBracket`/`_shuffleSeeds` (340-354, 588-606) · **Full
write-up:** `pre-audit.md`, search `HA2-07`

Not a new bug — a re-evaluation of an already-accepted `RandomManager` risk (a patient caller can
simulate `block.prevrandao`-derived outcomes off-chain for the current epoch and choose whether to
submit) in a context the original acceptance never considered: Tournament prize pools (entry fees
× N + uncapped sponsor contributions), versus the original reasoning's "99.9% of ships worth under
$1." **Action:** project owner should explicitly re-confirm whether the existing acceptance still
holds now that real prize money is gated by it — not a code change by default.

**Status: Fixed 2026-09-12 (bounded, not eliminated — see below).** Traced the exact exploit
window before fixing: `start()` freezes `t.registrants` and commits `RandomManager`'s
`prevRandaoAtCommit` in the same transaction, so the entire shuffle input is public before any
waiting begins. `TournamentState.Starting` had no timeout and no path back to
`Registration`/`Cancelled`, so a patient outside observer — not necessarily a registrant — could
poll the public `block.prevrandao` every ~12s (one Base RANDAO epoch), simulate `_shuffleSeeds`
off-chain for free, and simply decline to call `buildBracket()` until a favorable epoch appeared,
with no time limit forcing their hand.

Added a bounded reveal window instead of an unbounded one: `SHUFFLE_REVEAL_WINDOW = 10 minutes`
(new constant). `start()` now also sets `t.shuffleDeadline = block.timestamp +
SHUFFLE_REVEAL_WINDOW`. `buildBracket()` reverts `ShuffleWindowExpired()` once that deadline
passes instead of still honoring a stale request. A new permissionless function,
`rerollBracketShuffle(tournamentId)`, becomes callable by anyone (same "no single party staying
offline should block progress" reasoning as `buildBracket`/`assignMatchGame`/`recordResult`) once
the deadline has passed — it requests a fresh `RandomManager` id, overwrites
`t.randomRequestId`, and resets the deadline, orphaning whatever epochs were being ground through
against the old request (`buildBracket` calls `fulfillRandomRequest` on `t.randomRequestId`, which
now points at the new, un-preview-able request). Reroll itself reverts `ShuffleWindowNotExpired()`
before the deadline, so it can't be spammed to grief progress or used to dodge an about-to-land
honest `buildBracket()` call.

**This bounds the exploit, it does not eliminate the underlying preview-and-decline ability** —
that requires either a real multi-party committed-secret scheme or an external VRF (see the
"option 3" discussion below, not yet decided). What it does change: an attacker's free look-ahead
against any single request is capped at ~50 epochs (10 minutes) instead of unlimited, and past
that window any bystander with zero stake in the outcome (the tournament creator wanting their
event to start, an impatient registrant, a keeper) can force a reroll that discards the attacker's
accumulated preview data. Since `buildBracket()` has always been safe to call the instant the
window opens (no reason for an honest party to wait), the realistic exposure is now bounded by how
long it takes *some* honest actor to notice and call `buildBracket()` or `rerollBracketShuffle` —
not by how long an attacker is willing to wait.

`Tournament.sol` has ample bytecode headroom (17.839 → 17.839 KiB deployed size-report baseline,
18.332 KiB deployed after this fix, vs. the 24.576 KiB limit), so no restructuring was needed.

New tests in `test/Tournament.test.ts` (`"Bracket shuffle expiry (HA2-07)"` describe block):
- `"rejects buildBracket once the reveal window has expired"` — starts a tournament, lets
  `SHUFFLE_REVEAL_WINDOW` lapse with `evm_increaseTime`, asserts `buildBracket` reverts
  `ShuffleWindowExpired`.
- `"lets anyone reroll an expired shuffle request and build normally afterward"` — asserts
  `rerollBracketShuffle` reverts `ShuffleWindowNotExpired` before expiry, succeeds when called by
  a non-creator (alice) after expiry, and confirms `buildBracket` then succeeds immediately
  against the fresh request.

Both new tests were verified to fail (red) when the fix's two `if` checks were neutralized via
`if (false && ...)`, then the real fix was restored from a backup and reconfirmed clean. Full
suite re-run afterward: exit code 0, no regressions (`PRODUCTION` confirmed `false` beforehand).

**Deferred follow-up (not yet decided): a genuine cryptographic fix, not just a bound.** Discussed
three options for actually removing the preview-and-decline ability (rather than just bounding
how long any one request can be ground against):

1. **External VRF (e.g. Chainlink VRF).** Removes caller-timing power entirely — randomness
   arrives via an oracle callback, not by whoever chooses to poll a public value. The only option
   that eliminates the attack rather than bounding it; adds a real external dependency this
   project doesn't otherwise have.
2. **The reroll/expiry bound above.** Cheap, already shipped. Does not remove the preview
   ability, only caps how many free look-aheads a single request offers before it's invalidated.
3. **Real multi-party commit-reveal, Tournament-specific.** Each registrant submits
   `keccak256(secret)` at registration; after `start()`, a short reveal window requires each
   registrant to submit their `secret`; the shuffle entropy becomes
   `keccak256(prevrandao, requestId, XOR-of-all-revealed-secrets)` (or similar) instead of
   `prevrandao` alone. No single outside observer — including the last revealer — can preview the
   full result before all secrets are in, since no one but each registrant knows their own secret
   pre-reveal. Residual: classic **last-revealer bias** (whoever reveals last can choose to
   reveal-or-withhold based on what the combined result would be) — mitigated by a hard reveal
   deadline with a fixed, unappealing consequence for non-reveal (e.g. forfeiting seed placement
   entirely, seeded last, or excluded from the bracket), so a withholding registrant only ever
   gets to choose between "reveal" and a bad default, not between two outcomes they'd prefer.
   Real added complexity: a new registration-time input, a new per-tournament reveal step/
   deadline, and non-reveal handling — and it's Tournament-specific, since `RandomManager`'s other
   consumers (ship construction) don't want this friction for low-stakes randomness.

**User decision (2026-09-12): defer option 3 for later.** The bounded fix above ships now;
building the real per-tournament secret-reveal scheme is explicitly parked, not rejected — revisit
if/when tournament prize pools are large enough, or frequent enough, to justify the added
registration/reveal UX cost. No further design work has been done beyond the sketch above.

---

## Low

### L-03 — `Ships.syncShipCosts` Is Fully Permissionless and Can Corrupt Storage for ID 0

**File:** `contracts/Ships.sol`, lines 354-358 · **Full history:** `pre-audit.md`, search `L-03`

Calling on ship ID 0 silently writes `.costsVersion`/`.cost` into the always-empty `ships[0]` slot.
Traced fully: every on-chain existence check (`ship.id == 0`, `ship.owner != _owner`,
`ownerOf(0)`) still correctly identifies "doesn't exist" and reverts before anything could act on
the corrupted fields — inert on-chain. The one real residual risk is off-chain: a naive indexer/
bot that reads `getShip(0)` without checking `.id == 0` first could display/act on meaningless
data, and looping `syncShipCosts` from index 0 instead of 1 triggers this by accident, no attacker
needed. Accepted as-is — not worth an on-chain guard for a purely off-chain-consumer hygiene
concern.

---

## Informational / Centralization

### I-01 — Multiple Debug Functions Left in Production `Game` Contract

**File:** `contracts/Game.sol`, lines 1204-1252 · **Full history:** `pre-audit.md`, search `I-01`

`debugDestroyShip`, `debugSetHullPointsToZero`, `debugSetShipPosition` — all `external onlyOwner`.
Blast radius is limited by `onlyOwner`, but their presence in production is a centralization signal
and may confuse auditors/players about contract finality. Same three functions as I-02's
"debug-named" category below.

---

### I-02 — Severe Centralization: Owner Can Alter Any Live Game, Cost, or Attribute

**File:** `contracts/Game.sol`, `ShipAttributes.sol`, `Maps.sol`, `Ships.sol`, `Lobbies.sol` ·
**Full history:** `pre-audit.md`, search `I-02`

The deployer key can: modify any ship's position/HP/destroy it in any live game; change all ship
attributes/costs globally; pause minting/lobby creation; grant/revoke minting rights; apply any
preset map to any game. No timelock, multisig, or governance gates any of it. Split into
debug-named (I-01's three functions) vs. ordinary-admin-config categories — same underlying gap
either way: a single compromised or malicious deployer key acts immediately and unilaterally.

---

### I-08 — `Ships._update` Modifies Internal State Before `super._update` Call

**File:** `contracts/Ships.sol`, lines 395-439 · **Full history:** `pre-audit.md`, search `I-08`

`shipsOwned` storage is updated before the `super._update` ERC-721 call. Currently safe with
OpenZeppelin's actual implementation, but fragile — if a future base-class change let
`super._update` revert after partially executing, internal and ERC-721 state could desync.

---

### ~~HA2-08 — `RepairResolver`/`RepairDronesResolver` Missing the SP-02 Target-Status Check~~

**File:** `contracts/RepairResolver.sol` (51-83), `contracts/RepairDronesResolver.sol` (51-86) ·
**Status:** Fixed 2026-09-12 (see below). **Full write-up:** `pre-audit.md`, search `HA2-08`

Unlike their three sibling resolvers (patched under SP-02), these two never check
`target.status`. Currently inert — healing a stale target computes a heal cap from `maxHullPoints`,
which is `0` for a deleted ghost, so the write never actually changes anything. **But `HA2-01`
demonstrates `maxHullPoints == 0` isn't a reliable assumption** (it can be revived via
`calculateShipAttributes`), so this should be closed as defense-in-depth alongside `HA2-01`'s fix,
not left relying on that assumption.

**Fixed 2026-09-12.** Added `if (target.status != 0) revert TargetNotFound();` to both resolvers,
placed right after the existing `shipId == 0` check and before the friendliness check — same
position/pattern as `RamResolver`/`EMPResolver`/`DroneSwarmResolver`'s SP-02 fix. Neither resolver
is on `Game.sol`'s own bytecode budget (each is its own separately-deployed contract), so no size
pressure here. Regression tests added to `test/EffectResolverTargetStatus.test.ts` (the file
already built for exactly this purpose under SP-02) — a "rejects fled/destroyed friendly target"
case and an "accepts live friendly target" control for each resolver, reusing `MockGameView`
rather than a full game. Full suite: 655/655 passing.

---

## Process / Deploy Readiness (not a code vulnerability)

### Admin/Backend Key Separation for Production Deploy

**Full write-up:** `pre-audit.md`, search "Admin/Backend Key Separation"

`ignition/modules/DeployAndConfig.ts`'s `PRODUCTION` branch currently reuses two hardcoded
addresses across several unrelated trust roles: `MAP_EDITOR` (owner of every `Ownable` contract in
the module — map editing, node-graph editing, content publishing, general ownership, all one key)
and `FIREBASE_FLOW_MINTER` (both the ship-minting backend *and* the Selfie-Check verification relay
— two independent trust roles on one key). Known, deliberate dev-time placeholders, not final. Plan
(per explicit direction): separate and replace all admin/backend keys with distinct,
purpose-specific keys before a real production deploy — at minimum a cold owner key (Ledger
hardware signer candidate) separate from any hot backend-relay key, and each hot backend role
either on its own key or deliberately consolidated with an explicit, written acknowledgment of the
combined blast radius. **Not yet done.**
