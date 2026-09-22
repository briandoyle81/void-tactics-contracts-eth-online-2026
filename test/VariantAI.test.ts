import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { zeroAddress } from "viem";
import DeployModule from "../ignition/modules/DeployAndConfig";

// AIBehaviorRegistry maps each faction (variant) to its own AI contract, and
// a special's behavior and strength are looked up by variant FIRST, then slot.
describe("Per-variant AI registry and variant-then-slot specials", function () {
  describe("AIBehaviorRegistry", function () {
    async function deployRegistry() {
      const [owner, other] = await hre.viem.getWalletClients();
      const registry = await hre.viem.deployContract("AIBehaviorRegistry", []);
      // Two stand-in AIs: constructor args are only config addresses, which
      // the registry never touches.
      const aiA = await hre.viem.deployContract("Variant1AI", [
        zeroAddress,
        zeroAddress,
      ]);
      const aiB = await hre.viem.deployContract("Variant2AI", [
        zeroAddress,
        zeroAddress,
      ]);
      return { owner, other, registry, aiA, aiB };
    }

    it("fails loud (NoAIForVariant) for a variant with no registered AI", async function () {
      const { registry } = await loadFixture(deployRegistry);
      await expect(registry.read.aiFor([1])).to.be.rejectedWith(
        "NoAIForVariant",
      );
      await expect(registry.read.aiFor([999])).to.be.rejectedWith(
        "NoAIForVariant",
      );
    });

    it("returns each variant's own registered AI", async function () {
      const { registry, aiA, aiB, owner } = await loadFixture(deployRegistry);
      await registry.write.setVariantAI([1, aiA.address], {
        account: owner.account,
      });
      await registry.write.setVariantAI([2, aiB.address], {
        account: owner.account,
      });

      expect((await registry.read.aiFor([1])).toLowerCase()).to.equal(
        aiA.address.toLowerCase(),
      );
      expect((await registry.read.aiFor([2])).toLowerCase()).to.equal(
        aiB.address.toLowerCase(),
      );
    });

    it("lets the owner upgrade one variant's AI without touching another's", async function () {
      const { registry, aiA, aiB, owner } = await loadFixture(deployRegistry);
      await registry.write.setVariantAI([1, aiA.address], {
        account: owner.account,
      });
      await registry.write.setVariantAI([2, aiA.address], {
        account: owner.account,
      });

      // Upgrade variant 2 only.
      await registry.write.setVariantAI([2, aiB.address], {
        account: owner.account,
      });
      expect((await registry.read.aiFor([1])).toLowerCase()).to.equal(
        aiA.address.toLowerCase(),
      );
      expect((await registry.read.aiFor([2])).toLowerCase()).to.equal(
        aiB.address.toLowerCase(),
      );

      // Unregistering (address(0)) makes lookups fail loud again.
      await registry.write.setVariantAI([2, zeroAddress], {
        account: owner.account,
      });
      await expect(registry.read.aiFor([2])).to.be.rejectedWith(
        "NoAIForVariant",
      );
    });

    it("only lets the owner register or replace an AI", async function () {
      const { registry, aiA, other } = await loadFixture(deployRegistry);
      await expect(
        registry.write.setVariantAI([1, aiA.address], {
          account: other.account,
        }),
      ).to.be.rejectedWith("OwnableUnauthorizedAccount");
    });
  });

  describe("deployed wiring", function () {
    async function deployAll() {
      return hre.ignition.deploy(DeployModule);
    }

    it("registers Variant1AI and Variant2AI for variants 1 and 2", async function () {
      const d = await loadFixture(deployAll);
      expect((await d.aiBehaviorRegistry.read.aiFor([1])).toLowerCase()).to.equal(
        d.variant1AI.address.toLowerCase(),
      );
      expect((await d.aiBehaviorRegistry.read.aiFor([2])).toLowerCase()).to.equal(
        d.variant2AI.address.toLowerCase(),
      );
      // Both matches read the same registry.
      expect(
        (await d.singlePlayerMatch.read.aiRegistry()).toLowerCase(),
      ).to.equal(d.aiBehaviorRegistry.address.toLowerCase());
      expect((await d.roguelikeMatch.read.aiRegistry()).toLowerCase()).to.equal(
        d.aiBehaviorRegistry.address.toLowerCase(),
      );
    });

    it("looks up a special's resolver by variant first, then slot", async function () {
      const d = await loadFixture(deployAll);
      const at = async (variant: number, slot: number) =>
        (await d.game.read.specialResolvers([variant, slot])).toLowerCase();

      // The same slot number means a different special per faction.
      expect(await at(1, 1)).to.equal(d.empResolver.address.toLowerCase());
      expect(await at(2, 1)).to.equal(
        d.electricStormResolver.address.toLowerCase(),
      );
      expect(await at(1, 2)).to.equal(
        d.repairDronesResolver.address.toLowerCase(),
      );
      expect(await at(2, 2)).to.equal(
        d.droneSwarmResolver.address.toLowerCase(),
      );
      expect(await at(1, 3)).to.equal(
        d.flakArrayResolver.address.toLowerCase(),
      );
      // Variant 2's slot 3 is the passive Additional Thruster: no resolver.
      expect(await at(2, 3)).to.equal(zeroAddress);
      // Slots 4-7 are unused by both factions.
      for (const variant of [1, 2]) {
        for (const slot of [4, 5, 6, 7]) {
          expect(await at(variant, slot)).to.equal(zeroAddress);
        }
      }
    });

    it("gives the same slot number unrelated strength/range per variant", async function () {
      const d = await loadFixture(deployAll);
      const data = async (variant: number, slot: number) =>
        d.shipAttributes.read.getSpecialData([slot, variant]);

      // Slot 1: EMP (variant 1) vs Electric Storm (variant 2).
      const v1s1 = await data(1, 1);
      const v2s1 = await data(2, 1);
      expect([v1s1.range, v1s1.strength]).to.deep.equal([1, 1]);
      expect([v2s1.range, v2s1.strength]).to.deep.equal([2, 1]);

      // Slot 2: Repair Drones (variant 1) vs Drone Swarm (variant 2).
      const v1s2 = await data(1, 2);
      const v2s2 = await data(2, 2);
      expect([v1s2.range, v1s2.strength]).to.deep.equal([3, 40]);
      expect([v2s2.range, v2s2.strength]).to.deep.equal([5, 40]);

      // Slot 3: Flak Array (variant 1) vs the passive Thruster (variant 2),
      // which only grants movement.
      const v1s3 = await data(1, 3);
      const v2s3 = await data(2, 3);
      expect([v1s3.range, v1s3.strength, v1s3.movement]).to.deep.equal([
        3, 30, 0,
      ]);
      expect([v2s3.range, v2s3.strength, v2s3.movement]).to.deep.equal([
        0, 0, 3,
      ]);

      // Slots 4-7 are inert for both.
      for (const variant of [1, 2]) {
        for (const slot of [4, 5, 6, 7]) {
          const sd = await data(variant, slot);
          expect([sd.range, sd.strength, sd.movement]).to.deep.equal([0, 0, 0]);
        }
      }
    });
  });
});
