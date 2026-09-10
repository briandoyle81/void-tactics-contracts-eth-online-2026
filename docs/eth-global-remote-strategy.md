# ETH Global Remote — Continuity Track Prize Strategy

_Written 2026-09-08. Describes `docs/eth-global-remote.md` (the ETHGlobal Remote sponsor prize
sheet) as it read on that date — re-check line numbers/amounts if this doc is read much later,
sponsors sometimes edit prize sheets mid-event._

## Context

Void Tactics is entering ETH Global Remote as a **Continuity** team — the game already shipped
(pre-hackathon repo, plus a prior ETH NY 2026 hackathon round that added World ID Tournament
gating, Walrus match records, and Dynamic wallet auth). `docs/eth-global-remote.md` lists this
event's sponsor prize tracks; the goal is to pick 3 sponsors and build real, Continuity-eligible
extensions — not cosmetic integrations bolted on to qualify.

A first pass at this analysis was too shallow: it proposed a "verify AI ship ownership with
World AgentKit" pitch without checking whether the game's "AI ownership" concept was actually a
real agent identity. Three research passes were sent to verify every load-bearing claim against
the actual contracts before recommending anything again. Two claims from the first pass turned
out to be wrong or weak, and one new, much stronger opportunity surfaced that wasn't in the
first pass at all:

- **Wrong:** "AI-owned ships" is not an autonomous agent concept. `SinglePlayerMatch._mintAIFleet`
  just mints ships to the match contract's own address; `AIShips`/`AIBehavior`/`RoguelikeAIController`
  are deterministic, hardcoded priority-list PvE enemies with id ≥ `2**40`. There is no wallet,
  no off-chain decision-maker, no delegate/operator concept anywhere in the repo. A "verify this
  AI agent" pitch built on this would have been dishonest framing of a PvE labeling convention.
