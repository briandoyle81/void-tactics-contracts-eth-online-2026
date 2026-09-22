# Ship Costs & Attributes Runbook

**Written: 2026-09-20.** Describes `contracts/ShipAttributes.sol` after the per-variant attributes redesign (supersedes the earlier version of this file, which described the old global-version model). Re-verify against the contract if it has changed since.

All admin calls below are `onlyOwner` on `ShipAttributes`. On a real deploy, ownership is transferred to `MAP_EDITOR` (see the ownership-transfer step in `ignition/modules/DeployAndConfig.ts`), so these must be sent from that account.

---

## 1. The mental model

**Every variant (faction) has its own versioned tables. One call publishes a complete new version and makes it live. Games pin the version they started with.** Costs and attributes now work the same way:

| | **Costs** | **Attributes** |
|---|---|---|
| Version scope | per variant | per variant |
| Publish call | `setCosts(variant, costs)` | `setVariantAttributes(params)` |
| Version number | contract picks `previous + 1` (caller's `version` is ignored) | contract picks `latest + 1` (there is no `version` field any more) |
| Goes live | immediately | immediately |
| Old versions | overwritten (no history) | **kept, immutable, readable** |
| Rollback | none (see §7) | `setCurrentAttributesVersion(variant, version)` |
| Stored on ships? | **Yes** — `ship.shipData.costsVersion` + `cost` | No — but each **game** pins it (below) |
| Enforced by | `Fleets.createFleet` reverts `ShipCostVersionMismatch` on a stale ship | `Game` snapshots the version per ship at game start |
| Unconfigured variant | `InvalidCostsVersion` | `VariantNotConfigured(variant)` |

What "attributes" covers (all in one published table per variant): base hull/speed, tier bonuses (`foreAccuracy`, `hull`, `engineSpeeds`), `guns`, `armors`, `shields`, `specials`, and the **rank rules** (`rankThresholds`, `rankBonusPct`).

### Why immutability matters: games pin a version

`Game.calculateShipAttributes` runs once per ship at game start and stores the result, including `attributes.version` = that variant's live attributes version at that moment. Because a published version **never changes**, anything read *at that version* is frozen for the game:

- Combat stats: already copied into the game's storage at start.
- **Special-effect numbers** (range/strength): the special resolvers (`EMPResolver`, `RepairDronesResolver`, `FlakArrayResolver`, `ElectricStormResolver`, `DroneSwarmResolver`) and `Variant1AI`'s heal-range check read `getSpecialRangeAt` / `getSpecialStrengthAt` using the **acting ship's** pinned version — so publishing or rolling back mid-game cannot change an in-flight game. New games pick up whatever is live when their ships are calculated.

The plain `getSpecialRange/getSpecialStrength/get*Data(enum, variant)` getters read the **live** version. They exist for display/tooling; in-game logic must not use them.

---

## 2. Who reads what

- `Ships._setCostOfShip` (via `setCostOfShip`, `syncShipCosts`): stamps `costsVersion = getCurrentCostsVersion(variant)` and `cost = calculateShipCost(ship)`.
- `AIShips` allocation: recomputes both live every allocation.
- `Fleets.createFleet`: per ship requires `ship.shipData.costsVersion == getCurrentCostsVersion(variant)`; sums the **stored** `ship.shipData.cost`; rejects mixed-variant fleets.
- `Game.calculateShipAttributes(gameId, shipId)`: `ShipAttributes.calculateShipAttributesById` → reads the variant's live table, applies rank bonus, and floors the final `range` and `movement` at 1 (so a ship can always move a tile and shoot an adjacent target, even if gear penalties sum to ≤ 0 or the equipped gun has range 0); movement from armor/shields counts only for an *equipped* piece, and the "None" bonus (armor table's index 0) applies once, to a ship carrying neither — the shields table's None movement is never read; result (incl. `version`) stored per game. Snapshot-once (a non-zero version blocks recalculation, `InvalidMove`).
- Special resolvers / `Variant1AI` (see `docs/ai-behavior-registry.md`): read pinned data as above.

---

## 3. Array shapes (validated on publish)

Publishing reverts `InvalidArrayLength()` if any length is wrong, so a bad table can never go live. Weapon/armor/shield/special tables are indexed by **enum value** and `GenerateNewShip` only rolls some of them, but `customizeShip`/DroneYard/prize ships can equip any enum value — so **all 8 slots must exist**.

