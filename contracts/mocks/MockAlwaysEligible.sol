// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "../IEligibilityProvider.sol";

// Local/test stand-in for the real SelfieCheckEligibilityProvider, wired in
// non-production deploys the same way MockOnchainRandomShipNames stands in
// for the real ship-names contract — keeps FreeShipClaim.claimFreeShips's
// eligibilityProvider-wired code path exercised by the shared test fixture
// without depending on the real Selfie Check backend-relay infrastructure.
contract MockAlwaysEligible is IEligibilityProvider {
    function isEligible(address) external pure returns (bool) {
        return true;
    }
}
