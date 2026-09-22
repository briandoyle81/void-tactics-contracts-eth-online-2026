// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

// Variant 1's innate Ram ability (RamResolver). Lets Variant1AI read how close
// a ship must be to ram straight from the resolver that enforces it.
// RamResolver already satisfies this via its public `range` state variable's
// auto-generated getter.
interface IRamAbility {
    function range() external view returns (uint8);
}
