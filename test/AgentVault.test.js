const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');

const usd = (n) => ethers.parseUnits(String(n), 18); // USD value, 18 decimals
const U = (n) => ethers.parseUnits(String(n), 6); // USDC
const W = (n) => ethers.parseUnits(String(n), 18); // WETH
const HOUR = 3600;

describe('AgentVault', function () {
  if (process.env.FORK) return; // unit tests run on the local network only

  let owner, operator, stranger, admin, usdc, weth, other, fUsdc, fWeth, fOther, router, factory, vault;

  async function deploy(Name, ...args) {
    const c = await ethers.deployContract(Name, args);
    await c.waitForDeployment();
    return c;
  }

  beforeEach(async () => {
    [admin, owner, operator, stranger] = await ethers.getSigners();
    usdc = await deploy('MockToken', 'USD Coin', 'USDC', 6);
    weth = await deploy('MockToken', 'Wrapped Ether', 'WETH', 18);
    other = await deploy('MockToken', 'Other', 'OTH', 18);
    fUsdc = await deploy('MockFeed', 8, 1_0000_0000n); // $1
    fWeth = await deploy('MockFeed', 8, 2000_0000_0000n); // $2000
    fOther = await deploy('MockFeed', 8, 1_0000_0000n);
    router = await deploy('MockRouter');
    // fair rate: 1 USDC -> 0.0005 WETH, 1 WETH -> 2000 USDC
    await router.setRate(usdc, weth, 5n * 10n ** 26n);
    await router.setRate(weth, usdc, 2n * 10n ** 9n);
    await usdc.mint(router, U(10_000_000));
    await weth.mint(router, W(10_000));

    factory = await deploy('AgentVaultFactory', await router.getAddress(), operator.address,
      [await usdc.getAddress(), await weth.getAddress()], [await fUsdc.getAddress(), await fWeth.getAddress()], [86400, 3600], [0, 500]); // USDC = base, WETH pool pinned to 0.05%
    await factory.connect(owner).createVault(100, usd(10_000)); // 1% slippage, $10k/day
    vault = await ethers.getContractAt('AgentVault', await factory.vaultOf(owner.address));
    await usdc.mint(vault, U(50_000));
  });

  describe('creation', () => {
    it('vault belongs to the caller, with default operator & tokens', async () => {
      expect(await vault.owner()).to.equal(owner.address);
      expect(await vault.operator()).to.equal(operator.address);
      expect(await vault.allowedTokens()).to.deep.equal([await usdc.getAddress(), await weth.getAddress()]);
      expect(await vault.priceUsd(weth)).to.equal(usd(2000));
    });
    it('one vault per wallet', async () => {
      await expect(factory.connect(owner).createVault(100, usd(1))).to.be.revertedWithCustomError(factory, 'VaultExists');
    });
    it('rejects slippage above 5%', async () => {
      await expect(factory.connect(stranger).createVault(501, usd(1))).to.be.revertedWithCustomError(vault, 'SlippageTooHigh');
    });
    it('rotating the factory operator does not affect existing vaults; only the admin can rotate it', async () => {
      await factory.connect(admin).setDefaultOperator(stranger.address);
      expect(await vault.operator()).to.equal(operator.address);
      await factory.connect(stranger).createVault(100, usd(1));
      const v2 = await ethers.getContractAt('AgentVault', await factory.vaultOf(stranger.address));
      expect(await v2.operator()).to.equal(stranger.address);
      await expect(factory.connect(stranger).setDefaultOperator(stranger.address)).to.be.revertedWithCustomError(factory, 'NotAdmin');
    });
    it('the factory token/oracle list cannot be changed after deployment', async () => {
      expect(factory.interface.getFunction('setDefaults', [])).to.equal(null);
      const [, tokens, feeds, , tiers] = await factory.getDefaults();
      expect(tokens).to.deep.equal([await usdc.getAddress(), await weth.getAddress()]);
      expect(feeds).to.deep.equal([await fUsdc.getAddress(), await fWeth.getAddress()]);
      expect(tiers.map(Number)).to.deep.equal([0, 500]);
    });
  });

  describe('operator swaps', () => {
    it('fair-price swap succeeds, output lands in the vault, approval reset to 0', async () => {
      await expect(vault.connect(operator).swap(usdc, weth, 500, U(1000), 0))
        .to.emit(vault, 'Swapped');
      expect(await weth.balanceOf(vault)).to.equal(W(0.5));
      expect(await usdc.balanceOf(vault)).to.equal(U(49_000));
      expect(await usdc.allowance(vault, router)).to.equal(0);
    });
    it('only the operator can swap (not even the owner)', async () => {
      await expect(vault.connect(stranger).swap(usdc, weth, 500, U(1), 0)).to.be.revertedWithCustomError(vault, 'NotOperator');
      await expect(vault.connect(owner).swap(usdc, weth, 500, U(1), 0)).to.be.revertedWithCustomError(vault, 'NotOperator');
    });
    it('rejects a bad price (3% below oracle) even when the operator passes minOut 0', async () => {
      await router.setRate(usdc, weth, 485n * 10n ** 24n); // 3% worse
      await expect(vault.connect(operator).swap(usdc, weth, 500, U(1000), 0)).to.be.revertedWith('Too little received');
    });
    it('a malicious router ignoring the minimum is still caught by the vault balance check', async () => {
      await router.setRate(usdc, weth, 1n * 10n ** 26n); // 80% worse
      await router.setEvil(true, ethers.ZeroAddress);
      await expect(vault.connect(operator).swap(usdc, weth, 500, U(1000), 0)).to.be.revertedWithCustomError(vault, 'InsufficientOutput');
    });
    it('rejects swap output diverted to another address', async () => {
      await router.setEvil(true, stranger.address);
      await expect(vault.connect(operator).swap(usdc, weth, 500, U(1000), 0)).to.be.revertedWithCustomError(vault, 'InsufficientOutput');
      expect(await usdc.balanceOf(vault)).to.equal(U(50_000));
    });
    it('honours a stricter operator minOut', async () => {
      await expect(vault.connect(operator).swap(usdc, weth, 500, U(1000), W(0.6))).to.be.revertedWith('Too little received');
    });
    it('operator cannot route through a different pool than the pinned fee tier', async () => {
      for (const tier of [100, 3000, 10000]) {
        await expect(vault.connect(operator).swap(usdc, weth, tier, U(100), 0)).to.be.revertedWithCustomError(vault, 'BadFeeTier');
      }
      await vault.connect(operator).swap(usdc, weth, 500, U(100), 0); // pinned tier works
    });
    it('owner can re-pin a token to another pool; invalid tiers are rejected', async () => {
      await vault.connect(owner).setToken(weth, fWeth, 3600, 3000);
      await expect(vault.connect(operator).swap(usdc, weth, 500, U(1), 0)).to.be.revertedWithCustomError(vault, 'BadFeeTier');
      await expect(vault.connect(owner).setToken(weth, fWeth, 3600, 123)).to.be.revertedWithCustomError(vault, 'BadFeeTier');
    });
    it('rejects unlisted tokens, same-token swaps and odd fee tiers', async () => {
      await other.mint(vault, W(1));
      await expect(vault.connect(operator).swap(other, usdc, 500, W(1), 0)).to.be.revertedWithCustomError(vault, 'TokenNotAllowed');
      await expect(vault.connect(operator).swap(usdc, usdc, 500, U(1), 0)).to.be.revertedWithCustomError(vault, 'SameToken');
      await expect(vault.connect(operator).swap(usdc, weth, 123, U(1), 0)).to.be.revertedWithCustomError(vault, 'BadFeeTier');
      await expect(vault.connect(operator).swap(usdc, weth, 500, 0, 0)).to.be.revertedWithCustomError(vault, 'ZeroAmount');
    });
  });

  describe('oracle', () => {
    it('rejects stale prices', async () => {
      await time.increase(2 * HOUR);
      await expect(vault.connect(operator).swap(usdc, weth, 500, U(100), 0)).to.be.revertedWithCustomError(vault, 'StaleOraclePrice');
    });
    it('rejects zero / negative prices', async () => {
      await fWeth.set(0, await time.latest());
      await expect(vault.connect(operator).swap(usdc, weth, 500, U(100), 0)).to.be.revertedWithCustomError(vault, 'BadOraclePrice');
    });
  });

  describe('daily limit', () => {
    it('caps total swaps per 24h, then resets', async () => {
      await vault.connect(owner).setLimits(100, usd(1000));
      await vault.connect(operator).swap(usdc, weth, 500, U(600), 0);
      expect(await vault.remainingDailyUsd()).to.equal(usd(400));
      await expect(vault.connect(operator).swap(usdc, weth, 500, U(600), 0)).to.be.revertedWithCustomError(vault, 'DailyLimitExceeded');
      await time.increase(24 * HOUR);
      await fWeth.set(2000_0000_0000n, await time.latest());
      await fUsdc.set(1_0000_0000n, await time.latest());
      await vault.connect(operator).swap(usdc, weth, 500, U(600), 0);
    });
  });

  describe('owner controls', () => {
    it('operator cannot withdraw or change settings', async () => {
      await expect(vault.connect(operator).withdraw(usdc, U(1), operator.address)).to.be.revertedWithCustomError(vault, 'NotOwner');
      await expect(vault.connect(operator).setOperator(stranger.address)).to.be.revertedWithCustomError(vault, 'NotOwner');
      await expect(vault.connect(operator).setLimits(500, usd(1e9))).to.be.revertedWithCustomError(vault, 'NotOwner');
      await expect(vault.connect(operator).setToken(other, fOther, 3600, 500)).to.be.revertedWithCustomError(vault, 'NotOwner');
      await expect(vault.connect(operator).setPaused(false)).to.be.revertedWithCustomError(vault, 'NotOwner');
    });
    it('pause stops swaps but the owner can still withdraw', async () => {
      await vault.connect(owner).setPaused(true);
      await expect(vault.connect(operator).swap(usdc, weth, 500, U(1), 0)).to.be.revertedWithCustomError(vault, 'Paused');
      await vault.connect(owner).withdraw(usdc, U(50_000), owner.address);
      expect(await usdc.balanceOf(owner.address)).to.equal(U(50_000));
    });
    it('revoking the operator disables the agent', async () => {
      await vault.connect(owner).setOperator(ethers.ZeroAddress);
      await expect(vault.connect(operator).swap(usdc, weth, 500, U(1), 0)).to.be.revertedWithCustomError(vault, 'NotOperator');
    });
    it('removing a token makes it untradeable', async () => {
      await vault.connect(owner).removeToken(weth);
      await expect(vault.connect(operator).swap(usdc, weth, 500, U(1), 0)).to.be.revertedWithCustomError(vault, 'TokenNotAllowed');
      expect(await vault.allowedTokens()).to.deep.equal([await usdc.getAddress()]);
    });
  });
});