- **Weak:** ENS's natural pairing point (`DroneNames.sol`) turned out to be a pure deterministic
  string generator, not a stored registry — there's nothing to "swap for ENS," so any ENS
  integration would be closer to a cosmetic add-on than the ENSv2 track wants ("central to the
  product, not a cosmetic add-on"). Dropped from the top picks.
- **New and strong:** `FreeShipClaim.sol` (10 free ships / 28-day cooldown, address-keyed only)
  and `TutorialClaim.sol` (one-time ship grant + a `GameResults.addWin`/`addLoss` write, also
  address-keyed only) have **zero human-uniqueness protection** — unlike `Tournament.sol`, which
  already gates entry behind Orb-level World ID (`ByteHasher` + nullifier tracking). Any script
  can mint unlimited fresh wallets and drain free ships or inflate win/loss stats forever. This
  is a real, currently-exploitable gap in a shipped product, not a hackathon strawman.
- **Confirmed real:** `docs/pre-audit.md` and `RandomManager.sol`'s own comments already name
  **Chainlink VRF** as "the only way to remove [a documented residual randomness risk]
  entirely." `IRandomManager` was kept deliberately stable so a provider swap needs no changes
  to `Ships.sol`/`Tournament.sol` beyond their existing owner-gated config setters.
- **Needs your confirmation — flagged, not asserted:** `ShipPurchaser.purchaseUTCWithFlow()` is
  a `payable` direct mint-sale — whatever native currency the deployed chain uses as
  `msg.value` (ETH on the live Base Sepolia deployment; "Flow" in the function name does not
  mean the Flow blockchain is actually in play) buys newly-minted UTC at a fixed admin-set
  price per tier. This is one-directional and already solves "buy UTC with native currency" —
  it needs no DEX. Separately, `docs/UTC_Price_Prediction_10k_Players.md` models an "external
  market price" for UTC and arbitrage against that fixed mint rate, which only means something
  if UTC actually trades somewhere with a price that can diverge from the mint rate — no such
  secondary market exists today. The Uniswap idea below was: deploy a real UTC/ETH pool so that
  external market actually exists, not to replace `purchaseUTCWithFlow`. **Note (2026-09-08):
  `docs/UTC_Price_Prediction_10k_Players.md` explicitly models a "0.95 - 1.0 FLOW per UTC"
  target price, i.e. it assumes Flow blockchain was the actual deploy target — but the live
  deployment is Base Sepolia (ETH-denominated). That doc needs to be re-examined against the
  current deploy target before anything here leans on its numbers.** Unconfirmed whether a
  real secondary market was ever an actual goal here vs. a modeling assumption in that doc —
  if it's the latter, this pitch loses its grounding and should be dropped.
- **Confirmed real, low-risk:** the deploy/ops tooling (`scripts/allowFirebaseMinter.ts`, the
  `METAMASK_WALLET_1` hot key pattern in `.env`) is exactly the kind of leaked-secret risk
  Ledger's Key Ring track targets, and fixing it touches ops scripts, not contract bytecode — no
  pressure on the 24 KiB contract-size limit at all.

Every dollar figure, prize-pool split, and Continuity-eligibility tag below was checked
line-by-line against `docs/eth-global-remote.md`. One inaccuracy from an earlier draft of this
analysis was caught in that pass — see the Chainlink section's correction note.

## Tracks deprioritized after review

Kept out of the final picks; noted here for completeness, each checked against
`docs/eth-global-remote.md`:

- **Hedera** ($15,000 total pool) — its only pool-restricted prize, "♻️ Continuity — $1,000"
  (lines 306-322), explicitly requires the project to have "already exist[ed] in some form on
  Hedera" — Void Tactics has never touched Hedera, so we're not eligible for that specific prize
  regardless of our overall Continuity status. Its other three prizes (AI & Agentic Payments
  $6,000, Open Source Harness $2,000, Tokenization of Anything $6,000, lines 147-305) carry no
  pool restriction and we could technically submit, but none have a natural seam with the
  existing FLOW/Base-denominated game.
- **Arc/Circle** ($10,000 total) — has two Continuity-tagged prizes: "Best DeFi or Agentic
  Application — $1,666" (lines 399-435) and "Launch on Arc Testnet & Push to Mainnet — $1,500"
  (lines 466-491, requires deploy-or-deploy-ready on **Arc mainnet by September 30**). Both are
  eligible in principle, but the game's economy is FLOW/UTC-denominated with no USDC/stablecoin
  surface today, and a mainnet-deploy requirement needs deliberate sign-off per this repo's
  deploy-safety rules — large lift, weak narrative fit.
- **Privy** ($5,000 total) — neither prize (lines 860-901) carries a Continuity tag, but more
  importantly Void Tactics already ships Dynamic for wallet/auth; adding Privy would duplicate
  that shipped integration rather than extend it.
- **1inch** — "Build an Aqua App - Continuity Track — $2,000, 1st $1,500 / 2nd $500" (lines
  627-654) is Continuity-eligible, but there's no existing swap/AMM code in the repo to build on
  (confirmed via grep — zero hits for swap/DEX/AMM/router-as-DEX), a bigger novel lift than the
  Uniswap v4 hook option for a comparable prize size.
- **Bazantic** — "Help an Agent Use Your Hackathon Project — $1,000, up to 2 teams at $500"
  (lines 1049-1069) is Continuity-eligible, but it requires wrapping an internal queryable API
  in an x402/MCP gateway — Void Tactics has no backend API of its own to wrap (the "backend" is
  just a minter-authorization script), so this would mean building net-new API surface just to
  have something to agentify.
- **ENS** — "Best Integration of ENSv2 into an Existing Project — $500" (lines 708-718) is
  Continuity-eligible and cheap, but the natural pairing point we hoped for (`DroneNames.sol`)
  turned out to be a pure deterministic string generator with no stored registry to swap out —
  any ENS integration would land closer to the "cosmetic add-on" the track explicitly warns
  against than to something "central to the product."

## Locked-in picks (2 of 3 sponsors)

### 1. The Graph — "Best AI Tooling or AI Use Case with The Graph (Continuity)" — $5,000 pool

1st $2,500 / 2nd $1,500 / 3rd $1,000; explicitly tagged "🆕 This prize is only available to
Continuity Track participants" at line 87, and the track body itself says "THIS TRACK IS THE
CONTINUITY TRACK" at line 108 — distinct from the "From Scratch" pool at lines 45-85.

No indexer exists anywhere in this repo (or, as far as the contracts repo shows, the separate
frontend repo) — `GameResults`, `Tournament`, `Fleets`, and claim events are only readable by
walking raw chain events. Build:

- A Subgraph indexing `GameResults` (wins/losses), `Tournament` (registrations, brackets, match
  results — `contracts/Tournament.sol`), and `FreeShipClaim`/`TutorialClaim` claim events.
- A Subgraph MCP server (or direct Subgraph Studio queries) exposing natural-language queries
  over this data — e.g. "show me every wallet that claimed free ships from a cluster of
  same-block-funded fresh addresses," which doubles as a real abuse-detection tool for the World
  track below. This is what makes the three picks form one coherent story instead of three
  disconnected integrations.
- Consume live data via an API key from Subgraph Studio (mocked/local data does not qualify per
  the track's own rules).
- Submit under the explicit "THIS TRACK IS THE CONTINUITY TRACK" pool (lines 86-127), not the
  "From Scratch" one at lines 45-85 — document what's pre-existing (the whole game) vs. new (the
  subgraph/MCP work) per the track's requirements.

**Re-examined 2026-09-09 — could this subgraph replace Walrus for match replay?** No, not
cheaply, as the contracts stand. `Game.sol`'s only combat event —
`Move(gameId, shipId, oldRow, oldCol, newRow, newCol, actionType, targetShipId)`
(`contracts/Game.sol:88`) — covers ship movement + coarse action-type + target, which is enough
for a real (if partial) "tactical trace" subgraph feature with **zero contract changes**. But
damage dealt, resulting hull points, ship-destroyed-vs-fled status, which specific
weapon/special/faction-ability actually resolved, and round number/running score are never
emitted anywhere — `_performShoot`, `_removeShipFromGame` (`Game.sol`), `ShipsRouter.sol`,
`SpecialEffectsLib.sol`, and `DestroyRewardLib.sol` are all event-less for this data; it exists
only in storage or inside the Walrus `MatchRecord.turns` blob. Reaching full replay parity with
that blob would mean adding several new, richer events to `Game.sol` — real per-action gas cost,
and real risk given `Game.sol` is already within a few hundred bytes of the 24 KiB limit.
**Recommendation: don't pitch this as a Walrus replacement.** The free "tactical trace" version
(zero contract changes) is a legitimate *complementary* subgraph feature, not a substitute for
full replay.

**Flagged — needs confirmation, not asserted:** the live product may have already stopped
writing to Walrus after the ETH NY 2026 hackathon it was built for — unconfirmed from this
contracts repo (`GameBlobRegistry` is still deployed and wired in `DeployAndConfig.ts`, but the
write path is entirely client-driven from the separate frontend repo, which isn't visible here).
If Walrus is genuinely inactive in production today, "add a few richer combat events + a
subgraph" stops being a redundant rebuild of a working feature and becomes restoring lost replay
capability from scratch — which changes whether the `Game.sol` size/gas cost above is worth
paying. Check the live frontend/backend's actual Walrus-write status before deciding either way.

- **Correction:** the FreeShipClaim/TutorialClaim abuse-detection subgraph idea above only half
  works as written. `TutorialClaim.sol` emits `TutorialCompleted(player, winPath, shipsCreated)`,
  but `FreeShipClaim.sol` emits **no events at all**, so its claims aren't indexable yet. Adding
  one event there is cheap (it's already a standalone contract, no size pressure) if this angle
  is still wanted.

**Follow-up, 2026-09-09 — Walrus confirmed permanently disabled; scoped a full-replay plan.**
The "flagged, needs confirmation" item directly above is resolved: Walrus is confirmed off and
not coming back, so there is currently **no replay capability at all** in the live product. That
changes the calculus from the note above — this is no longer "rebuild a redundant feature," it's
"restore lost capability from scratch." The goal, per direction: full step-by-step client replay
— round number, running score, ship variant, exactly which special/faction ability fired
(including its faction/slot identity), damage dealt, and destruction — reconstructable purely
from on-chain events.

Researched the exact data model and call graph needed (`Types.sol` enums/structs,
`Game.sol`'s `_performShoot`/`_performSpecial`/`_performFactionAbility`/`_removeShipFromGame`/
`_handleEndOfRound`/`startGame`, `SpecialEffectsLib.sol`) and confirmed the binding constraint:
`Game.sol` is deployed at **23.993 KiB** against the 24 KiB (24,576-byte) EIP-170 limit —
effectively zero headroom, confirmed via `npx hardhat compile --force` +
`hardhat-contract-sizer`. Per `CLAUDE.md`, the size check is never disabled — this has to
actually fit via refactoring, not a workaround.

*Architecture (the escape valve):* `SpecialEffectsLib.sol`'s functions are `external` and take
`GameData storage` — Solidity compiles calls to it as a DELEGATECALL stub at `Game.sol`'s call
sites (confirmed by the file's own header comment) instead of inlining the logic, so code living
inside it — including new events, ABI encoding, and `LOG` opcodes — is charged against *that
library's own* budget (5.272 KiB deployed, lots of room), not `Game.sol`'s, while the emitted
event still shows on-chain as coming from `Game.sol`'s address (delegatecall preserves
`ADDRESS()`). Plan: one new library, `contracts/GameReplayLib.sol`, built the same way, plus a
small extension to `SpecialEffectsLib.sol` itself for ability identity:

1. **Round number** — add a `round` param to the *existing* `Move` event/emit site
   (`Game.sol:88`, `:706`) rather than a new event; cheapest possible way to get it in.
2. **Damage** — extract `_performShoot`'s damage formula (`Game.sol:824-836`) into
   `GameReplayLib.resolveShotAndLog(...)`, emitting `Damage(gameId, shooterId, targetId, amount,
   resultingHullPoints, round)`. Replaces inline arithmetic with a call, so likely
   size-neutral-to-negative for `Game.sol` — do this one first and measure.
3. **Ship removal** — `_removeShipFromGame` has 5 call sites, each already unambiguous about why
   (`Retreat`, `ShotDestroyed`, `SpecialEffect`, `ReactorCritical`, `Debug`); thread a
   `RemovalReason` enum through and call `GameReplayLib.logRemoval(gameId, shipId, reason,
   round)`.
4. **Round end** — one call in `_handleEndOfRound` after the score-increment block:
   `GameReplayLib.logRoundEnd(gameId, round, creatorScore, joinerScore)`.
5. **Ship loadout snapshot** — equipment (`mainWeapon`/`armor`/`shields`/`special`) is fully
   mutable between matches via `DroneYard.modifyShip` (only `variant` is guarded), and nothing
   per-game stores which loadout was active during a specific historical match — so one call at
   `startGame` time, `GameReplayLib.logRoster(gameId, creatorShipIds, joinerShipIds, ships)`,
   emitting one `ShipLoadout` event per ship.
6. **Which ability fired** — `SpecialEffectsLib.resolveAndApply` already knows `variant` but not
   the `Special` slot; add that field to its existing `ResolveContext` struct (cheap — the value
   is already loaded in memory at both call sites) and emit `AbilityUsed(gameId, shipId, variant,
   special, targetShipId)` from inside the library, which already has room.

No new allowlist/auth is needed: a hostile direct (non-delegatecall) call to the library's own
address would execute with `address(this)` == the library, not `Game.sol` — any forged event
would be tagged as coming from the wrong address and a subgraph watching `Game.sol` specifically
would never see it.

*Alternative considered and rejected: Diamond proxy pattern (EIP-2535).* Would remove the 24 KiB
ceiling on `Game.sol` permanently (not just for this feature) by making it a thin proxy over
per-facet contracts. Rejected for this task: it's a full storage-layout rewrite of the entire
game loop (not just 5-6 hook points), adds a permanent `fallback()` selector-lookup + delegatecall
gas cost to *every* player action forever, carries real regression risk to a live game with 616
passing tests, introduces a new audit surface (facet clashes, `diamondCut` permissions), and
doesn't match this repo's already-established answer to "a core contract needs more room" —
splitting logic into standalone authorized contracts (`FreeShipClaim.sol`, `TutorialClaim.sol`,
`DroneYard.sol`, `ShipPurchaser.sol`, `SpecialEffectsLib.sol`), which is what the plan above
already does. If the team wants to solve the *recurring* "core contracts keep hitting 24 KiB"
problem structurally, Diamond is worth its own dedicated evaluation later, decoupled from this
feature.

*Build order:* extract shoot-damage first and measure `Game.sol`'s size before proceeding to the
smaller additive stubs (round-on-Move, round-end, removal-reason, `ResolveContext` extension),
with the roster/loadout snapshot last (least urgent, easiest to defer if room runs out). Existing
tests asserting the old `Move`/`_removeShipFromGame` signatures will need updating; new tests
needed per new event. This is contracts-only — the subgraph that actually consumes these events
for client replay is separate follow-on work under the Graph pick above.

### 2. World — Selfie Check — $3,500 pool, up to 3 teams at $1,166 each

**Eligibility check:** unlike AgentKit ("🆕 This prize is only available to Continuity Track
participants", line 517), Selfie Check carries no pool-restriction tag at all (lines 540-561) —
it's open to both Start-Fresh and Continuity submissions. Being a Continuity team does not
exclude us from it; it just means we won't get a smaller, protected competing field the way we
would on AgentKit or the other explicitly-tagged tracks below.

Gate `FreeShipClaim.claimFreeShips` and `TutorialClaim.completeTutorialWinPath` /
`completeTutorialLossPath` behind a Selfie Check proof, as a lower-friction complement to
Tournament's existing full-Orb World ID gate — matches the track's own framing almost verbatim
("risk, eligibility, fairness, continuity, or abuse prevention").

- Reuse the pattern `Tournament.sol` already established for World ID: `ByteHasher` for signal
  hashing, a nullifier mapping to prevent proof reuse, proof validation on-chain (not in a
  backend) — see `contracts/Tournament.sol` lines 1-80 and `contracts/IWorldID.sol`.
- `FreeShipClaim.sol` currently only tracks `lastClaimTimestamp[msg.sender]`
  (`contracts/FreeShipClaim.sol:18`) — add a per-nullifier claim record alongside the existing
  per-address cooldown so a proof can't be reused across wallets, without removing the existing
  cooldown logic.
- `TutorialClaim.sol` currently only tracks `tutorialCompleted[player]`
  (`contracts/TutorialClaim.sol:13`) — same nullifier-alongside-address pattern.
- Both are already split-out standalone contracts (per the "Ships.sol size fix pattern" this
  repo already follows, since `Ships.sol`/`Game.sol` are near the 24 KiB limit), so adding World
  ID verification here doesn't pressure the core contracts at all.
- Deliverable also requires a feedback document (World ID docs, Developer Portal, Sandbox App
  experience) per the track's qualification requirements — write this alongside the code, not
  after.

## Third slot — needs further scoping before committing

Kept open per direction: keep Ledger and Uniswap both live for exploration, with Chainlink VRF
as the low-risk fallback. All three are real, grounded, Continuity-eligible, and technically
compatible with each other (they touch different contracts), so more than one could plausibly be
built even if only one is ultimately submitted as the "official" third sponsor.

**A. Chainlink VRF — "Best Chainlink-Powered Upgrade" (Continuity) — $500**

- Lowest effort, lowest risk, lowest prize. New `ChainlinkRandomManager` implementing the
  existing `IRandomManager` interface (`contracts/IRandomManager.sol`); repoint via
  `Ships.setConfig` and `Tournament`'s constructor/config (both owner-gated, no proxy needed). No
  changes to any consuming contract's logic.
- Directly cites a real, documented finding: `docs/pre-audit.md`'s randomness remediation entry
  names Chainlink VRF as the real fix for the residual timing-choice risk in the current
  commit-reveal (`block.prevrandao`) scheme.
- **Correction from an earlier draft of this analysis:** VRF does *not* need to be routed
  through CRE. The track lists five independently-eligible technologies — "Chainlink Runtime
  Environment (CRE) - including Confidential Workflows, Price Feeds, Data Streams, Proof of
  Reserve (PoR), VRF (Verifiable Random Function)" (lines 974-980). The doc's "Important: Please
  use CRE instead of Chainlink Functions or Automation" note (line 984) is a warning about two
  specific *deprecated* products (Functions, Automation), not a requirement that every
  integration go through CRE. Plain VRF (subscription model) is directly eligible on its own —
  scope against that, not a CRE wrapper, unless CRE genuinely simplifies the integration.

**B. Ledger — "Continuity" track — $1,500 (1st $1,000 / 2nd $500)**

- Almost entirely an ops/tooling change: move the hot key used by
  `scripts/allowFirebaseMinter.ts` (and other owner-gated admin actions — RandomManager repoint,
  mint-authorization changes) onto Ledger's Key Ring CLI (`wallet-cli ring`), or add a
  device-confirmation step in front of one of those actions.
- Matches the track's own example almost exactly: "Make wallet-cli ring the key backend for the
  .env... files your repo already has" / "Put a device confirmation in front of an action your
  product already performs."
- Needs scoping: which specific admin action(s) get the device-confirmation treatment, and
  whether the Key Ring CLI needs a CI/VPS enrollment step (no USB port) given deploys likely run
  from a laptop or CI runner rather than a device with the Ledger physically attached.

**C. Uniswap — "Best Uniswap Stack Contribution" (Continuity) — $2,000 (1st $1,000 / 2nd $1,000)**

- Biggest lift of the three. Deploy a real UTC/ETH (or UTC/USDC) Uniswap v4 pool with a custom
  hook enforcing the burn/arbitrage mechanic `docs/UTC_Price_Prediction_10k_Players.md` already
  assumes exists (a small fee-on-swap routed into the existing UTC burn/treasury flow, closing
  the loop between the 1:1 `purchaseUTCWithFlow` mint rate and the assumed external market
  price).
- Needs scoping: exact hook logic (fee capture + where it's routed — does it feed the existing
  `owner()` treasury withdrawal path in `ShipPurchaser.sol`, or a new burn sink?), and whether a
  v4 pool needs its own liquidity seeding plan for a believable demo.
- Requires a `FEEDBACK.md` + Uniswap Developer Feedback Form submission per the track's
  qualification requirements.

## Implementation notes (for whenever this moves from strategy to build)

- Contract-side work (World/Selfie Check nullifier gating, Chainlink VRF `RandomManager` swap,
  any Uniswap hook) is testable the normal way: `npx hardhat test`, after confirming `PRODUCTION`
  is `false` in `ignition/modules/DeployAndConfig.ts` per `CLAUDE.md`. New contracts get their
  own test file following the existing per-contract pattern in `test/`.
- Contract size must be re-checked after any addition to `Ships.sol`/`Tournament.sol` (both are
  near the 24 KiB limit) — prefer the existing pattern of splitting new logic into standalone
  contracts wired through an authorized-minter/allowlist, as `FreeShipClaim.sol` and
  `TutorialClaim.sol` already do, rather than growing the core contracts in place.
- The Graph subgraph is verified by querying it against live Base Sepolia data through Subgraph
  Studio once deployed — mocked/local data does not satisfy the track's own qualification
  requirement.
- Any real deploy (new World ID gate, new RandomManager, a live Uniswap pool) targets Base
  Sepolia only, per `CLAUDE.md`'s deployment-safety rules — no mainnet or other testnet deploy
  without the user explicitly directing that specific deploy.
