// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./IUniversalCredits.sol";
import "./IFactionRewardTokenRegistry.sol";
import "./ILobbiesOrchestratorCheck.sol";

// Shared by every AI faction's reward token (DroneEnergyCores today, any
// future faction token later) — they all already implement this same
// authorizedToMint-gated shape, so one minimal interface covers whichever
// token FactionRewardTokenRegistry hands back.
interface IMintableToken {
    function mint(address _to, uint _amount) external;
}

// Decides which token rewards a ship kill in — external (not internal) so
// its bytecode is deployed separately instead of inlined into Ships.sol,
// which has almost no size headroom left (same reasoning as
// SpecialEffectsLib being split out of Game.sol).
library DestroyRewardLib {
    // Emitted instead of minting when the destroyed ship's AI faction
    // (variant) has no reward token registered yet — gives off-chain
    // visibility into "this faction needs a token configured" without
    // reverting the kill (the ship still gets marked destroyed either way).
    event RewardSkipped(uint16 variant, address destroyerOwner);

    function payDestroyReward(
        address _lobbyAddress,
        address _destroyedShipOwner,
        address _destroyerOwner,
        uint _reward,
        uint16 _destroyedShipVariant,
        IUniversalCredits _universalCredits,
        IFactionRewardTokenRegistry _registry
    ) external {
        // Ownership decides UTC vs. an AI faction token; if AI-owned, the
        // destroyed ship's variant then decides *which* faction token (or
        // none yet, if that faction hasn't had one registered).
        if (
            ILobbiesOrchestratorCheck(_lobbyAddress).isSinglePlayerOrchestrator(
                _destroyedShipOwner
            )
        ) {
            address token = _registry.rewardToken(_destroyedShipVariant);
            if (token != address(0)) {
                IMintableToken(token).mint(_destroyerOwner, _reward);
            } else {
                emit RewardSkipped(_destroyedShipVariant, _destroyerOwner);
            }
        } else {
            _universalCredits.mint(_destroyerOwner, _reward);
        }
    }
}
