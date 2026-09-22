// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./IVariantAI.sol";

// Central lookup from a faction (traits.variant) to the contract holding
// that faction's AI decision logic (see IVariantAI). SinglePlayerMatch and
// RoguelikeMatch call aiFor(variant) and then call the returned contract's
// decide(...) directly — this is a lookup rather than a forwarding proxy on
// purpose: the decision context (the whole game view) is large, and
// forwarding through here would ABI-encode it twice.
//
// Upgrading a faction's AI = deploy the new implementation and
// setVariantAI(variant, newAddress). Nothing else needs redeploying.
//
// A variant with no registered AI fails loud (NoAIForVariant) rather than
// silently falling back to some generic behavior — same stance as
// ShipAttributes' unconfigured-variant reads. Register a variant's AI
// before placing AI ships of that variant.
contract AIBehaviorRegistry is Ownable {
    mapping(uint16 => IVariantAI) private _variantAI;

    error NoAIForVariant(uint16 variant);

    event VariantAISet(uint16 indexed variant, address ai);

    constructor() Ownable(msg.sender) {}

    // Setting address(0) unregisters the variant (lookups then revert).
    function setVariantAI(uint16 _variant, address _ai) external onlyOwner {
        _variantAI[_variant] = IVariantAI(_ai);
        emit VariantAISet(_variant, _ai);
    }

    function aiFor(uint16 _variant) external view returns (IVariantAI ai) {
        ai = _variantAI[_variant];
        if (address(ai) == address(0)) revert NoAIForVariant(_variant);
    }
}
