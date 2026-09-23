// Per-slot archetype/symmetry/difficulty assignment for every map this pass
// touches: the 30 existing campaign slots (m01-m15, d01-d06, s01-s03,
// f01-f06), the 5 roguelike-only slots (now genuinely distinct content per
// Confirmed Decision #2, not clones of m01/m02/m03/d01/s01), and a new
// small PvP set (Confirmed Decision #3 — none exist today).
//
// THIS IS A FIRST DRAFT FOR HUMAN REVIEW, not a final answer — Phase 7's
// review checkpoint (export every generated map through the dense-grid
// format and look at it in the real Map Editor tool) is where the actual
// numbers below get tuned, not here. What matters at this stage is the
// STRUCTURE: a monotonic difficulty ramp along the main spine, branches at
// a sensible relative difficulty, every archetype actually used somewhere,
// and Open Void reserved for its two narratively-appropriate slots (a
// gentle open opener, and a deliberate late sniper-duel callback) rather
// than picked at random.
//
// Difficulty is expressed structurally (lane count, cluster size, density,
// hard-cover ratio, objective value — Phase 0 §8), not by raw tile count,
// but still trends in the same direction the old count-based scaling did
// (old m01: 4 blocked tiles -> old f06: 65) and preserves the existing
// monotonic ordering: m01 (easiest) ... m15 (hardest on the main spine);
// d/s branches at a difficulty appropriate to their branch point; f01-f06
// (post-spine finale) hardest overall.

import {
  ArchetypeName,
  BalanceIntent,
  DifficultyParams,
  SymmetryMode,
  ZoneShape,
} from "./archetypes";
import { ScoringParams } from "./scoring";
import { FormationName } from "./formations";

export interface SlotSpec {
  key: string;
  name: string;
  mode: "PvE" | "PvP";
  archetype: ArchetypeName;
  symmetryMode: SymmetryMode;
  balanceIntent: BalanceIntent;
  params: DifficultyParams;
  scoring: ScoringParams;
  formation: FormationName;
  zoneShape: ZoneShape;
}

// Formation flavor derived from archetype, not assigned per slot by hand:
// dense/tanky shapes (Reactor Core, Debris Ring) push an aggressive wedge
// through their own gaps; wall/pillar shapes (Trench Run, Twin Pillars) and
// the wide-open Void hold a picket line (dug in, or just spread thin so a
// kite can't collect the whole roster in one shot); Asteroid Field's
// scattered clusters suit a weaving echelon. PvP maps always use picket —
// no formation-driven edge on a symmetric contest.
type SlotSpecDraft = Omit<SlotSpec, "formation" | "zoneShape">;

function formationForArchetype(archetype: ArchetypeName): FormationName {
  switch (archetype) {
    case "reactorCore":
    case "debrisRing":
      return "wedge";
    case "trenchRun":
    case "twinPillars":
    case "openVoid":
      return "picket";
    case "asteroidField":
      return "echelon";
  }
}

// Custom deployment-zone shapes (2026-09-23 pass, docs/internal-todos.md's
// "horizontal or vertical deployment... diagonals" item): assigned by
// archetype-fit, not per slot, covering roughly half the map set.
//   - Trench Run (parallel walls) -> horizontal: ships form up along one
//     edge, matching a trench line, instead of spread down the whole side.
//   - Twin Pillars / Asteroid Field -> diagonal: a flanking approach angle
//     fits both a pillar-flanking maneuver and weaving through scattered
//     rubble.
//   - Debris Ring / Reactor Core / Open Void -> vertical (the engine
//     default, unchanged): these are radially-shaped or wide open, where
//     "approach from the side toward a central threat" already reads
//     correctly with no need to reshape the zone.
function zoneShapeForArchetype(archetype: ArchetypeName): ZoneShape {
  switch (archetype) {
    case "trenchRun":
      return "horizontal";
    case "twinPillars":
    case "asteroidField":
      return "diagonal";
    case "debrisRing":
    case "reactorCore":
    case "openVoid":
      return "vertical";
  }
}

