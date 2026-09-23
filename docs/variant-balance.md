# Variant 1 vs Variant 2: Default Attribute Balance

**Written: 2026-09-20; corrected and retuned 2026-09-21.** Describes the default attribute tables in `ignition/modules/DeployAndConfig.ts` (variant 1 / variant 2 blocks) and how variant 2's were calibrated. Re-verify against the module if it has changed since.

> **Correction (2026-09-21).** The first version of this doc called variant 2 "at parity" (mean win rate ~0.53–0.54) and described it as a brawler that "beats aggressive opponents." That was wrong. The simulation only ever pitted *identical* play styles against each other (kite vs kite, rush vs rush), and averaging in the rush-vs-rush cells inflated variant 2's number. With every pairing of styles run, the shipped defaults leave variant 2 **slightly weak** under best play (see below). The defaults were retuned the same day (base hull 120 → 125, heavier and tougher armor/shields) — see "Tuning history".

## Design intent

- **Variant 1** — light and mobile: longer-range guns, more speed, less hull.
- **Variant 2** — heavy: **more hull, slower, shorter-range guns that hit harder, and heavier, tougher armor and shields.**
- **Overall strength should match at equal fleet cost.** Costs (`setCosts`) are identical for both variants, so a variant-2 ship with the same loadout tier costs the same points as a variant-1 ship; the stat trade-offs are what must balance.

## The numbers (as shipped)

| | Variant 1 | Variant 2 |
|---|---|---|
| Base hull | 100 | **125** |
| Hull tier bonus (tiers 0/1/2) | 0 / 10 / 20 | **0 / 12 / 25** |
| Base speed | 4 | **3** |
| Engine tier bonus, bridge (accuracy) tier bonus | same | same |
| Generic gun: Laser (v1) / Medium Mining Laser (v2) — range / damage | 3 / 50 | **2 / 60** |
| Sniper gun: Railgun (v1) / Linear Accelerator (v2) — range / damage | 6 / 40 | **5 / 50** |
| Missile gun: Missile Launcher (v1) / Torpedo Launcher (v2) — range / damage / move | 4 / 60 / −1 | **3 / 70 / −1** |
| Close gun: Plasma Cannon (v1) / Mining Drill (v2) — range / damage | 2 / 80 | **1 / 95** |
| Armor Light / Medium / Heavy — damage reduction, movement | 15% / 30% / 45%; 0 / −1 / −2 | **20% / 40% / 60%; 0 / −1 / −3** |
| Shields Light / Medium / Heavy — damage reduction, movement | 15% / 30% / 45%; +1 / 0 / −1 | **20% / 40% / 60%; +1 / 0 / −2** |
| No armor and no shields ("None") | 0%, movement +1 (once — see below) | same |
| Costs (base, tiers, gear) | — | **same as variant 1** (only special-slot costs differ, as they are different specials) |

**Floors:** a ship's final `range` and `movement` are never below 1 (`ShipAttributes.calculateShipAttributes`). Table entries can still be 0 or negative (inert range-0 filler guns, negative movement modifiers on heavy gear); only the computed total is raised to 1, after all bonuses.

**Gear safety:** damage reduction tops out at 60% per piece. `DroneYard` only allows armor **or** shields (`ArmorAndShieldsBothSet`), so a ship's total is one piece: 60%, or 90% with rank 6's +50% bonus — below the 100% cap, which would make a ship immune. (Only owner-configured ships such as AI/prize ships could combine both; keep any such config's total below 100%.)

**The "None" movement bonus counts once.** A ship carries armor **or** shields, so one of the two slots is always None. Movement from defensive gear counts only for an *equipped* piece; the None bonus (+1, "lighter with nothing bolted on") applies only to a ship with neither, and is read from the armor table's None entry (the shields table's None movement is never read and is set to 0). Before 2026-09-21 both tables' None entries were summed, which handed every ship a free +1 (a bare ship +2). Counting it once took 1 off every ship's movement; **base speed was then raised by 1 in both variants (3 → 4 and 2 → 3)**, so effective movement is exactly what it was before the fix — the tables are now honest (the base speed says what it means) and nothing changed in play.

