// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./Types.sol";
import "./AIBehavior.sol";

// One faction's (traits.variant's) AI turn-decision logic. Each variant has
// its own implementation, built around what that faction actually has —
// e.g. Variant1AI knows healing is an equipped special, Variant2AI knows
// every ship has a repair action but no ram. AIBehaviorRegistry maps
// variant -> implementation, so callers (SinglePlayerMatch, RoguelikeMatch)
// never branch on faction and a faction's AI can be swapped or upgraded by
// re-pointing the registry.
//
// Implementations are read-only: they only ever return a decision, and the
// caller decides how (and whether) to act on it.
interface IVariantAI {
    function decide(
        AIBehavior.Ctx memory ctx,
        Archetype archetype,
        Special special
    ) external view returns (AIBehavior.Decision memory);
}