// Linear interpolation, clamped to [0,1] by the caller's t.
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Turns a 0 (easiest) .. 1 (hardest) difficulty fraction into concrete
// generator params. Shared by every PvE slot so the ramp is consistent
// across branches — only the archetype/symmetry/balance choice differs
// per slot below.
function paramsForDifficulty(t: number): DifficultyParams {
  return {
    laneCount: t < 0.6 ? 4 : 3,
    clusterSizeMax: Math.round(lerp(1, 4, t)),
    density: lerp(0.15, 0.55, t),
    hardCoverRatio: lerp(0.1, 0.6, t),
  };
}

function scoringForDifficulty(t: number, pattern: "uniform" | "tiered"): ScoringParams {
  return {
    pattern,
    objectivePoints: Math.round(lerp(5, 20, t)),
    holdPoints: Math.round(lerp(3, 10, t)),
    holdCount: t < 0.3 ? 1 : 2,
  };
}

// Archetype cycle for the main spine — deliberately varied, not random, so
// consecutive missions never repeat a shape. Open Void appears once early
// (m01, the gentle opener) and once late (m12, a callback "sniper's
// corridor" beat) — everywhere else favors structured cover archetypes.
const MAIN_SPINE_ARCHETYPES: ArchetypeName[] = [
  "openVoid", // m01
  "asteroidField", // m02
  "twinPillars", // m03
  "asteroidField", // m04
  "trenchRun", // m05
  "debrisRing", // m06
  "twinPillars", // m07
  "asteroidField", // m08
  "trenchRun", // m09
  "debrisRing", // m10
  "reactorCore", // m11
  "openVoid", // m12 — late callback, sniper-duel beat
  "trenchRun", // m13
  "debrisRing", // m14
  "reactorCore", // m15 — main-spine finale
];

const MAIN_SPINE_SYMMETRY: SymmetryMode[] = MAIN_SPINE_ARCHETYPES.map(
  (_, i) => (i % 2 === 0 ? "radial" : "vertical"),
);

function buildMainSpine(): SlotSpecDraft[] {
  return MAIN_SPINE_ARCHETYPES.map((archetype, i) => {
    const n = i + 1;
    const t = i / (MAIN_SPINE_ARCHETYPES.length - 1); // 0..1 over m01..m15
    const key = `m${String(n).padStart(2, "0")}`;
    return {
      key,
      name: `${archetypeLabel(archetype)} — Sector ${n}`,
      mode: "PvE",
      archetype,
      symmetryMode: MAIN_SPINE_SYMMETRY[i],
      balanceIntent: "fair",
      params: paramsForDifficulty(t),
      scoring: scoringForDifficulty(t, t < 0.5 ? "uniform" : "tiered"),
    };
  });
}

// Dead-end branch (optional content, d01-d06): pegged to roughly the
// difficulty of the main-spine mission near its branch point, with a small
// bump (optional content should feel a little meatier than required
// content at the same point in the run) and always symmetric/fair — no
// deliberate imbalance on side content.
function buildDeadEnds(): SlotSpecDraft[] {
  const archetypes: ArchetypeName[] = [
    "twinPillars",
    "debrisRing",
    "asteroidField",
    "trenchRun",
    "reactorCore",
    "debrisRing",
  ];
  return archetypes.map((archetype, i) => {
    const n = i + 1;
    const nearSpineMission = 2 + i * 2; // d01~m03ish .. d06~m13ish
    const t = Math.min(1, nearSpineMission / 15 + 0.08); // small bump
    const key = `d${String(n).padStart(2, "0")}`;
    return {
      key,
      name: `${archetypeLabel(archetype)} — Dead End ${n}`,
      mode: "PvE",
      archetype,
      symmetryMode: (i % 2 === 0 ? "vertical" : "radial") as SymmetryMode,
      balanceIntent: "fair",
      params: paramsForDifficulty(t),
      scoring: scoringForDifficulty(t, "tiered"),
    };
  });
}

