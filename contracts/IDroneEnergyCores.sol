// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

interface IDroneEnergyCores {
    function mint(address _to, uint _amount) external;

    function balanceOf(address _account) external view returns (uint);

    // ERC20Burnable.burnFrom — burns directly from `_account`'s balance
    // (requires `_account` to have approved the caller for at least
    // `_amount`). Used by DroneStorefront.turnInCores instead of pulling
    // turned-in cores into its own balance first.
    function burnFrom(address _account, uint _amount) external;
}
