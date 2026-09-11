// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

// Same shape as IRandomManager.sol: a consuming contract (FreeShipClaim.sol)
// doesn't know or care HOW eligibility is established — only that this
// interface can answer whether a player currently qualifies. Lets the real
// implementation (e.g. Selfie Check verification, relayed by a trusted
// backend since Selfie Check has no on-chain proof path — see
// SelfieCheckEligibilityProvider.sol) be swapped in later via a config
// setter, with zero changes to the consuming contract.
interface IEligibilityProvider {
    function isEligible(address _player) external view returns (bool);
}