// Shortcut branch (s01-s03): risk/reward — deliberately harder than a
// normal mission at the same run-position, matching the existing design
// note that s01 already ships a harder-than-normal roster. Uses "none"
// symmetry + favorDefender for at least one of them, since a shortcut
// letting the AI dig in is exactly the kind of scenario Phase 0 §2's
// imbalance option exists for.
function buildShortcuts(): SlotSpecDraft[] {
  const specs: {
    archetype: ArchetypeName;
    tBoost: number;
    imbalance: boolean;
  }[] = [
    { archetype: "reactorCore", tBoost: 0.25, imbalance: true },
    { archetype: "debrisRing", tBoost: 0.2, imbalance: false },
    { archetype: "trenchRun", tBoost: 0.2, imbalance: true },
  ];
  return specs.map((spec, i) => {
    const n = i + 1;
    const basePosition = 3 + i * 4; // roughly mission 3, 7, 11 equivalent
    const t = Math.min(1, basePosition / 15 + spec.tBoost);
    const key = `s${String(n).padStart(2, "0")}`;
    return {
      key,
      name: `${archetypeLabel(spec.archetype)} — Shortcut ${n}`,
      mode: "PvE",
      archetype: spec.archetype,
      symmetryMode: (spec.imbalance ? "none" : "radial") as SymmetryMode,
      balanceIntent: (spec.imbalance ? "favorDefender" : "fair") as BalanceIntent,
      params: paramsForDifficulty(t),
      scoring: scoringForDifficulty(t, "tiered"),
    };
  });
}

// Finale branch (f01-f06): hardest content in the campaign, always after
// the full main spine. favorAttacker on the very last map (f06) — the
// player has earned a marginal edge for reaching the finale boss fight.
function buildFinale(): SlotSpecDraft[] {
  const archetypes: ArchetypeName[] = [
    "trenchRun",
    "debrisRing",
    "twinPillars",
    "reactorCore",
    "asteroidField",
    "reactorCore",
  ];
  return archetypes.map((archetype, i) => {
    const n = i + 1;
    const t = Math.min(1, 0.85 + i * 0.03); // hardest tier, still ramping slightly
    const isFinalBoss = n === 6;
    const key = `f${String(n).padStart(2, "0")}`;
    return {
      key,
      name: `${archetypeLabel(archetype)} — Finale ${n}`,
      mode: "PvE",
      archetype,
      symmetryMode: (isFinalBoss ? "none" : "radial") as SymmetryMode,
      balanceIntent: (isFinalBoss ? "favorAttacker" : "fair") as BalanceIntent,
      params: paramsForDifficulty(t),
      scoring: scoringForDifficulty(t, "tiered"),
    };
  });
}

// Roguelike-only slots (rlM01, rlM02, rlM03, rlD01, rlS01): now genuinely
// distinct content (Confirmed Decision #2), not clones — same difficulty
// TIER as the campaign missions they stand in for (missions 1-3 fight
// variant 1, per docs/roguelike-progression.md), but each a different
// archetype/symmetry so they don't feel like the same map with a reskinned
// roster.
function buildRoguelike(): SlotSpecDraft[] {
  const specs: {
    key: string;
    archetype: ArchetypeName;
    symmetryMode: SymmetryMode;
    t: number;
    name: string;
  }[] = [
    { key: "rlM01", archetype: "asteroidField", symmetryMode: "vertical", t: 0.05, name: "Asteroid Field — Roguelike Approach" },
    { key: "rlM02", archetype: "twinPillars", symmetryMode: "radial", t: 0.15, name: "Twin Pillars — Roguelike Corridor" },
    { key: "rlM03", archetype: "debrisRing", symmetryMode: "vertical", t: 0.25, name: "Debris Ring — Roguelike Junction" },
    { key: "rlD01", archetype: "trenchRun", symmetryMode: "radial", t: 0.28, name: "Trench Run — Roguelike Dead End" },
    { key: "rlS01", archetype: "reactorCore", symmetryMode: "none", t: 0.35, name: "Reactor Core — Roguelike Shortcut" },
  ];
  return specs.map((s) => ({
    key: s.key,
    name: s.name,
    mode: "PvE",
    archetype: s.archetype,
    symmetryMode: s.symmetryMode,
    balanceIntent: (s.key === "rlS01" ? "favorDefender" : "fair") as BalanceIntent,
    params: paramsForDifficulty(s.t),
    scoring: scoringForDifficulty(s.t, "uniform"),
  }));
}

