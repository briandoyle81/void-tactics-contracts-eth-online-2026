# Per-Variant AI: Registry and Variant AI Contracts

**Written: 2026-09-20; per-variant behavior trees added 2026-09-21; ram-on-objective and repair/objective priorities added 2026-09-21.** Describes the AI architecture on `main` after the per-variant AI refactor and the per-variant trees pass. Re-verify against the contracts if they have changed since.

## The rule

**Behavior and strength are looked up by variant first, then slot — and the same holds for AI.** Variant 1's special slot 1 has nothing to do with variant 2's special slot 1, and each variant's AI is written against that faction's own abilities. No shared code assigns a meaning to a slot number.

## Architecture

```
SinglePlayerMatch ─┐                       ┌─> Variant1AI  skirmisher: its own tree per archetype
                   ├─> AIBehaviorRegistry ─┤                (stand off, Flak/EMP, heal special, Ram)
RoguelikeMatch ────┘   aiFor(variant)      └─> Variant2AI  brawler: its own tree per archetype
                                                            (advance, Swarm/Storm, repair ability)
                                                   │
                                        both compose their trees from the
                                        AIBehavior library (shared primitives only)
```

- **`IVariantAI`** — one method: `decide(ctx, archetype, special) → Decision` (read-only; it never acts, the caller does).
- **`AIBehaviorRegistry`** — owner-set `variant → AI contract`. `aiFor(variant)` reverts `NoAIForVariant(variant)` if none is registered (fail loud; there is no silent generic fallback). It is a **lookup, not a forwarding proxy**: the caller fetches the address and calls the AI directly, because forwarding would ABI-encode the large decision context twice.
- **`Variant1AI`** — variant 1's trees: a **skirmisher** (see "Behavior trees" below).
- **`Variant2AI`** — variant 2's trees: a **brawler** (see below).
- **`AIBehavior` (library)** — the shared **toolbox** only: targeting, stepping, scoring-tile logic, and small primitives the trees compose (`standoffPosition`, `advanceToward`, `bestEnemyWithin`, `sweep`, `nearestDownedEnemy`, `doomedEnemyWithin`, `healWithReach`, `ramOnScoringTile`, `claimScoringTile`, `healOnScoringTile`, `healDisabledFrom` / `healDisabledWithReach`, `healAnyFrom`, plus the older `decideTurtle` / `decideSupportFallback` / `decideEngageOrApproach`). What a faction *does* with them — kite or brawl, which special is a heal, whether it can ram — lives in that faction's contract. It is an *internal* library, so it is inlined into each variant AI's bytecode.

Which faction an AI ship belongs to is the ship's `traits.variant` (recorded per AI ship by `SinglePlayerMatch` / `RoguelikeMatch`).

## Behavior trees

Every tree is an ordered priority list of cheap checks (the AI runs on-chain, paid for by whoever triggers the turn, so there is no search — only greedy steps and O(ships) scans). A decision is `(destination, action, target)`; the caller falls back to a Pass if the game rejects it.

### Variant 1 — skirmisher (light, fast, long range)
Stats: movement ~5, guns range 2–6. Kit: **EMP** (slot 1), **Repair Drones** (slot 2), **Flak Array** (slot 3), innate **Ram**.

**Ram on an objective — every archetype, checked first.** Every variant 1 ship has Ram. If an enemy is **at 0 HP and standing on a scoring tile**, and this ship can reach a free tile within Ram's range of it this turn, the ship moves there and rams it (evicting the enemy and taking the tile) before doing anything else — as long as its own reactor timer is ≤ 1 (each ram adds a tick; three destroy it). Of the rows below, only the Rammer also rams a downed enemy that is *not* on a scoring tile.

| Archetype | Tree |
|---|---|
| **Grunt** | Stand off at maximum range: out of range → step in only as far as maximum range; inside range → back away toward maximum range; then act from there. Won't abandon a scoring tile to kite. |
| **Sniper** | Strictest kiter: same, and *will* leave a tile to keep its range. |
| **Aggressor** | Presses the fight: closes to maximum range but never backs off. |
| **Support** | Heals with Repair Drones: moves just far enough to bring the most injured ally (0-HP first) into range, then heals. Otherwise the shared Support fallback (shoot / hold or seek a tile / stay near an injured ally). |
| **Turtle** | Holds objectives; lays Flak from its tile when it pays off. |
| **Rammer** | Also hunts a downed enemy *anywhere* (not just on a scoring tile): moves adjacent and Rams it — again **only while its own reactor timer is ≤ 1**. Otherwise fights like a Grunt. |

