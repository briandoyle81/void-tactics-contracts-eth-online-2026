import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";

// Focused on what isn't already covered indirectly via
// Ships.test.ts/TutorialClaim.test.ts's eligibility-provider integration
// tests: this contract's own event emissions.
describe("SelfieCheckEligibilityProvider", function () {
  async function deployFixture() {
    const [owner, verifier, other] = await hre.viem.getWalletClients();
    const provider = await hre.viem.deployContract(
      "SelfieCheckEligibilityProvider",
      [owner.account.address],
    );
    return { owner, verifier, other, provider };
  }

  it("emits AuthorizedVerifierSet when a verifier is authorized or revoked", async function () {
    const { provider, verifier } = await loadFixture(deployFixture);
    const publicClient = await hre.viem.getPublicClient();

    const hash = await provider.write.setAuthorizedVerifier([
      verifier.account.address,
      true,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const events = await provider.getEvents.AuthorizedVerifierSet(undefined, {
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
    });
    expect(events).to.have.length(1);
    expect(events[0].args.verifier?.toLowerCase()).to.equal(
      verifier.account.address.toLowerCase(),
    );
    expect(events[0].args.isAuthorized).to.equal(true);
  });

  it("emits NullifierCheckEnabledSet when toggled", async function () {
    const { provider } = await loadFixture(deployFixture);
    const publicClient = await hre.viem.getPublicClient();

    const hash = await provider.write.setNullifierCheckEnabled([false]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const events = await provider.getEvents.NullifierCheckEnabledSet(
      undefined,
      { fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber },
    );
    expect(events).to.have.length(1);
    expect(events[0].args.enabled).to.equal(false);
    expect(await provider.read.nullifierCheckEnabled()).to.equal(false);
  });

  it("both setters are owner-only", async function () {
    const { provider, other, verifier } = await loadFixture(deployFixture);
    const asOther = await hre.viem.getContractAt(
      "SelfieCheckEligibilityProvider",
      provider.address,
      { client: { wallet: other } },
    );
    await expect(
      asOther.write.setAuthorizedVerifier([verifier.account.address, true]),
    ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    await expect(
      asOther.write.setNullifierCheckEnabled([false]),
    ).to.be.rejectedWith("OwnableUnauthorizedAccount");
  });
});