| Field | Required length |
|---|---|
| `foreAccuracy`, `hull`, `engineSpeeds` (attributes) | 3 (tier 0–2) |
| `guns`, `armors`, `shields`, `specials` | 8 (one per enum value; slots 4–7 are `future*`) |
| `rankThresholds` | 5 |
| `rankBonusPct` | 6 |
| Costs `accuracy`, `hull`, `speed` | 3 |
| Costs `mainWeapon`, `armor`, `shields`, `special` | 8 |

**Filler for `future*` slots (4–7):** use inert entries — zero-stat gear; for costs, the cheapest real entry — so a future slot is never free-and-strong. See the variant blocks in `DeployAndConfig.ts` for the reference values.

**Rank rules** (`InvalidRankConfig()` if violated): `rankThresholds` = kills needed for ranks 2..6, strictly ascending, first > 0. `rankBonusPct` = bonus % for ranks 1..6 (index = rank − 1), each ≤ 100. Rank = `1 + #(thresholds ≤ shipsDestroyed)`. Today's values: thresholds `[10, 30, 100, 300, 1000]`, bonuses `[0, 10, 20, 30, 40, 50]`.

---

## 4. Runbooks

### A. Change costs for one variant

1. Build the full `Costs` struct (§3 lengths). Every array is a full table, not a delta.
2. `setCosts(variant, costs)` → version becomes `previous + 1`; `CostsSet(variant, newVersion)`.
3. **Consequence:** every existing ship of *that variant* is now stale and cannot enter a fleet (`ShipCostVersionMismatch`). Other variants are untouched.
4. Refresh ships with `Ships.syncShipCosts(ids[])` (permissionless). The **whole batch reverts `ShipInFleet`** if any id is in a fleet — filter those out and sync them after they leave.
5. Verify `getCurrentCostsVersion(variant)` == a synced ship's `shipData.costsVersion`.

Note `calculateShipCost` now sums in `uint16`, so a ship totalling more than 255 prices correctly (it used to revert).

### B. Rebalance attributes (the normal path — also how to add a new version)

1. Read the current table: `getVariantAttributes(variant, 0)` (0 = current). Edit it client-side.
2. `setVariantAttributes({ variant, baseHull, baseSpeed, foreAccuracy, hull, engineSpeeds, guns, armors, shields, specials, rankThresholds, rankBonusPct })` — a **complete** table.
3. The contract writes it as version `latest + 1` and makes it live in the same call. `VariantAttributesPublished(variant, version)` is emitted. There is no half-configured state and no downtime; other variants are untouched.
4. **Effect:** games already started keep their pinned version (stats *and* specials). Games that haven't calculated their ships yet, and all future games, use the new one.
5. **Costs are not touched.** If the rebalance should change prices, do runbook A separately.

### C. Roll back (or forward) a variant's attributes

1. `setCurrentAttributesVersion(variant, version)` with `1 ≤ version ≤ getLatestAttributesVersion(variant)`. Anything else reverts `InvalidAttributesVersion()`.
2. Only changes what **new** calculations use. In-flight games are unaffected (they pinned their own version). `latest` does not move, and no version is deleted.
3. Rollback does not touch cost versions.

### D. Change rank tiers or bonuses

Ranks live in the attributes table, so this is just runbook B with different `rankThresholds` / `rankBonusPct`. Nothing else to change on-chain. See gotchas below for two places that assume today's thresholds.

### E. Add a brand-new variant

Both halves are required, independently, and neither is seeded:

1. `setCosts(newVariant, …)` — until it runs, `calculateShipCost` reverts `InvalidCostsVersion` for that variant.
2. `setVariantAttributes({ variant: newVariant, … })` — until it runs, attribute lookups revert `VariantNotConfigured(newVariant)`.
3. Publish `ShipAttributes` for a variant **before** raising `Ships.maxVariant` to admit it.
4. Register the faction's AI: an AI ship of a variant with no AI in `AIBehaviorRegistry` reverts `NoAIForVariant` on its first turn — see `docs/ai-behavior-registry.md`.
5. This covers `ShipAttributes` and the AI registry only. Other per-variant wiring (purchase gates, renderers, special/faction-ability resolvers, reward tokens) is out of scope here.

### F. Detecting "not configured" from the FE

- Costs: `getCosts(variant)[0] == 0`, or `getCurrentCostsVersion(variant) == 0`.
- Attributes: `getCurrentAttributesVersion(variant) == 0`, or catch the `VariantNotConfigured` revert.

