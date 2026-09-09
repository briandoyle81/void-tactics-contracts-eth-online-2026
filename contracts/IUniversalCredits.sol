// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

interface IUniversalCredits {
    function mint(address _to, uint _amount) external;

    function transfer(address _to, uint _amount) external returns (bool);

    function transferFrom(
        address _from,
        address _to,
        uint _amount
    ) external returns (bool);

    function balanceOf(address _account) external view returns (uint);

    // ERC20Burnable.burn — burns from the caller's own balance. ShipPurchaser
    // and DroneYard both call this on UTC they're already holding (from
    // sales / modification fees), never on another account's balance.
    function burn(uint _amount) external;
}
