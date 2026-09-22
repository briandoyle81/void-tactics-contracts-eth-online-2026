// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "../Types.sol";

// Fixed-value stand-in for the IShipAttributes special getters the effect
// resolvers actually call — deliberately doesn't implement the rest of
// IShipAttributes, since Solidity doesn't require full interface compliance
// at the call site, only at the address cast. The version-pinned getters
// (what resolvers use in-game) ignore the version; tests that care about
// which version is read use the real ShipAttributes instead (see
// test/SpecialVersionPinning.test.ts).
contract MockShipAttributesSpecial {
    uint8 public range;
    uint8 public strength;

    constructor(uint8 _range, uint8 _strength) {
        range = _range;
        strength = _strength;
    }

    function getSpecialRange(
        Special /* _special */,
        uint16 /* _variant */
    ) external view returns (uint8) {
        return range;
    }

    function getSpecialStrength(
        Special /* _special */,
        uint16 /* _variant */
    ) external view returns (uint8) {
        return strength;
    }

    function getSpecialRangeAt(
        uint16 /* _variant */,
        uint16 /* _version */,
        Special /* _special */
    ) external view returns (uint8) {
        return range;
    }

    function getSpecialStrengthAt(
        uint16 /* _variant */,
        uint16 /* _version */,
        Special /* _special */
    ) external view returns (uint8) {
        return strength;
    }
}
