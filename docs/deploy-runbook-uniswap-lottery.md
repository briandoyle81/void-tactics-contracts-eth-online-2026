# Deploy Runbook — Main Redeploy, Then the Uniswap Lottery Pool

_Written 2026-09-12. Describes contract state as of this date. Re-verify against
`ignition/deployments/chain-84532/deployed_addresses.json` and the actual contract
source if this is read much later — both may have moved on._

> **Audience:** whoever (human or agent) is actually running the real Base Sepolia
> deploy from this repo. Not the FE/BE repo — see
> `docs/uniswap-lottery-selfie-check-frontend-integration.md` for that handoff.

This is a two-phase sequence: **Phase 1** redeploys the whole game (picks up every
contract change from this session — Selfie Check eligibility gating, the new
`FreeShipsClaimed` event, everything). **Phase 2** — only after Phase 1 is live —
deploys `UTCLotteryHook.sol` and its real Uniswap v4 pool against the fresh
addresses Phase 1 produces. Do not run Phase 2 against a stale/old deployment.

---

## Deploy-safety reminders (apply to both phases)

- **Base Sepolia only.** Never target mainnet or another testnet without
  explicit direction for that specific deploy.
- **`PRODUCTION` must be `false` before running `npx hardhat test`** — confirm
  with `grep -n "^const PRODUCTION" ignition/modules/DeployAndConfig.ts`.
  Flipping it to `true` is *only* for the real deploy transaction itself; flip
  it back to `false` and re-run the test suite immediately after, before
  leaving it committed.
- Read `CLAUDE.md`'s "Deployment Safety" and "Git Write Commands Require
  Explicit Permission" sections before doing anything here for real — this
  runbook assumes you've already read them.

---

## Phase 1 — Main game redeploy

### 1.1 Preconditions

- [ ] `.env` has `METAMASK_WALLET_1` (the deploy signer) funded with enough
      Base Sepolia ETH for the full deploy (dozens of contracts + many config
      calls — budget generously).
- [ ] `.env` has `SHIP_MINTER_PRIVATE_KEY` set — a wallet that will hold
      `Ships`' owner rights after this deploy's ownership-handover step, used
      later in Phase 2 for the one owner-gated grant it needs. (If this is
      meant to be the same key as `MAP_EDITOR`, confirm that now — the
      ownership handover transfers `Ships` to the hardcoded `MAP_EDITOR`
      constant in `ignition/modules/DeployAndConfig.ts`, not to whichever
      wallet deployed.)
- [ ] `npx hardhat test` passes (650/650 as of this writing) with `PRODUCTION
      = false`.

### 1.2 Run the deploy

```bash
# 1. Flip PRODUCTION to true in ignition/modules/DeployAndConfig.ts (line ~24).
#    Do NOT commit this as true.

# 2. Deploy for real. Use scripts/ignition-deploy-retry.sh rather than a bare
#    `npx hardhat ignition deploy` — it refuses to run at all unless
#    PRODUCTION is actually true (a real safety check, not just a reminder),
#    and auto-retries known-transient failures (RPC outages, nonce races,
#    underpriced gas) instead of leaving a partial deploy for you to
#    diagnose by hand:
./scripts/ignition-deploy-retry.sh --network base-sepolia \
  --deploy-script ignition/modules/DeployAndConfig.ts

# 3. Flip PRODUCTION back to false immediately.

# 4. Confirm the test suite still passes against the local ephemeral network
#    (this does NOT touch the real deploy — it's just re-validating the repo
#    state is sane):
npx hardhat test
```

If step 2 stops on a non-retryable error, re-running the same command is safe
— Hardhat Ignition's own journal makes re-invocation resumable (it skips
whatever already completed), which is exactly what the retry script leans on.

### 1.3 What this deploy does that's new since the last one

- Deploys the real `SelfieCheckEligibilityProvider` (not the `MockAlwaysEligible`
  test stand-in), owned by the deployer and handed to `MAP_EDITOR` at the end
  of the module, same as every other `Ownable` contract.
- Calls `setAuthorizedVerifier(FIREBASE_FLOW_MINTER, true)` on it — the
  existing ship-minting backend wallet also becomes the Selfie-Check-verifying
  backend's relay key. **This does not mean Selfie Check verification is
  live** — the backend still needs to actually implement the
  off-chain-verify-then-`markVerified` flow (see the FE/BE handoff doc).
- Wires that **one shared instance** to both `FreeShipClaim.setEligibilityProvider`
  and `TutorialClaim.setEligibilityProvider`.
- **Behavior change, take this seriously:** once this is live, `FreeShipClaim.
  claimFreeShips` and `TutorialClaim.completeTutorialWinPath`/
  `completeTutorialLossPath` are immediately, unconditionally gated on
  `SelfieCheckEligibilityProvider.isEligible(player)` — there's no "leave it
  open for now" lever once a real (non-zero-address) provider is wired. If
  the backend relay isn't ready yet, **every player is locked out of free
  ships and tutorial rewards** until it is. Confirm this is the intended
  timing before running Phase 1 for real.
