// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";

// Generic "which token does destroying an AI ship of variant X pay out"
// registry. Deployed standalone and called from DestroyRewardLib (via
// ShipsRouter) so that ShipsRouter never needs to grow new code or be
// redeployed when a future AI faction gets its own reward token: it just
// stays ignorant of which variants have a token or what that token is, and
// owner-configuration below is what actually wires one up, at any time
// (including long after initial deploy).
//
// rewardToken[variant] == address(0) means that variant has no reward token
// registered yet — DestroyRewardLib treats this as "pay nothing", not as an
// error, since a new AI faction can exist in-game before its token does.
contract FactionRewardTokenRegistry is Ownable {
    mapping(uint16 => address) public rewardToken;

    constructor() Ownable(msg.sender) {}

    function setRewardToken(uint16 _variant, address _token) external onlyOwner {
        rewardToken[_variant] = _token;
    }
}
