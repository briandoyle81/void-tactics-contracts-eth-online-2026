# ETH Global Remote — Live Plan (v2)

_Written 2026-09-10. This is the current, actionable plan only — not the reasoning that produced
it. That reasoning (rejected designs, eligibility investigations, pitches) lives in
`docs/eth-global-remote-strategy.md`, kept as historical record; this document supersedes it for
day-to-day reference. Re-check this plan's assumptions against the live prize sheet
(`docs/eth-global-remote.md`) if read much later — sponsors sometimes edit prize sheets mid-event._

## Overview

Void Tactics is entering ETH Global Remote as a **Continuity** team. Three sponsor picks:

1. **The Graph** — locked in.
2. **World (Selfie Check)** — locked in.
3. **Third slot** — **Uniswap** is the primary choice; **Ledger** is the fallback / 4th priority.

All contract-side work follows this repo's standing rules: `npx hardhat test` after confirming
`PRODUCTION` is `false` in `ignition/modules/DeployAndConfig.ts`; any real deploy targets **Base
Sepolia only**, never mainnet or another testnet, and never without explicit direction for that
specific deploy; contract size is re-checked after any change to `Ships.sol`/`Tournament.sol`
(both near the 24 KiB limit) — new logic goes in standalone contracts wired through the existing
authorized-minter/allowlist pattern, not grown in place.

---

## Pick 1 — The Graph: "Best Use of Composable or Standardized Graph Products"

$5,000 pool (1st $2,500 / 2nd $1,500 / 3rd $1,000). Not Continuity-restricted — open to both
pools. "Live data" just means not mocked/local/static per the track's own text — testnet data via
Subgraph Studio genuinely qualifies.

**Hard dependency on Pick 3 (accepted, not hedged):** the track requires either composing 2+
Graph products or building meaningfully on a standardized schema (`docs/eth-global-remote.md`
lines 25-27) — plain "query one Subgraph with no standardization" explicitly does not qualify,
and the fallback the track names for that case is the AI track, which is deliberately not being
pursued. This plan uses exactly one Graph product (a Subgraph) and gets its only standardization
story from the Messari DEX-AMM schema applied to the Uniswap pool in Pick 3 — every other data
source below is plain custom entities with no standards story of its own. **If Pick 3 (Uniswap)
doesn't ship, Pick 1 loses its eligibility path for this track entirely** — there is no budgeted
fallback (e.g. a real Substreams composition) if that happens. Treat Pick 3 shipping, with a
genuinely complete DEX-AMM implementation (the real protocol-wide aggregation entities, not just a
`Swap` listener), as a hard prerequisite for Pick 1, not a nice-to-have.

**Tooling, confirmed current:** `@graphprotocol/graph-cli@0.98.1`,
`@graphprotocol/graph-ts@0.38.2`, manifest `specVersion: 1.3.0`, mapping `apiVersion: 0.0.9`,
network string `base-sepolia` (chain id 84532 — confirmed indexable via Subgraph Studio). Studio's
free tier (100,000 queries/month) covers a demo dashboard with no billing setup needed.

