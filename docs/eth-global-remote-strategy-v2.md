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
pools.

**Build:**

- A Subgraph indexing UTC (`UniversalCredits.sol`), DEC (`DroneEnergyCores.sol`), Ships
  (`Ships.sol`), and `ShatteredHiveMedal.sol` transfer/mint/burn activity using a **Messari
  Standardized Subgraph schema** for ERC-20/ERC-721, rather than ad-hoc custom entities.
- Custom entities layered on top, in the same subgraph, for data with no standard schema to map
  to: `GameResults` (wins/losses), `Tournament` (registrations, brackets, match results), and
  `FreeShipClaim`/`TutorialClaim` claim events.
- **Prerequisite:** `FreeShipClaim.sol` currently emits no events at all — add one before it can
  be indexed. Cheap (standalone contract, no size pressure).
- Consume live data via a Subgraph Studio API key — mocked/local data does not qualify.
- If Pick 3 ends up being Uniswap, the subgraph also indexes that pool's native `Swap` events
  (emitted by v4's `PoolManager` singleton regardless of any hook) — no extra contract work needed
  for that.

**Dashboard** (frontend deliverable, lives in the separate frontend repo, not this one — depends
on the subgraph being deployed first): one panel per real use case —

1. **Player history** — per-wallet win/loss, tournament, and claim history. Replaces the
   frontend's current raw-event-log scanning.
2. **Abuse detection** — flags same-block-funded wallet clusters and repeat-claim attempts against
   `FreeShipClaim`/`TutorialClaim`. Ops-facing, not player-facing; doubles as before/after evidence
   for the Selfie Check gating in Pick 2.
3. **Economy transparency** — UTC/DEC supply, mint/burn rate, top holders, via the standardized
   ERC-20 entities. Public-facing.
4. **Ship/medal provenance** — per-token ownership/transfer history via the standardized ERC-721
   entities.

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
hackathon target.

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
