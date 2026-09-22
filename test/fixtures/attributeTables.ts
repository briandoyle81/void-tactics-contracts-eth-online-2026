/**
 * Helpers for building ShipAttributes.setVariantAttributes / setCosts
 * arguments in tests.
 *
 * ShipAttributes validates array lengths on publish (InvalidArrayLength):
 * weapon/armor/shield/special tables are indexed by enum value and must have
 * all 8 slots (slots 4-7 are the `future*` enum values), and rank rules must
 * be supplied. Most tests only care about a few entries, so they write the
 * short (4-entry) tables they always have and wrap them here, which pads the
 * rest with the same inert `future*` filler the deploy module uses and fills
 * in today's rank rules. Tests that exercise validation itself pass raw,
 * unwrapped arguments instead.
 */

export const EQUIPMENT_SLOTS = 8;

// Today's production rank rules (see DeployAndConfig.ts): kills for ranks
// 2..6 and the stat bonus % for ranks 1..6.
export const DEFAULT_RANK_THRESHOLDS = [10, 30, 100, 300, 1000];
export const DEFAULT_RANK_BONUS_PCT = [0, 10, 20, 30, 40, 50];

const INERT_GUN = { range: 0, damage: 0, movement: 0 };
const INERT_DEFENSE = { damageReduction: 0, movement: 0 };
const INERT_SPECIAL = { range: 0, strength: 0, movement: 0 };

function padTo<T>(items: T[], filler: T, length = EQUIPMENT_SLOTS): T[] {
  return [
    ...items,
    ...Array.from({ length: Math.max(0, length - items.length) }, () => filler),
  ];
}

/**
 * Normalizes a (possibly short-form) setVariantAttributes argument into one
 * the contract accepts: drops any legacy `version` field (the contract picks
 * the version itself now), pads guns/armors/shields/specials to 8 slots, and
 * supplies default rank rules unless overridden.
 */
export function attributeParams(params: {
  variant: number;
  baseHull: number;
  baseSpeed: number;
  foreAccuracy: number[];
  hull: number[];
  engineSpeeds: number[];
  guns: { range: number; damage: number; movement: number }[];
  armors: { damageReduction: number; movement: number }[];
  shields: { damageReduction: number; movement: number }[];
  specials: { range: number; strength: number; movement: number }[];
  rankThresholds?: number[];
  rankBonusPct?: number[];
  [extra: string]: unknown;
}) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { version: _legacyVersion, ...rest } = params as any;
  return {
    ...rest,
    guns: padTo(params.guns, INERT_GUN),
    armors: padTo(params.armors, INERT_DEFENSE),
    shields: padTo(params.shields, INERT_DEFENSE),
    specials: padTo(params.specials, INERT_SPECIAL),
    rankThresholds: params.rankThresholds ?? DEFAULT_RANK_THRESHOLDS,
    rankBonusPct: params.rankBonusPct ?? DEFAULT_RANK_BONUS_PCT,
  };
}

/**
 * Normalizes a (possibly short-form) setCosts argument: pads the
 * enum-indexed cost tables to 8 slots with 0 (the `future*` slots are
 * unreachable via generation, so their price doesn't matter to tests).
 */
export function costsParams<
  T extends {
    mainWeapon: number[];
    armor: number[];
    shields: number[];
    special: number[];
  },
>(costs: T): T {
  return {
    ...costs,
    mainWeapon: padTo(costs.mainWeapon, 0),
    armor: padTo(costs.armor, 0),
    shields: padTo(costs.shields, 0),
    special: padTo(costs.special, 0),
  };
}
