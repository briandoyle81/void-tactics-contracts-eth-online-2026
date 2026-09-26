// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./Types.sol";

// Minimal read-only view of Game.sol shared by every effect resolver
// (faction abilities and equipped specials alike) — same pattern
// Tournament.sol already uses for its own local IGame, rather than
// importing the whole Game contract. Also used by GenerateNewShip (random
// roll) and DroneYard (customization validation) to read maxSpecialSlot,
// which isn't game-specific but lives on Game.sol alongside the resolver
// registry it summarizes.
interface IGameView {
    function getShipPosition(
        uint _gameId,
        uint _shipId
    ) external view returns (ShipPosition memory);
    function getShipAttributes(
        uint _gameId,
        uint _shipId
    ) external view returns (Attributes memory);
    function getAllShipPositions(
        uint _gameId
    ) external view returns (ShipPosition[] memory);
    function maxSpecialSlot(uint16 _variant) external view returns (uint8);
}
