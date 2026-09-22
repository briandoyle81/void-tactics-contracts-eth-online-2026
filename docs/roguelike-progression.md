# Roguelike Enemy Progression

**Written: 2026-09-21.** Describes the roguelike campaign's enemy progression as seeded by `ignition/modules/DeployAndConfig.ts` from `ignition/data/roguelikeStarterContent.json`. Re-verify against those files if they have changed since.

## The rule

**The first three missions on any path fight variant 1 ships. Every later mission fights variant 2.**

A node's **mission number** is the number of *Combat* nodes on the path from the root to it, inclusive (Resupply nodes don't count). Because the graph branches, "mission 3" is a set of nodes:

| Mission | Nodes | Enemies |
|---|---|---|
| 1 | `m01` | variant 1 |
| 2 | `m02` | variant 1 |
| 3 | `m03` (main spine), `d01` (dead-end branch), `s01` (shortcut branch) | variant 1 |
| 4 and beyond | everything else — `m04`…`m15`, `d02`…`d06`, `s02`, `s03`, `f01`…`f06` | variant 2 |

The player's side is unchanged: the roguelike campaign requires variant 1 ships (`requiredVariant: 1`), so the first three missions are variant 1 against variant 1, and from mission 4 on the enemy is the heavier variant 2.

## How it is built

The roguelike graph shares its map layouts with the NodeMap (single-player) campaign, but enemy rosters are attached **per map id** (`AIEncounters.setMapPlacements`), and the campaign's 30 maps use variant 2 rosters. Changing those would change the campaign too, so the five early missions get their **own maps**:

- `roguelikeStarterContent.json` has `maps` (`rlM01`, `rlM02`, `rlM03`, `rlD01`, `rlS01`) — exact clones of the campaign maps `m01`, `m02`, `m03`, `d01`, `s01` (same blocked tiles, scoring tiles, mode) — and `mapPlacements` for them: spawn positions taken from the campaign map's, with rosters designed for variant 1 (they started as the variant 2 originals with each `v2…` config swapped for its variant 1 counterpart, then were retuned to introduce the variant 1 kit and smooth the difficulty ramp — see `docs/ai-ship-configs.md`).
- The five matching nodes' `mapKey` points at those maps; every other node still uses a campaign map.
- The deploy module seeds these maps in the **same chained sequence** as the campaign maps, appended after them (ids 31–35). Map ids are computed from array position, so keeping the chain unbroken matters (see the Ignition execution-order note in `CLAUDE.md`).

The NodeMap campaign is untouched (all 30 of its maps are still variant 2).

## Things to know

- **No DEC from the first three missions.** Kill rewards are paid in the destroyed ship's faction token, and only variant 2 has a reward token registered (`FactionRewardTokenRegistry`); destroying variant 1 ships emits `RewardSkipped`. If you want early-game rewards, register a variant 1 token.
- **Variant 1 enemies are weaker** than the variant 2 rosters they replace (less hull and armor, faster, longer range), and they kite. The first three missions are therefore easier than before. The variant 1 Support configs already equip Repair Drones, so they heal.
- **`d01` and `s01` count as mission 3.** They are the third fight on their branches, so they use variant 1. `s01` (the risky shortcut) is a deliberately harder 4-ship roster than a normal mission 3 — an earlier 7-ship version was out of reach.
- **The AI ship configs were redesigned** (2026-09-21, see `docs/ai-ship-configs.md`): each faction's ships now use their own kit — specials, faction abilities, and a variant 1 Rammer — and the five variant 1 rosters introduce it gradually.

## Changing the progression

- **Different number of variant 1 missions:** the graph and rosters are data. Re-point the affected nodes' `mapKey` in `roguelikeStarterContent.json` to variant 1 (or variant 2) maps, adding `maps` / `mapPlacements` entries as needed. `test/RoguelikeProgression.test.ts` has a `VARIANT_1_MISSIONS` constant that must match.
- **On a live deploy:** use `AIEncounters.setMapPlacements` on the affected map ids (the roguelike-only maps for early missions). Changing a campaign map's placements would change the NodeMap campaign as well.

## Verification

`test/RoguelikeProgression.test.ts` walks the graph as deployed on-chain, computes each node's mission number, and asserts every mission ≤ 3 has only variant 1 enemies and every later mission only variant 2 — plus that the campaign's own 30 maps are unchanged and the early missions use roguelike-only maps.
