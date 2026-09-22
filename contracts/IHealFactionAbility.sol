// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

// Implemented by a faction ability resolver whose effect is a heal (e.g.
// RepairResolver, variant 2's innate ability). Lets a faction's AI
// (Variant2AI) read the ability's heal range straight from the resolver that
// enforces it. RepairResolver already satisfies this via its public `range`
// state variable's auto-generated getter -- no resolver changes needed to
// conform, this just formalizes the shape callers rely on.
interface IHealFactionAbility {
    function range() external view returns (uint8);
}
