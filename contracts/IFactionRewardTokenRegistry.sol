// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

// Minimal interface DestroyRewardLib calls into — keeps it ignorant of
// *which* variants have a reward token or what that token is. All of that
// lives in FactionRewardTokenRegistry.sol, which can be reconfigured (or
// have new variants registered) without redeploying ShipsRouter or
// DestroyRewardLib.
interface IFactionRewardTokenRegistry {
    function rewardToken(uint16 _variant) external view returns (address);
}
