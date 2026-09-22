# AI Ship Configs

**Written: 2026-09-21.** Describes the 52 seeded AI ship configs in `ignition/data/singlePlayerStarterContent.json` (`aiShipConfigs`) as of this date, how they were designed, and how to iterate on them. The stat table below is generated from `scripts/balance-sim/ai_config_lab.py`; re-verify against the data file if it has changed since.

## What was wrong

The first set of configs was one template copied for both factions (variant 2 = variant 1 with a `v2` prefix):

- **No faction identity.** Every variant 2 config equipped no special, so none of variant 2's kit (Electric Storm, Drone Swarm, Thruster) was ever used; variant 1 used only Repair Drones on Supports. The new behavior trees' Flak, EMP, Swarm, Storm and Ram logic had nothing to act on.
- **Ships that couldn't do their job.** The heaviest variant 2 ships were crawlers — `v2aggressor5` had movement 1, `v2grunt5` movement 2 — for a "brawler" tree whose whole plan is advancing at full speed.
- **Skirmishers in slow gear.** Variant 1's fast skirmishers wore armor (which slows) instead of shields.
- **No Rammer** existed, although variant 1 has the Ram ability and a Rammer tree.

## Design principles

1. **Each faction's ships play its faction's role.** Variant 1 = light, fast, long-range skirmishers in *shields* (shields keep them quick). Variant 2 = heavy, slow, tough brawlers in *armor*, short guns that hit hard.
2. **Equipment fits the archetype's tree.** Snipers carry the sniper gun; Support carries the faction's heal (variant 1: the Repair Drones *special*; variant 2: the innate repair ability, so no special needed); Turtles are the toughest tile-holders; the Rammer is fast.
3. **Each faction's whole kit is used, on the archetype that benefits:**

| Special | Faction | Equipped on | Why |
|---|---|---|---|
| EMP (1) | variant 1 | Aggressor (top level) | adjacent finisher — it presses close |
| Repair Drones (2) | variant 1 | Support (all levels) | how variant 1 heals |
| Flak Array (3) | variant 1 | Grunt / Turtle (levels 3+) | AoE from a stand-off or held position |
| Electric Storm (1) | variant 2 | Aggressor (level 4) | finishes downed enemies after the melee |
| Drone Swarm (2) | variant 2 | Grunt / Turtle (levels 3–4) | reach past a short gun (range 5, ignores line of sight) |
| Thruster (3) | variant 2 | the heaviest ships (level 5) | heavy armor/shields would otherwise leave them crawling |

4. **Viable ships.** Every ship moves at least 3 (Turtles, which hold ground, at least 2). Level 5 heavy variant 2 ships get a Thruster to stay mobile.
5. **A level ramp that tracks cost.** Levels 1–5 rise in cost (about 80–120 at level 1 to 175–205 at level 5) so a roster's total cost tracks its difficulty. Costs are within a few percent of the previous set, so existing rosters keep their difficulty.

These rules are enforced by `test/AIShipConfigs.test.ts` against the configs as deployed (real on-chain stats): movement floors, archetype equipment, per-faction specials, cost ramp, "whole kit used", and that variant 2 is tougher and shorter-ranged than variant 1.

## The configs

Stats are the real on-chain values (level = trailing digit of the key; none = 1).

### Variant 1 — skirmishers