Specials (checked from the tile the ship is about to stand on): **Flak Array** hits *every* ship in range, allies included — used only with **no ally in range**, and then for 2+ enemies or 1 enemy the gun can't reach (e.g. line of sight blocked). **EMP** finishes an adjacent enemy whose reactor timer is already ≥ 2.

### Variant 2 — brawler (heavy, slow, short range, tough)
Stats: movement ~4, guns range 1–5, big hull and armor. Kit: innate **Repair** (range 1), **Electric Storm** (slot 1), **Drone Swarm** (slot 2), **Additional Thruster** (slot 3, passive — already in the ship's stats). No Ram.

**Shared priorities — every archetype, highest first.** Every variant 2 ship has Repair (range 1), so all of them follow this list before their archetype's own tree:

1. **Repair an injured or disabled friendly on a scoring tile** (disabled first, then lowest HP; any *other* ship — not itself). It moves to a free tile within reach of it (preferring a scoring tile) and repairs.
2. **Claim a scoring tile**: stay on the one it stands on, else head for the nearest *unclaimed* one at full speed. From there it acts (below).
3. **Repair a disabled (0 HP) friendly** — one within repair range of where it ends up if it has a tile to claim (a holder does not walk off its tile to reach one); if there is no tile to claim, it moves to reach one.
4. *(then shoot / Storm / Swarm, per the tree)*
5. **Last resort — only when nothing above gave it an action:** repair **itself** or any injured friendly within range of where it ends up.

The archetype trees in the table below are used only when there is **no unclaimed scoring tile** (and the ship isn't on one) — e.g. surplus ships once every tile is taken, or a map with no tiles. Otherwise every archetype fights from its objective tile, so an Aggressor no longer leaves a tile to chase an enemy.

| Archetype | Tree |
|---|---|
| **Grunt** | Shoot if anything is in gun range; else hold a scoring tile it stands on; else advance at **full speed**, stopping adjacent (never on the enemy's tile), and shoot from there; reach with Drone Swarm if the guns still can't. |
| **Aggressor** | Same, but never stops to hold a tile — pure pursuit. |
| **Sniper** | Fire support: shoots in place (never retreats — slow ships can't run); otherwise closes only as far as maximum range. |
| **Support** | Storm if safe, shoot if anything is in range, otherwise shadows the most injured ally — moving just far enough to repair it — else the shared fallback. Equipped specials are never used to heal. |
| **Turtle** | Holds objectives; reaches with Drone Swarm when its gun can't. |
| **Rammer** | Faction-1 only; plays as a **Grunt** (variant 2 has no Ram). |

Specials: **Drone Swarm** (range 5, ignores line of sight) is used only when no gun target is in range. **Electric Storm** ticks the reactor timer of *every* ship in range — including the caster and its allies — so it is used only to finish downed enemies, and only when safe: the caster's own timer ≤ 1, no ally in it already near destruction, and no more allies caught than enemies finished; worth it for 2+ finishable enemies, or 1 the gun can't reach.

### Same slot number, different behavior
Slot 2 is a **heal** for variant 1 (Repair Drones) and an **attack** for variant 2 (Drone Swarm); `Variant1AI` heals with it and `Variant2AI` heals only with the faction ability and never aims its slot 2 at an ally. Tests cover this (`test/VariantAITrees.test.ts`).

## Runbooks

### Upgrade a faction's AI
1. Deploy the new AI contract (implementing `IVariantAI`).
2. `AIBehaviorRegistry.setVariantAI(variant, newAddress)` (owner only). Nothing else needs redeploying; the change applies to the next AI decision.
3. To take a variant's AI offline, `setVariantAI(variant, address(0))` — AI turns for that variant then revert `NoAIForVariant`.

### Add a new faction (variant 3, …)
1. Configure the faction's data first (see `docs/ship-costs-and-attributes-runbook.md`, runbook E): `setCosts`, `setVariantAttributes`.
2. Register the faction's special resolvers `Game.setSpecialResolver(variant, slot, resolver)` and/or faction ability resolver.
3. Write and deploy its AI contract, built around **that faction's** abilities, then `setVariantAI(variant, ai)`.
4. Only then place AI ships of that variant (an unregistered variant reverts on its first AI turn).

### Retune or change a faction's tactics
Each faction's tactics are its own contract: kiting rules, which slot heals (`Variant1AI.HEAL_SPECIAL`), when Flak/Storm are safe to use, and so on. Change the contract (or write a new one) and re-register it with `setVariantAI`; nothing else is affected. Shared primitives live in `AIBehavior`, so a change there affects every faction — prefer editing the faction's own contract.

## Contract wiring (deploy module)

`ignition/modules/DeployAndConfig.ts` deploys `AIBehaviorRegistry`, `Variant1AI(shipAttributes, ramResolver)` and `Variant2AI(repairResolver, shipAttributes)`, registers them (`SetVariant1AI`, `SetVariant2AI`), passes the registry to `RoguelikeMatch`'s constructor, and sets it on `SinglePlayerMatch` (`setAIRegistryAddress`). Ownership of the registry and both AIs moves to `MAP_EDITOR` in the real-deploy-only ownership step.

## ABI changes for the FE / other consumers (old → new)

- **Removed contract:** `RoguelikeAIController` (its role is now the per-variant AIs behind the registry).
- `RoguelikeMatch`: `aiController()` → `aiRegistry()`; `setAIControllerAddress` → `setAIRegistryAddress`; the last constructor argument is now the registry address.
- `SinglePlayerMatch`: new `aiRegistry()` and `setAIRegistryAddress(address)`. (Its `shipAttributes` reference is no longer used by AI logic.)
- New: `AIBehaviorRegistry.setVariantAI / aiFor`, event `VariantAISet`, error `NoAIForVariant(uint16)`.
- **Removed from `Game`:** `factionAbilityIsHeal(variant)` and the `isHeal` argument of `setFactionAbilityResolver` — the AI no longer needs a per-faction heal flag because each variant's AI knows its own faction. The setter is now `setFactionAbilityResolver(variant, resolver)`. This removes one storage slot from `Game`, so every later `Game` state variable (`specialResolvers`, `healCapPercent`, `games`) moves down one slot; `test/helpers/gameStorage.ts` is updated (`games` is now slot 9). `IHealFactionAbility` is still used, by `Variant2AI`.
- **Removed from `SinglePlayerMatch`:** the unused `shipAttributes` reference — its constructor no longer takes it and `setShipAttributesAddress` is gone.

## Variant 2's specials moved to slots 1–3 (same change)

Variant 2's equipped specials are now its slots **1–3** (Electric Storm, Drone Swarm, Additional Thruster), previously slots 4–6. Slots 4–7 are unused for both factions. This touched the deploy module (attributes/costs tables, resolver slot arguments, resolver registrations, display names), `RenderSpecialV2` + `scripts/renderer-pipeline` manifest/README, and tests. The sub-renderer leaf contracts were renamed `RenderSpecial4V2/5V2/6V2` → `RenderSpecial1V2/2V2/3V2` to match (files, manifest and deploy module; the ones already verified on base-sepolia are superseded on redeploy). FE: anything keyed on "variant 2 special = enum 4/5/6" must now use 1/2/3, always keyed by `(variant, slot)`.

## Costs / things to know
- `SinglePlayerMatch` AI turns now make an external call into the variant AI (`RoguelikeMatch` already did through the old controller), so per-turn gas is somewhat higher; the AI logic no longer inlines into `SinglePlayerMatch`, which shrank from ~19.6 KB to ~15.3 KB.
- Variant AIs are stateless apart from config addresses, all owner-settable: `Variant1AI.shipAttributes` / `ramAbility`, `Variant2AI.healAbility` / `shipAttributes`. Constructors changed with the trees pass: `Variant1AI(shipAttributes, ramAbility)`, `Variant2AI(healAbility, shipAttributes)`.
- A new interface, `IRamAbility` (`range()`), lets `Variant1AI` read Ram's range from `RamResolver`.
- **Gas / size:** each variant AI is ~12.4 KB (limit 24.6 KB). See the gas report for `takeAITurn`; the trees add a few loops over the ships on the board but no search.