// New PvP set (Confirmed Decision #3 — zero PvP maps exist today). Default
// radial + fair, matching the exemplar; one of the five literally IS the
// exemplar, imported via the dense-grid converter rather than generated
// (see generate-map.ts). The others vary the archetype for lobby variety.
function buildPvP(): SlotSpecDraft[] {
  const specs: {
    key: string;
    archetype: ArchetypeName;
    name: string;
    scoring?: ScoringParams; // override the shared mid-difficulty default below
  }[] = [
    { key: "pvp01", archetype: "twinPillars", name: "Twin Pillars — Open Contract" },
    { key: "pvp02", archetype: "debrisRing", name: "Debris Ring — Open Contract" },
    { key: "pvp03", archetype: "trenchRun", name: "Trench Run — Open Contract" },
    // pvp04's terrain isn't generated -- generate-map.ts substitutes the
    // imported exemplar-pvp-map.json for this exact key (EXEMPLAR_KEY).
    // archetype here is unused for it but still needs a valid value.
    { key: "pvp04", archetype: "twinPillars", name: "Exemplar Contract — Open Field" },
    // Single central objective, no flanking holds (holdCount: 0) -- a
    // "winner takes all" contract: whoever controls the one scoring tile
    // controls the whole match. Reactor Core for the theme (the dense
    // central blob IS the reactor everyone is fighting to hold), and a
    // higher objective value than the shared baseline since it's the
    // match's only point source.
    {
      key: "pvp05",
      archetype: "reactorCore",
      name: "Reactor Core — Sole Contract",
      scoring: { pattern: "uniform", objectivePoints: 25, holdPoints: 0, holdCount: 0 },
    },
  ];
  return specs.map((s) => ({
    key: s.key,
    name: s.name,
    mode: "PvP",
    archetype: s.archetype,
    symmetryMode: "radial",
    balanceIntent: "fair",
    params: paramsForDifficulty(0.5), // a mid-difficulty, generally-fair PvP baseline
    scoring: s.scoring ?? scoringForDifficulty(0.5, "uniform"),
  }));
}

// Roguelike-extension slots (2026-09-23 pass): the campaign originally had
// 30 Combat nodes but only 5 dedicated roguelike maps (rlM01-03/rlD01/rlS01,
// above) — the other 25 roguelike nodes (m04-m15, d02-d06, s02-s03, f01-f06)
// pointed straight at the campaign's own map keys, so a player doing both
// modes saw identical terrain for 25 of 30 fights. This gives every
// remaining roguelike Combat node its own dedicated map: same difficulty
// tier/roster/scoring as its campaign counterpart (so the run's pacing is
// unchanged), but a different archetype+symmetry so it doesn't read as
// "the same map with a reskinned roster" (the same design goal the original
// 5 state above) -- on top of the different RNG seed a new key already
// gives every generated map.
//
// A fixed 2-step rotation through the 5 structured-cover archetypes
// (gcd(2,5)=1, so it's a single 5-cycle with no fixed points -- always
// differs from the source) rather than hand-picking 25 substitutions.
// Open Void is deliberately excluded from the cycle and only ever a
// rotation TARGET never a SOURCE's natural destination: trenchRun sources
// this set 6 times (m05/m09/m13/d04/s03/f01) and a naive 6-archetype
// rotation sent every one of them to Open Void, flooding the roguelike
// extension with 6 near-empty maps and breaking the exact "reserved for
// two narratively-appropriate slots" rule buildMainSpine's own comment
// states above. The one Open Void source here (m12, the campaign's late
// callback) instead becomes Asteroid Field.
const STRUCTURED_CYCLE: ArchetypeName[] = [
  "asteroidField",
  "twinPillars",
  "trenchRun",
  "debrisRing",
  "reactorCore",
];
function rotateArchetype(a: ArchetypeName): ArchetypeName {
  if (a === "openVoid") return "asteroidField";
  const idx = STRUCTURED_CYCLE.indexOf(a);
  return STRUCTURED_CYCLE[(idx + 2) % STRUCTURED_CYCLE.length];
}