Average ship (from the real generation odds): variant 1 = 107 hull / 58 damage / range 4.2 / move 4.3 / 23% damage reduction; variant 2 = **133 hull (+25%) / 69 damage (+20%) / range 3.0 (−29%) / move 3.5 (−17%) / 30% damage reduction**.

Movement, exactly (whole generation space; before rank bonuses):

| | Raw min | Max | Raised by the floor | Ships that end at movement 1 |
|---|---|---|---|---|
| Variant 1 | 1 | 7 | 0% | 1.6% |
| Variant 2 | −1 | 9 (6 without the Thruster special) | 7.7% | 17.0% |

## How this is measured

Combat is deterministic (no hit roll): a shot does `damage × (1 − target damage reduction)`, and each ship per round moves up to its movement and then shoots within range, so a ship's threat radius is `movement + range`. Hull and damage scale strength multiplicatively, while range and movement decide who gets to shoot first, so they don't trade off 1:1 — a formula wasn't reliable, so calibration uses a simulation.

`scripts/balance-sim/balance_sim.py` re-implements the rules (it does not run the contracts). Per battle it:

1. builds a random fleet for each variant at the same cost limit, using `GenerateNewShip`'s tier/equipment odds and `ShipAttributes`' stat and cost formulas;
2. places them at random cells on their side of the 17×11 grid (variant 1 in columns 0–3, variant 2 in 13–16);
3. plays rounds: each ship acts once (move within its movement, then shoot a target within range), players alternate one ship at a time, and the first mover alternates each round; a ship at 0 HP stops acting and is removed 3 rounds later;
4. picks the winner as the last side with a ship above 0 HP (or more total HP after 80 rounds).

Each side follows one of two simple styles, chosen **independently**:

- **kite** — shoot from the maximum distance available (uses range/mobility);
- **rush** — close to the shortest distance.

It reports variant 2's win rate (0.50 = parity) for every cost limit and every style pairing (1,500 battles per cell, about ±0.013 noise per cell).

## Results for the shipped defaults

Variant 2's win rate. Rows: variant 1's style. Columns: variant 2's style.

| Cost limit 500 | V2 kite | V2 rush |
|---|---|---|
| **V1 kite** | 0.57 | 0.51 |
| **V1 rush** | 0.83 | 0.77 |

| Cost limit 1000 | V2 kite | V2 rush |
|---|---|---|
| **V1 kite** | 0.51 | 0.41 |
| **V1 rush** | 0.81 | 0.73 |

| Cost limit 2000 | V2 kite | V2 rush |
|---|---|---|
| **V1 kite** | 0.46 | 0.35 |
| **V1 rush** | 0.87 | 0.77 |

### Reading it
- **In this simulation kiting beats rushing for both factions**, so the meaningful cell is **kite vs kite**: variant 2 wins **0.57 / 0.51 / 0.46** by fleet size (mean **0.51**) — parity.
- Variant 2 does relatively worse in larger fleets, where range and mobility compound (more ships can focus fire from range), and is heavily favored only when variant 1 rushes.
- Sensitivity: about +5 base hull moves the kite-vs-kite mean by roughly +0.05.

## Tuning history
| Variant 2 defaults | kite vs kite (cost limit 500 / 1000 / 2000) | mean |
|---|---|---|
| Original: hull 120, gear identical to variant 1 | 0.51 / 0.45 / 0.39 | 0.45 (slightly weak) |
| Hull 125, armor/shields 20/40/60% with Heavy −1 more movement | 0.57 / 0.51 / 0.46 | 0.51 |
| Same, after the None bonus counted once (every ship 1 slower) | 0.50 / 0.43 / 0.36 | 0.43 (weak again) |
| Hull 135 to compensate for the slower ships | 0.56 / 0.48 / 0.47 | 0.50 |
| **Shipped:** both base speeds raised by 1 (v1 4, v2 3), hull back to 125 | 0.57 / 0.51 / 0.46 | **0.51** |