**Contracts to index, with real event surfaces (verified by reading the source, not assumed) and
real deployment block numbers (from `ignition/deployments/chain-84532/journal.jsonl`, use as each
data source's `startBlock`):**

- **`UniversalCredits.sol`** (UTC) — block 46381910. Plain ERC-20, standard `Transfer` only, no
  custom mint/burn events, no `_update` override. Custom entities, straightforward.
- **`DroneEnergyCores.sol`** (DEC) — block 46381267. Same as UTC — plain ERC-20, no surprises.
- **`Ships.sol`** — block 46381843. **Not plain ERC-721 — implements ERC-5192 (lockable).**
  `_update` emits `Locked`/`Unlocked` alongside `Transfer`, and transfers **revert unless both
  sender and receiver have `amountPurchased >= 10`** (a real, previously-undocumented gate). The
  schema must model lock state and this transfer restriction — a naive "index Transfer" design
  would misrepresent actual ship movement, since most addresses can't receive/send ships at all
  until they've bought 10.
- **`ShatteredHiveMedal.sol`** — block 46381965. **Unconditionally soulbound** — `_update` reverts
  on any post-mint transfer. There is no provenance to show, ever, beyond the single mint event.
- **`GameResults.sol`** — block 46381268. Real events: `GameResultRecorded(gameId, winner, loser,
  timestamp)`, `PlayerStatsUpdated(player, wins, losses, totalGames)`.
- **`Tournament.sol`** — block 46382113. **16 events**, richer than originally scoped:
  `TournamentCreated`, `SponsorAdded`, `Registered` (carries `nullifierHash` — direct input for
  the abuse-detection panel), `TournamentClosing`/`TournamentStarted` (the two-step randomness
  reveal), `MatchGameAssigned`, `MatchResolved` (carries a `walrusBlobId` field — a dead reference
  to the now-permanently-disabled Walrus system; index it but don't present it as working replay
  data), `NextRoundMatchCreated`, `TournamentFinalized`, `PrizeClaimed`, `TournamentCancelled`,
  `Refunded`, `MatchForfeited`, `MatchStalled`, `WinEffectsSet`, `WinEffectFailed`.
- **`FreeShipClaim.sol`** — block 46381854. Emits `FreeShipsClaimed(player, amount)` **in source
  only** — confirmed not yet in the live Base Sepolia deployment or the frontend's compiled ABI.
  Cannot be indexed until a real redeploy happens (blocked on explicit deploy authorization, not
  an open task).
- **`TutorialClaim.sol`** — block 46381909. Already emits `TutorialCompleted(player, winPath,
  shipsCreated)` — indexable as-is.

**Standardized schema, scoped correctly:** Messari's schemas are organized by DeFi protocol
category (DEX/AMM, lending, yield, NFT marketplace) — not a generic token schema, and a poor,
forced fit for plain game tokens. Use Messari's **DEX-AMM schema**
(`schema-dex-amm.graphql`, MIT-licensed, confirmed to exist in `messari/subgraphs`) **only for the
Uniswap v4 pool from Pick 3.** Note it's protocol-shaped, not single-swap-shaped — using it
"meaningfully" per the track's own language means populating its protocol-wide aggregation
entities (`DexAmmProtocol`, daily usage/financial snapshots), not just listening for `Swap`
events; budget real effort here, not a drop-in listener. UTC/DEC/Ships/Medal/GameResults/
Tournament/claims are all plain custom entities alongside it — that's fine, the track's
qualification is "compose 2+ products OR build on a standardized schema," not "everything must be
standardized."

**Dashboard** (frontend deliverable, lives in the separate frontend repo, not this one — depends
on the subgraph being deployed first): one panel per real use case —

1. **Player history** — per-wallet win/loss, tournament, and claim history. Replaces the
   frontend's current raw-event-log scanning.
2. **Abuse detection** — flags same-block-funded wallet clusters and repeat-claim attempts against
   `FreeShipClaim`/`TutorialClaim`, using `Tournament.Registered`'s `nullifierHash` as a
   cross-reference signal. Ops-facing, not player-facing; doubles as before/after evidence for the
   Selfie Check gating in Pick 2.
3. **Economy transparency** — UTC/DEC supply, mint/burn rate, top holders. Public-facing.
4. **Ship lock/ownership panel** (replaces "ship/medal provenance" — dropped, see above). Ships:
   lock state and real transfer history subject to the `amountPurchased >= 10` gate. Medal:
   one-time mint ownership record only, not a transfer history — it can never have one.

Deliverable: public repo, README pointing at the relevant contracts/lines, demo showing the
dashboard against live Base Sepolia data.

---

## Pick 2 — World: Selfie Check

$3,500 pool, up to 3 teams at $1,166 each. Not Continuity-restricted.

**Build:** gate `FreeShipClaim.claimFreeShips` and `TutorialClaim.completeTutorialWinPath`/
`completeTutorialLossPath` behind a Selfie Check proof, reusing the World ID pattern
`Tournament.sol` already established (`ByteHasher` signal hashing, a nullifier mapping, on-chain
proof validation — not a backend check).

- `FreeShipClaim.sol` currently tracks only `lastClaimTimestamp[msg.sender]` — add a
  per-nullifier claim record alongside it (don't remove the existing per-address cooldown), so a
  proof can't be reused across wallets.
- `TutorialClaim.sol` currently tracks only `tutorialCompleted[player]` — same
  nullifier-alongside-address addition.
- Both are already standalone contracts (per this repo's size-fix pattern), so this doesn't
  pressure `Ships.sol`/`Game.sol`'s size budget at all.
- Deliverable also requires a feedback document (World ID docs, Developer Portal, Sandbox App
  experience) — write it alongside the code, not after.

---

## Pick 3 — Third slot

Chainlink VRF is **explicitly declined** by the project owner — not under consideration.
**Primary choice: Uniswap. Fallback / 4th priority: Ledger.**

### Primary — Uniswap: "Best Uniswap Stack Contribution" (Continuity), $2,000 (1st $1,000 / 2nd $1,000)

Confirmed as real, independent product value (a genuine UTC secondary market), not just a
hackathon target. **Also now a hard prerequisite for Pick 1's eligibility** — see Pick 1 above:
Pick 1's only standardized-schema story is the Messari DEX-AMM schema applied to this pool, with
no budgeted fallback if this pick doesn't ship.

**Build:**

1. Deploy a UTC/ETH Uniswap v4 pool.
2. Seed initial liquidity from the UC/ETH already sitting in `ShipPurchaser` (withdrawable via the
   existing `withdrawUC()`/`withdrawFlow()`) — an allocation decision between committing to an LP
   position and keeping funds spendable for giveaways/prizes, not a new revenue mechanism.
3. **Price ceiling:** relies entirely on the existing passive arbitrage — anyone can mint UTC at
   `ShipPurchaser`'s fixed tier price and sell into the pool for profit whenever pool price rises
   above it. Zero new code. Deliberately not pinned tight; occasional excursions above the mint
   rate are accepted by design.
4. **Sell-side lottery hook** for a unique-ship prize, attached to the pool:
   - Only UTC→native (`sell`) trades earn entries — reinforces the ceiling arbitrage above (that
     arbitrage trade *is* a sell) rather than competing with it, and adds no floor.
   - One weighted entry per address per draw period; weight = that address's summed qualifying
     sell volume over the period.
   - Minimum qualifying trade size **denominated in ETH, not UTC** — insulates entry cost from
     UTC's own price swings. Exact ETH figure: **not yet set** — should be informed by
     `docs/UTC_Price_Prediction_10k_Players.md` once that doc is re-examined against the live
     ETH-denominated Base Sepolia deployment (it currently models FLOW-denominated figures).
   - One drawing per 24 hours maximum, permissionlessly triggered — the hook checks elapsed time
     on `afterSwap` and fires once due, the same permissionless-trigger pattern
     `Tournament.buildBracket` already uses.
   - Draw resolution reuses the existing `RandomManager` (request-now/reveal-later, the same
     two-step pattern `Ships.constructShip`/`Tournament.buildBracket` already use) — no Chainlink
     VRF dependency.
   - Prize minting reuses the existing `isAllowedToCreateShips` authorized-minter allowlist
     pattern; guarded so the mint can only fire once per draw's prize.
5. `FEEDBACK.md` + Uniswap Developer Feedback Form submission, per the track's qualification
   requirements.

**Open questions to resolve before/during build:**

1. What "1-of-a-kind" means across repeated draws — likely each draw period mints its own newly
   generated unique variant (a rotating one-of-a-kind per drawing), not one eternal ship fought
   over forever. Needs explicit confirmation before the mint path is defined.
2. Weighted random selection needs a real on-chain data structure (e.g. a cumulative-weight array
   with binary search) to fairly and cheaply pick a winner from an unknown number of addresses —
   genuine implementation work, not boilerplate.
3. Whether to cap max weight per entry. Whale dominance is an inherent property of size-weighting,
   not automatically a bug — decide deliberately rather than defaulting either way.
4. The exact ETH-denominated minimum entry threshold (see above).

### Fallback / 4th priority — Ledger: "Continuity" track, $1,500 (1st $1,000 / 2nd $500)

Only pursue if Uniswap falls through.

**Confirmed inventory** (checked against the repo, not assumed): `METAMASK_WALLET_1` (a plaintext
key from `.env`) is the sole signer for five networks in `hardhat.config.ts` — `base-sepolia`,
`flow-testnet`, `ronin-saigon`, `polygon-amoy`, `xai-testnet`. It signs exactly two kinds of real
transaction: (1) every Ignition deploy against those networks, and (2)
`scripts/allowFirebaseMinter.ts`'s `setIsAllowedToCreateShips` call — the only post-deploy
owner-gated write script that exists today. `scripts/healthcheck.ts` also uses a wallet client but
only for a read-only `simulateContract` — out of scope, nothing to gate there.

**Build:**

1. Move `METAMASK_WALLET_1`'s role to Ledger's Key Ring CLI (`wallet-cli ring`) as the signer
   backend for `hardhat.config.ts`'s network `accounts` — covers both real uses (deploys and
   `allowFirebaseMinter.ts`) in one change.
2. **Open question:** does Key Ring CLI support enrollment from a headless CI/VPS deploy path, or
   does it require a physical device attached to whatever machine runs deploys/scripts? Resolve
   before committing to an approach.
3. Demo: a real Base Sepolia transaction (an `allowFirebaseMinter.ts` grant/revoke run, or a
   redeploy) signed via the Key Ring CLI instead of the plaintext key — video, five minutes or
   less.

**Important clarification for anyone building this:** the hardware-confirmation gate sits on the
*owner's* rare grant/revoke admin action only. It never touches the Firebase backend's own
automated per-ship minting, which signs with its own separate key
(`DEFAULT_MINTER = 0x7f9dc2D68FF842EC79DA722B68E3ca7e5aa31CCb` in the script) and must stay fully
automated.

**Eligibility — check before building:** Ledger's sponsor blurb frames the whole $5,000 pool as
"Build AI agents and AI-powered products that use Ledger as the trust layer," but the Continuity
sub-prize's own example directions (hardware signer for a shipped app, Key Ring as `.env` backend,
device confirmation on an existing action) don't mention AI at all — leans toward "eligible,"
but confirm with the track's own organizers/Discord
(`https://developers.ledger.com/ethonline`) before investing build time.

---

## Deploy/build safety reminders

- Test suite: `npx hardhat test`, after confirming `PRODUCTION = false` in
  `ignition/modules/DeployAndConfig.ts`.
- Any real deploy (new World ID gate, Ledger signer swap, live Uniswap pool) targets **Base
  Sepolia only** — no mainnet or other testnet without explicit direction for that specific
  deploy.
- New contracts get their own test file, following this repo's existing per-contract pattern.
- The Graph subgraph is verified against live Base Sepolia data through Subgraph Studio once
  deployed — mocked/local data does not satisfy that track's qualification requirement.