- `FreeShipClaim.claimFreeShips` now emits `FreeShipsClaimed(player, amount)`
  on-chain for the first time (previously only in source, unreachable on the
  live deploy) — this is what unblocks Pick 1's subgraph indexing of it.

### 1.4 `Ships.paused` — the "unlock ship minting after we deploy" lever

`Ships.sol` has an owner-only `setPaused(bool)` / public `paused` flag,
checked inside `_mintShip` (so it blocks `createShips`/`createSpecificShip`
regardless of which authorized-minter contract calls them). It defaults to
`false` and nothing in `DeployAndConfig.ts` touches it — so **minting is live
immediately after Phase 1** unless you explicitly call `Ships.setPaused(true)`
yourself as a manual post-deploy step. If you intend to keep it paused for a
period after this deploy before "unlocking" minting for players, that's a
manual call, not something either script does.

**Interaction with Phase 2:** Phase 2's smoke test only performs a swap — it
never mints a ship, so it's unaffected by `paused`. But the *real* first
`UTCLotteryHook.resolveDraw()` call **does** mint a prize ship
(`createSpecificShip`/`createShips`), and will revert while `Ships.paused ==
true`. Make sure minting is unpaused before the first real draw is expected to
resolve, not just before Phase 2 runs.

---

## Phase 2 — Uniswap lottery pool deploy

Only run this after Phase 1 is live and you've confirmed
`ignition/deployments/chain-84532/deployed_addresses.json` reflects it.

### 2.1 Preconditions

- [ ] `.env` has `SHIP_MINTER_PRIVATE_KEY` set (see 1.1) — if it doesn't match
      `Ships.owner()` after Phase 1's handover, the script will print calldata
      for manual submission instead of failing outright, but confirm which
      case you're in before running.
- [ ] Deploy wallet (`METAMASK_WALLET_1`) funded with enough Base Sepolia ETH
      to cover: hook-deploy gas (~12KB contract, budget generously), the
      LP-seed spend (~2x its ETH-equivalent value — see the script's header
      comment), and the smoke-test swap.
- [ ] Decide (or accept the defaults) for the script's optional env vars —
      see `scripts/deployUTCLotteryPool.ts`'s own header comment for the
      full list (`REFERENCE_TIER_INDEX`, `LP_SEED_UC_AMOUNT`,
      `HOOK_OWNER_ADDRESS`, `DRY_RUN_ONLY`).

### 2.2 Run it

```bash
npx hardhat run scripts/deployUTCLotteryPool.ts --network base-sepolia
```

The script is idempotent-by-state-inspection — safe to re-run from the top if
it fails partway (it re-checks bytecode presence, `poolLocked` state, and
current balances before doing anything it's already done).

### 2.3 What it does

Mines a CREATE2 salt against the real canonical deployment proxy, deploys
`UTCLotteryHook`, computes an initial pool price from `ShipPurchaser`'s live
mint rate, sources LP-seed UC via `purchaseUTCWithFlow`, initializes the real
Uniswap v4 pool (**the one genuinely irreversible step** — see the script's
header comment for why that's not treated as high-ceremony right now), adds
liquidity, grants the hook `Ships.setIsAllowedToCreateShips`, and runs one
real smoke-test sell swap — verified via both the decoded `SellRecorded` event
and a direct state read before the script declares success.

### 2.4 If something goes wrong

- **`PoolAlreadyLocked` / the script reports a hook locked to the wrong
  pool:** there is no on-chain fix for that specific hook address. Just
  re-run the script — it mines a *fresh* salt/hook address each run (nothing
  caches a previous mined address), so a new attempt gets a clean hook. Don't
  try to reuse the old hook address for anything.
- **Manual grant printed instead of sent:** `SHIP_MINTER_PRIVATE_KEY` didn't
  match `Ships.owner()`. Submit the printed `to`/`data` from whichever wallet
  actually holds owner rights (e.g. via Basescan's "Write Contract" using raw
  calldata, or a separately-keyed script run).
- **Smoke test fails to find a `SellRecorded` event:** don't assume the pool
  is broken — check `hook.minEntryThresholdWei()` against what the script
  computed the smoke-test sell size from; a large price move between the
  script's rate read and the actual swap (unlikely on a fresh pool, but
  possible) could shrink real proceeds below the threshold. Re-run with a
  larger `LP_SEED_UC_AMOUNT` / investigate before assuming something is wrong
  with the hook itself.

### 2.5 After a successful run

- Copy the printed hook address, `PoolKey`, and `sqrtPriceX96` into
  `docs/uniswap-lottery-selfie-check-frontend-integration.md`'s constants
  table (currently marked `TBD`) — the script does not persist its own
  output anywhere.
- Curate real `PrizeTemplate`s via `UTCLotteryHook.queuePrizeTemplate` (owner
  call) — the queue starts empty, so every draw uses the random-4-star
  fallback until you do.
- Confirm `Ships.paused` is `false` before the first real draw is expected to
  resolve (see 1.4).