// radial/vertical are the two "fair" symmetry modes used across the
// campaign's PvE slots -- swapping between them (leaving "none"/imbalanced
// slots alone, since that's a deliberate narrative marker, not a cosmetic
// choice) gives the rotated map a different mirror axis too.
function rotateSymmetry(s: SymmetryMode): SymmetryMode {
  if (s === "radial") return "vertical";
  if (s === "vertical") return "radial";
  return s;
}

// The 5 campaign keys that already have hand-tuned dedicated roguelike
// content (buildRoguelike(), above) -- skipped here so this pass doesn't
// double up on them.
const ROGUELIKE_ALREADY_DEDICATED = new Set(["m01", "m02", "m03", "d01", "s01"]);

function rlKey(campaignKey: string): string {
  return "rl" + campaignKey[0].toUpperCase() + campaignKey.slice(1);
}

function rlName(archetype: ArchetypeName, campaignKey: string): string {
  const label = archetypeLabel(archetype);
  const n = parseInt(campaignKey.slice(1), 10);
  if (campaignKey.startsWith("m")) return `${label} — Roguelike Sector ${n}`;
  if (campaignKey.startsWith("d")) return `${label} — Roguelike Dead End ${n}`;
  if (campaignKey.startsWith("s")) return `${label} — Roguelike Shortcut ${n}`;
  return `${label} — Roguelike Finale ${n}`;
}

// campaignPvE is the already-built m01-15/d01-06/s01-03/f01-06 draft list --
// reused rather than rebuilt so difficulty params/scoring/roster-tier stay
// byte-for-byte identical to the campaign slot each of these stands in for.
function buildRoguelikeExtension(campaignPvE: SlotSpecDraft[]): SlotSpecDraft[] {
  return campaignPvE
    .filter((d) => !ROGUELIKE_ALREADY_DEDICATED.has(d.key))
    .map((d) => {
      const archetype = rotateArchetype(d.archetype);
      return {
        ...d,
        key: rlKey(d.key),
        name: rlName(archetype, d.key),
        archetype,
        symmetryMode: rotateSymmetry(d.symmetryMode),
      };
    });
}

function archetypeLabel(a: ArchetypeName): string {
  switch (a) {
    case "asteroidField":
      return "Asteroid Field";
    case "debrisRing":
      return "Debris Ring";
    case "trenchRun":
      return "Trench Run";
    case "twinPillars":
      return "Twin Pillars";
    case "reactorCore":
      return "Reactor Core";
    case "openVoid":
      return "Open Void";
  }
}

export function buildDifficultyTable(): SlotSpec[] {
  const campaignPvE: SlotSpecDraft[] = [
    ...buildMainSpine(),
    ...buildDeadEnds(),
    ...buildShortcuts(),
    ...buildFinale(),
  ];
  const drafts: SlotSpecDraft[] = [
    ...campaignPvE,
    ...buildRoguelike(),
    ...buildRoguelikeExtension(campaignPvE),
    ...buildPvP(),
  ];
  return drafts.map((draft) => ({
    ...draft,
    formation: draft.mode === "PvP" ? "picket" : formationForArchetype(draft.archetype),
    zoneShape: zoneShapeForArchetype(draft.archetype),
  }));
}