| key | role | gun | gear | special | acc/hull/speed | hull | dmg | range | move | DR | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `grunt` | Grunt | Laser | Light shields | — | 0/0/0 | 100 | 50 | 3 | 5 | 15% | 85 |
| `grunt2` | Grunt | Laser | Light shields | — | 1/1/1 | 110 | 50 | 3 | 6 | 15% | 115 |
| `grunt3` | Grunt | Laser | Light shields | Flak Array | 2/1/1 | 110 | 50 | 4 | 6 | 15% | 145 |
| `grunt4` | Grunt | Laser | Medium shields | Flak Array | 2/2/1 | 120 | 50 | 4 | 5 | 30% | 170 |
| `grunt5` | Grunt | Laser | Heavy shields | Flak Array | 2/2/2 | 120 | 50 | 4 | 5 | 45% | 195 |
| `aggressor` | Aggressor | Missile Launcher | Light shields | — | 0/1/1 | 110 | 60 | 4 | 5 | 15% | 120 |
| `aggressor2` | Aggressor | Missile Launcher | Light shields | — | 1/2/2 | 120 | 60 | 5 | 6 | 15% | 160 |
| `aggressor3` | Aggressor | Missile Launcher | Light shields | — | 2/2/2 | 120 | 60 | 6 | 6 | 15% | 175 |
| `aggressor4` | Aggressor | Missile Launcher | Medium shields | — | 2/2/2 | 120 | 60 | 6 | 5 | 30% | 185 |
| `aggressor5` | Aggressor | Missile Launcher | Heavy shields | EMP | 2/2/2 | 120 | 60 | 6 | 4 | 45% | 205 |
| `sniper` | Sniper | Railgun | Light shields | — | 1/0/0 | 100 | 40 | 7 | 5 | 15% | 100 |
| `sniper2` | Sniper | Railgun | Light shields | — | 2/1/1 | 110 | 40 | 9 | 6 | 15% | 135 |
| `sniper3` | Sniper | Railgun | Light shields | — | 2/2/2 | 120 | 40 | 9 | 7 | 15% | 165 |
| `sniper4` | Sniper | Railgun | Medium shields | — | 2/2/2 | 120 | 40 | 9 | 6 | 30% | 175 |
| `sniper5` | Sniper | Railgun | Heavy shields | — | 2/2/2 | 120 | 40 | 9 | 5 | 45% | 185 |
| `support` | Support | Laser | Light shields | Repair Drones | 0/0/0 | 100 | 50 | 3 | 5 | 15% | 105 |
| `support2` | Support | Laser | Light shields | Repair Drones | 1/1/1 | 110 | 50 | 3 | 6 | 15% | 135 |
| `support3` | Support | Laser | Light shields | Repair Drones | 2/2/2 | 120 | 50 | 4 | 7 | 15% | 180 |
| `support4` | Support | Laser | Medium shields | Repair Drones | 2/2/2 | 120 | 50 | 4 | 6 | 30% | 190 |
| `support5` | Support | Laser | Heavy shields | Repair Drones | 2/2/2 | 120 | 50 | 4 | 5 | 45% | 200 |
| `turtle` | Turtle | Laser | Light armor | — | 0/1/0 | 110 | 50 | 3 | 4 | 15% | 90 |
| `turtle2` | Turtle | Laser | Light armor | — | 1/2/1 | 120 | 50 | 3 | 5 | 15% | 125 |
| `turtle3` | Turtle | Laser | Medium armor | Flak Array | 2/2/1 | 120 | 50 | 4 | 4 | 30% | 160 |
| `turtle4` | Turtle | Laser | Medium armor | Flak Array | 2/2/2 | 120 | 50 | 4 | 5 | 30% | 175 |
| `turtle5` | Turtle | Laser | Heavy armor | Flak Array | 2/2/2 | 120 | 50 | 4 | 4 | 45% | 180 |
| `rammer` | Rammer | Laser | Light shields | — | 0/1/2 | 110 | 50 | 3 | 7 | 15% | 120 |
| `rammer2` | Rammer | Laser | Medium shields | — | 1/2/2 | 120 | 50 | 3 | 6 | 30% | 155 |

### Variant 2 — brawlers