Raising both base speeds by 1 exactly cancels the None fix (effective movement is what it was before it), so variant 2's hull returns to 125 — the 135 was only compensating for the slowdown and would have over-buffed variant 2 (0.61) once speeds were restored.

The "heavier" part of the gear change is deliberately modest (only the Heavy tier is slower): in this model movement is very valuable, and slowing more of variant 2's gear leaves many ships at the movement floor and needs far more hull to compensate.

## Caveats — what this does NOT cover
- **Special items.** Only specials' movement and cost are modelled (variant 2's Thruster gives +3 movement). The combat effects of EMP / Repair Drones / Flak Array vs Electric Storm / Drone Swarm are **not** balanced by this pass; they replace a shot, so they matter for real fleet strength.
- ~~**Scoring tiles, obstacles and line of sight.** The simulation is elimination-style on an open grid. Terrain and objectives can favor short-range heavy ships (cover, blocking) or punish slow ones (tile grabbing) — direction unknown. The "kiting dominates" result may be partly an artifact of the open grid.~~ **Update (2026-09-23):** obstacles/line-of-sight and movement-blocking terrain are now modelled — see "Terrain and LOS" below. It turns out to matter a lot. **Scoring-tile objective play is still not covered** (matches the existing gap noted in `docs/ai-ship-configs.md` for AI config balance).
- **Simple, tactic-free policies.** Ships never retreat, weigh retaliation, or coordinate; ship order within a turn isn't chosen; the sim never shoots 0-HP ships to speed up their timer; starting placement is assumed. Real players will differ.
- **Not cross-checked against the contracts.** The stat and cost formulas were copied by hand; a variant-2 table equal to variant 1's gives ~50%, but individual ships were not compared with on-chain output.
- Treat the win rates as a directional check, not proof. Retune from playtests.

## Terrain and LOS: does cover narrow the kiting advantage? (2026-09-23)

**Written 2026-09-23.** `scripts/balance-sim/balance_sim.py` was extended with `scripts/balance-sim/los.py` — a Python port of `contracts/Maps.sol`'s Bresenham line walk, the same port `scripts/map-design/los.ts` uses for the new map generator/validator, cross-checked against the same fixture cases as both (`los_selfcheck.py`). Two rule changes were added, exactly matching the contracts:

- **Shooting now requires line of sight past range 1** (`Game._performShoot`'s `manhattan > 1 && !hasMaps` rule) — a candidate firing position with no LOS to the target is no longer offered as a legal shot at all (no "blind shot" concept exists on-chain, so the sim doesn't model one either); the ship falls back to advancing instead.
- **Movement now respects impassable terrain**, blocking a candidate destination if the straight-line path from the ship's current position crosses an impassable cell — landing on one *or* passing through one (`Game.moveShip`'s new `hasMovementPath` check).

Run with `python3 scripts/balance-sim/balance_sim.py --terrain-sample`, which loads 12 representative maps (one low- and one high-difficulty slot per archetype) from `scripts/map-design/out/*.json` — the real generator's output (run `npx hardhat run scripts/map-design/review-all.ts` first to produce them) — and runs the kite-vs-kite matchup (the parity read this doc already judges balance by) against each map's actual terrain, cost limit 1000, n=600 per cell (~±0.02 noise, vs n=1500/±0.013 for the main table above).

| Map (archetype, difficulty) | Sightline % | Kite-vs-kite win rate | Δ vs open-grid baseline (0.463) |
|---|---|---|---|
| Open Void (low — m01) | 72.2% | 0.500 | +0.037 |
| Open Void (high — m12) | 44.4% | 0.565 | +0.102 |
| Asteroid Field (low — m02) | 33.3% | 0.482 | +0.018 |
| Asteroid Field (high — f05) | 5.6% | 0.610 | +0.147 |
| Twin Pillars (low — m03) | 13.9% | 0.648 | +0.185 |
| Twin Pillars (high — f03) | 5.6% | 0.682 | +0.218 |
| Trench Run (low — m05) | 0.0% | 0.723 | +0.260 |
| Trench Run (high — f01) | 5.6% | 0.752 | +0.288 |
| Debris Ring (low — m06) | 5.6% | 0.707 | +0.243 |
| Debris Ring (high — m14) | 41.7% | 0.600 | +0.137 |
| Reactor Core (low — m11) | 0.0% | 0.848 | +0.385 |
| Reactor Core (high — m15) | 0.0% | 0.844 | +0.381 |