---

## 5. FE handoff: ABI changes (old → new)

Contract to re-point: `ShipAttributes` was **redeployed** (new address); the five special resolvers were also redeployed; `Ships`/`Game`/`Fleets` logic is unchanged apart from a comment, but are re-pointed to the new `ShipAttributes`.

**Removed**
- `startNewAttributesVersion()`
- `getAttributesVersionBase(version, variant)` → use `getVariantAttributes(variant, version)`
- `getCurrentAttributesVersion()` (no-arg) and the public `currentAttributesVersion` / `attributesVersions` getters
- `getRank(shipsDestroyed) pure`
- Event `AttributesVersionCreated`; event `VariantAttributesSet`

**Changed**
- `setCurrentAttributesVersion(version)` → `setCurrentAttributesVersion(variant, version)`
- `setVariantAttributes(params)`: `params.version` **removed**; `params.rankThresholds` (`uint32[]`) and `params.rankBonusPct` (`uint8[]`) **added**; all equipment tables must be length 8 and tier tables length 3
- `getCurrentAttributesVersion()` → `getCurrentAttributesVersion(variant)`
- `getRank(shipsDestroyed)` → `getRank(variant, shipsDestroyed)` (view)
- Event `CurrentAttributesVersionSet(version)` → `CurrentAttributesVersionSet(variant, version)`
- `setCosts`: unchanged signature, but array lengths are now validated (§3)

**Added**
- `getLatestAttributesVersion(variant)`
- `getVariantAttributes(variant, version)` — full table incl. `foreAccuracy`, `hull`, `engineSpeeds`, rank rules (`version = 0` ⇒ current). This is what makes "copy another variant's values as a starting point" possible client-side.
- `getSpecialRangeAt(variant, version, special)`, `getSpecialStrengthAt(variant, version, special)`
- Event `VariantAttributesPublished(variant, version)`
- Errors: `VariantNotConfigured(uint16)`, `InvalidArrayLength()`, `InvalidRankConfig()`

**UI implications**
- "Attributes Version" is now **per variant**, like "Costs Version" — both follow the variant picker.
- "Start new version" no longer exists. The panel's write action is **publish**: load the variant's current table, edit, submit. Each submit is a new version, live immediately, with the old one still readable and restorable via rollback.
- A variant with no published table shows the `VariantNotConfigured` state; seeding it = publishing a table (optionally pre-filled from another variant via `getVariantAttributes`).

---

## 6. Gotchas

- **Bonus overflow.** Stat math uses checked `uint8`; a rank bonus that pushes a stat past 255 makes that ship's attribute calculation revert (owner misconfiguration, fails loud). The contract caps bonus at 100% but can't dry-run every stat.
- **Rank thresholds are assumed in two places** (not changed): `GenerateNewShip` seeds prize-ship kill counts in ranges aligned to the *old* thresholds (1–9 / 10–29 / 30–99 / 100–299), and `TutorialClaim` sets `shipsDestroyed = 10` expecting rank 2. Retuning thresholds shifts which rank those ships land on.
- **Each publish is a full write.** There are no partial edits; send complete arrays.
- **Published versions can't be fixed in place.** To correct one, publish again (or roll back to a good one).
- **Cost table entries are `uint8` (≤ 255 each).** A ship's total can now exceed 255 (it's summed and stored as `uint16`), but each individual table entry can't.
- **A special's slot number only means something within its variant.** Behavior and strength are looked up by variant first, then slot (`Game.specialResolvers[variant][slot]`, `specials[slot]` in the variant's own table), so variant 1's slot 1 and variant 2's slot 1 are unrelated. Variant 2's specials are its slots 1–3; slots 4–7 are unused for both factions. AI follows the same rule: each variant has its own AI contract (which is where "variant 1's healer is slot 2" now lives) — see `docs/ai-behavior-registry.md`.

## 7. Deliberately not built

- **Cost rollback / cost history.** Ships stamp `costsVersion`; rewinding a variant's cost counter would make "stale vs. valid" ambiguous. Costs stay overwrite-with-bump.
- **Merging costs into the attributes table.** It would bump a variant's cost version (staling every ship of that variant until `syncShipCosts`) on every attribute tweak.
- **On-chain "copy variant".** Not needed now that `getVariantAttributes` exposes the full table.