| key | role | gun | gear | special | acc/hull/speed | hull | dmg | range | move | DR | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `v2grunt` | Grunt | Medium Mining Laser | Light armor | — | 0/0/0 | 125 | 60 | 2 | 3 | 20% | 80 |
| `v2grunt2` | Grunt | Medium Mining Laser | Light armor | — | 1/1/1 | 137 | 60 | 2 | 4 | 20% | 110 |
| `v2grunt3` | Grunt | Medium Mining Laser | Light armor | Drone Swarm | 2/2/1 | 150 | 60 | 3 | 4 | 20% | 160 |
| `v2grunt4` | Grunt | Medium Mining Laser | Medium armor | Drone Swarm | 2/2/1 | 150 | 60 | 3 | 3 | 40% | 165 |
| `v2grunt5` | Grunt | Medium Mining Laser | Heavy armor | Thruster | 2/2/2 | 150 | 60 | 3 | 5 | 60% | 175 |
| `v2aggressor` | Aggressor | Mining Drill | Light armor | — | 0/1/1 | 137 | 95 | 1 | 4 | 20% | 115 |
| `v2aggressor2` | Aggressor | Mining Drill | Light armor | — | 1/2/2 | 150 | 95 | 1 | 5 | 20% | 155 |
| `v2aggressor3` | Aggressor | Mining Drill | Light armor | — | 2/2/2 | 150 | 95 | 1 | 5 | 20% | 170 |
| `v2aggressor4` | Aggressor | Mining Drill | Medium armor | Electric Storm | 2/2/2 | 150 | 95 | 1 | 4 | 40% | 190 |
| `v2aggressor5` | Aggressor | Mining Drill | Heavy armor | Thruster | 2/2/2 | 150 | 95 | 1 | 5 | 60% | 190 |
| `v2sniper` | Sniper | Linear Accelerator | Light shields | — | 1/0/0 | 125 | 50 | 6 | 4 | 20% | 100 |
| `v2sniper2` | Sniper | Linear Accelerator | Light shields | — | 2/1/1 | 137 | 50 | 7 | 5 | 20% | 135 |
| `v2sniper3` | Sniper | Linear Accelerator | Light shields | — | 2/2/2 | 150 | 50 | 7 | 6 | 20% | 165 |
| `v2sniper4` | Sniper | Linear Accelerator | Medium shields | — | 2/2/2 | 150 | 50 | 7 | 5 | 40% | 175 |
| `v2sniper5` | Sniper | Linear Accelerator | Heavy shields | Thruster | 2/2/2 | 150 | 50 | 7 | 6 | 60% | 195 |
| `v2support` | Support | Medium Mining Laser | Light shields | — | 0/0/0 | 125 | 60 | 2 | 4 | 20% | 85 |
| `v2support2` | Support | Medium Mining Laser | Light shields | — | 1/1/1 | 137 | 60 | 2 | 5 | 20% | 115 |
| `v2support3` | Support | Medium Mining Laser | Light shields | — | 2/2/2 | 150 | 60 | 3 | 6 | 20% | 160 |
| `v2support4` | Support | Medium Mining Laser | Medium shields | — | 2/2/2 | 150 | 60 | 3 | 5 | 40% | 170 |
| `v2support5` | Support | Medium Mining Laser | Heavy shields | Thruster | 2/2/2 | 150 | 60 | 3 | 6 | 60% | 190 |
| `v2turtle` | Turtle | Medium Mining Laser | Light armor | — | 0/1/0 | 137 | 60 | 2 | 3 | 20% | 90 |
| `v2turtle2` | Turtle | Medium Mining Laser | Light armor | — | 1/2/1 | 150 | 60 | 2 | 4 | 20% | 125 |
| `v2turtle3` | Turtle | Medium Mining Laser | Medium armor | Drone Swarm | 1/2/2 | 150 | 60 | 2 | 4 | 40% | 165 |
| `v2turtle4` | Turtle | Medium Mining Laser | Medium armor | Drone Swarm | 2/2/2 | 150 | 60 | 3 | 4 | 40% | 180 |
| `v2turtle5` | Turtle | Medium Mining Laser | Heavy armor | Drone Swarm | 2/2/2 | 150 | 60 | 3 | 2 | 60% | 185 |

## Variant 1 early missions

The roguelike's first three missions fight variant 1 (see `docs/roguelike-progression.md`). Their rosters were retuned to introduce the variant 1 kit gradually and to give a smooth difficulty ramp:

| Mission | Node | Roster | Introduces |
|---|---|---|---|
| 1 | `m01` | grunt, aggressor, sniper | skirmishers that kite |
| 2 | `m02` | grunt II, aggressor II, sniper II | the same, tougher |
| 3 | `m03` | grunt, aggressor II, sniper, support | a healer (Repair Drones) |
| 3 | `d01` | grunt, aggressor, turtle II, rammer | tile-holding and Ram |
| 3 | `s01` | grunt, aggressor II, sniper II, rammer | the risky shortcut (was a 7-ship, 1,110-cost roster no fleet could beat) |

Simulated player win rates (a random variant 1 fleet at the 500 cost cap, 400 battles): about **0.94, 0.59, 0.41, 0.43, 0.15**. The player's early fleet is the weak baseline here; a real, upgraded fleet does better.

## Iterating

```
python3 scripts/balance-sim/ai_config_lab.py table [old|new]   # derived stats + design checks
python3 scripts/balance-sim/ai_config_lab.py curve [old|new]   # difficulty curve over the roguelike graph
python3 scripts/balance-sim/ai_config_lab.py eff   [old|new]   # cost efficiency per config
python3 scripts/balance-sim/ai_config_lab.py write              # write the DESIGN into the data file
```

Edit `DESIGN` in the script, run `table` (the checks must pass), `curve` and `eff`, then `write`, then rosters by hand in the data files, then the tests. The lab's numbers use the same stat and cost formulas as the contracts; keep its variant tables in sync with the deploy module (see `balance_sim.py`).

## Things to know

- **The configs are shared with the NodeMap (single-player) campaign**, whose rosters use the variant 2 configs. Their total roster costs moved by 0–6% (largest at `f06`, +5.9%); the missions are otherwise the same.
- **The simulation can't credit** healing, Flak, Swarm, Storm, Ram or objective play, and it penalizes a config for a special's cost without crediting the special. It is a viability and relative-difficulty check, not a prediction — the scenario tests in `test/VariantAITrees.test.ts` and `test/AIShipConfigs.test.ts` are what verify the specials actually fire.
- **Difficulty is mostly about rosters and caps, not config design.** Even after the changes the sim's random-fleet win rates are jagged across the whole graph (cap jumps at resupply nodes ease things; the finale is out of reach for a random fleet). The variant 1 early missions were smoothed; the variant 2 rosters (shared with the campaign) were not touched.