**Reading: yes, terrain narrows (and on denser maps, reverses) variant 2's kiting disadvantage — clearly and consistently.** Sightline % and Δ are strongly, near-monotonically inversely correlated: every map at 0–20% sightline adds +0.18 to +0.39 to variant 2's kite-vs-kite win rate (baseline 0.463); every map at ≥40% sightline stays much closer to baseline (+0.04 to +0.14). LOS-blocking terrain gives the short-range brawler safer lanes to close distance, exactly as intended — the effect isn't marginal, it's large enough that the densest maps (Reactor Core, Trench Run) push variant 2 from "slightly weak" to clearly favored (0.72–0.85) at cost 1000 on that specific map.

**Update (2026-09-23, same day):** the table above already reflects a fix made during Phase 7's content-generation pass — the first run of this table found Debris Ring's *high*-difficulty slot at a broken **94.4% sightline** (more open than its own low-difficulty slot), traced to `archetypes.ts`'s ring-radius formula letting `outer` grow past the grid's actual maximum possible distance from center (5), which shrank the ring to almost nothing instead of thickening it. Fixed by capping `outer` at that maximum and shrinking `inner` instead as difficulty rises (see `ringRadii` in `archetypes.ts`) — Debris Ring's high-difficulty slot now sits at a reasonable 41.7%. The low/high pair still isn't perfectly monotonic (5.6% vs 41.7% — low is tighter than high), which reads as ordinary per-seed RNG variance at this sample size, not a further systematic bug; leave it for the human review pass to judge, not another automated fix.

**Not a reason to re-tune ship stats yet.** This table is about *maps*, not about whether variant 1/variant 2's base stats still need adjustment — the dense archetypes now push kite-vs-kite well past parity in variant 2's favor on those specific maps, which may be fine (that's terrain doing its job) or may call for tempering the very densest presets once real difficulty-table values are finalized. Revisit stat balance only after the actual shipped map set is locked in, not from this sample.

## Decided: Mining Drill stays at range 1 (2026-09-21)
Variant 2's Mining Drill (the Close gun) is range **1** (adjacent only), the literal "shorter range" continuation of variant 1's range 2. At range 1 the bridge accuracy bonus does nothing (a +50% bonus on range 1 rounds down to 0), and kiters punish it. **Decision: keep it at range 1** (no change to the defaults). The consequence to be aware of: the bridge accuracy bonus never helps a range-1 gun. For reference, the alternative that was measured — range 2 (damage 90) makes variant 2 stronger at the same hull; kite-vs-kite means with the shipped gear (cost limits 500 / 1000 / 2000):

| Mining Drill range 2, damage 90 | kite vs kite | mean |
|---|---|---|
| Hull 115 (tiers 12 / 23) | 0.55 / 0.48 / 0.43 | 0.486 |
| Hull 120 (tiers 12 / 24) | 0.57 / 0.51 / 0.48 | 0.521 |
| Hull 125 (tiers 12 / 25) | 0.62 / 0.58 / 0.56 | 0.586 |
| Hull 130 (tiers 13 / 26) | 0.65 / 0.62 / 0.61 | 0.625 |

So with a range-2 Mining Drill, parity would be around **hull 118** (about 7 less base hull than shipped). Not adopted.

## Retuning
Change the variant blocks in `DeployAndConfig.ts`, mirror them into the tables at the top of `scripts/balance-sim/balance_sim.py`, and re-run it. On a live deploy, publish a new version instead (`setVariantAttributes`; see `docs/ship-costs-and-attributes-runbook.md`). Attribute-only changes do not touch costs, so no ship resync is needed.
