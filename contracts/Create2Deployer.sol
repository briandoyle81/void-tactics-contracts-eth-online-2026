// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

// Minimal CREATE2 deployer, needed specifically for UTCLotteryHook.sol: a
// Uniswap v4 hook's address must have its low 14 bits match the hook's
// declared permissions (enforced by BaseHook's constructor), which normal
// CREATE (sequential nonce-based addressing) can't reliably produce — the
// deploying address must be fixed and known in advance so a salt can be
// mined offline (see scripts/hookMiner.ts) against it, then used here.
//
// On most real networks the canonical, already-deployed
// 0x4e59b44847b379578588920cA78FbF26c0B4956 "deterministic deployment
// proxy" (from a well-known keyless transaction) serves this exact purpose
// and could be targeted directly instead of this contract — but it isn't
// pre-seeded on Hardhat's local ephemeral network, so this exists for
// deploying/testing locally against a deployer address we actually control.
// Both approaches use the identical CREATE2 address formula; scripts/
// hookMiner.ts's mining logic works against either, as long as mining and
// deploying target the same deployer address.
contract Create2Deployer {
    event Deployed(address addr, bytes32 salt);

    error DeployFailed();

    function deploy(
        bytes memory _initCode,
        bytes32 _salt
    ) external returns (address addr) {
        assembly {
            addr := create2(0, add(_initCode, 0x20), mload(_initCode), _salt)
        }
        if (addr == address(0)) {
            revert DeployFailed();
        }
        emit Deployed(addr, _salt);
    }

    function computeAddress(
        bytes32 _salt,
        bytes32 _initCodeHash
    ) external view returns (address) {
        return
            address(
                uint160(
                    uint256(
                        keccak256(
                            abi.encodePacked(
                                bytes1(0xff),
                                address(this),
                                _salt,
                                _initCodeHash
                            )
                        )
                    )
                )
            );
    }
}
