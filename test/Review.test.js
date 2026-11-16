// Regression tests for the HEY Research Lab review of commit 0e1396a (16 Nov 2026):
// L-1 weekend vault creation, L-2 payroll recipient cap, L-3 hook L2 block, and informational notes I-1 to I-8.
const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');

const usd = (n) => ethers.parseUnits(String(n), 18);
const U = (n) => ethers.parseUnits(String(n), 6);
const W = (n) => ethers.parseUnits(String(n), 18);
const DAY = 86400, WEEK = 7 * DAY;
const FLAGS = (1n << 13n) | (1n << 7n) | (1n << 6n) | (1n << 2n), ALL = (1n << 14n) - 1n;
const DYNAMIC = 0x800000, SQRT_1_1 = 79228162514264337593543950336n;
const MIN_SQRT = 4295128739n + 1n, MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const ARB_SYS = '0x0000000000000000000000000000000000000064';

async function deployHook(manager) {
  const deployer = await ethers.deployContract('Create2Deployer');
  const F = await ethers.getContractFactory('NounyHook');
  const init = (await F.getDeployTransaction(await manager.getAddress(), 500, 10000, 50)).data;
  const h = ethers.keccak256(init), from = await deployer.getAddress();
  for (let i = 0n; ; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32), a = ethers.getCreate2Address(from, salt, h);
    if ((BigInt(a) & ALL) === FLAGS) { await (await deployer.deploy(salt, init)).wait(); return ethers.getContractAt('NounyHook', a); }
  }
}

describe('Review fixes (HEY Research Lab, 0e1396a)', function () {
  if (process.env.FORK) return;

  describe('AgentVault', () => {
    let admin, owner, operator, usdc, weth, cbbtc, fUsdc, fWeth, fBtc, router, factory, vault;
    beforeEach(async () => {
      [admin, owner, operator] = await ethers.getSigners();
      usdc = await ethers.deployContract('MockToken', ['USD Coin', 'USDC', 6]);
      weth = await ethers.deployContract('MockToken', ['Wrapped Ether', 'WETH', 18]);
      cbbtc = await ethers.deployContract('MockToken', ['cbBTC', 'cbBTC', 8]);
      fUsdc = await ethers.deployContract('MockFeed', [8, 1_0000_0000n]);
      fWeth = await ethers.deployContract('MockFeed', [8, 2000_0000_0000n]);
      fBtc = await ethers.deployContract('MockFeed', [8, 60000_0000_0000n]);
      router = await ethers.deployContract('MockRouter');
      await router.setRate(weth, cbbtc, 10n ** 18n);
      factory = await ethers.deployContract('AgentVaultFactory', [await router.getAddress(), operator.address,
        [await usdc.getAddress(), await weth.getAddress(), await cbbtc.getAddress()],
        [await fUsdc.getAddress(), await fWeth.getAddress(), await fBtc.getAddress()], [DAY, DAY, DAY], [0, 500, 500]]);
    });

    it('L-1: a vault can be created while a feed is stale (weekend), but swaps still refuse stale prices', async () => {
      await fBtc.set(60000_0000_0000n, (await time.latest()) - 3 * DAY); // like a stock feed over a long weekend
      await factory.connect(owner).createVault(100, usd(10_000));
      vault = await ethers.getContractAt('AgentVault', await factory.vaultOf(owner.address));
      expect(await vault.allowedTokens()).to.have.length(3);
      await cbbtc.mint(vault, 10n ** 8n);
      await expect(vault.connect(operator).swap(cbbtc, usdc, 500, 10n ** 8n, 0)).to.be.revertedWithCustomError(vault, 'StaleOraclePrice');
      await expect(vault.priceUsd(cbbtc)).to.be.revertedWithCustomError(vault, 'StaleOraclePrice');
    });

    it('L-1: setToken accepts a stale feed but still rejects a feed that does not answer a positive price', async () => {
      await factory.connect(owner).createVault(100, usd(10_000));
      vault = await ethers.getContractAt('AgentVault', await factory.vaultOf(owner.address));
      const stock = await ethers.deployContract('MockToken', ['Stock', 'STK', 18]);
      const fStock = await ethers.deployContract('MockFeed', [8, 200_0000_0000n]);
      await fStock.set(200_0000_0000n, (await time.latest()) - 3 * DAY);
      await expect(vault.connect(owner).setToken(stock, fStock, DAY, 3000)).to.emit(vault, 'TokenSet');
      const dead = await ethers.deployContract('MockFeed', [8, 0]);
      await expect(vault.connect(owner).setToken(stock, dead, DAY, 3000)).to.be.revertedWithCustomError(vault, 'BadOraclePrice');
    });

    it('I-1: the operator can only swap against the base token, never token to token', async () => {
      await factory.connect(owner).createVault(100, usd(10_000));
      vault = await ethers.getContractAt('AgentVault', await factory.vaultOf(owner.address));
      await weth.mint(vault, W(1));
      await expect(vault.connect(operator).swap(weth, cbbtc, 500, W(1), 0)).to.be.revertedWithCustomError(vault, 'PairNotAllowed');
    });
  });

  describe('PayrollVault', () => {
    let owner, alice, bob, usdg, factory, pr;
    beforeEach(async () => {
      [owner, alice, bob] = await ethers.getSigners();
      usdg = await ethers.deployContract('MockFreezableToken');
      factory = await ethers.deployContract('PayrollFactory', [await usdg.getAddress()]);
      await factory.connect(owner).createPayroll();
      pr = await ethers.getContractAt('PayrollVault', await factory.payrollOf(owner.address));
      await usdg.mint(pr, U(10_000));
    });

    it('L-2: removed recipients free their place under the 100 cap', async () => {
      for (let i = 0; i < 120; i++) {
        await pr.addRecipient(ethers.getAddress('0x' + (0x1000 + i).toString(16).padStart(40, '0')), U(1), 30 * DAY, 0);
        await pr.removeRecipient(i);
      }
      expect(await pr.activeCount()).to.equal(0);
      expect(await pr.recipientCount()).to.equal(120);
      await expect(pr.addRecipient(alice.address, U(1), WEEK, 0)).to.emit(pr, 'RecipientAdded');
    });

    it('L-2: still at most 100 active recipients', async () => {
      for (let i = 0; i < 100; i++) await pr.addRecipient(ethers.getAddress('0x' + (0x2000 + i).toString(16).padStart(40, '0')), U(1), WEEK, 0);
      await expect(pr.addRecipient(alice.address, U(1), WEEK, 0)).to.be.revertedWithCustomError(pr, 'TooManyRecipients');
      await pr.removeRecipient(5);
      await expect(pr.addRecipient(alice.address, U(1), WEEK, 0)).to.emit(pr, 'RecipientAdded');
    });

    it('I-3: resumeAndSkipMissed unpauses without paying the periods missed while paused', async () => {
      await pr.addRecipient(alice.address, U(100), WEEK, 0);
      await pr.payAllDue();
      await pr.setPaused(true);
      await time.increase(3 * WEEK + 100);
      await pr.resumeAndSkipMissed();
      expect(await pr.paused()).to.equal(false);
      await expect(pr.pay(0)).to.be.revertedWithCustomError(pr, 'NotDue');
      const r = await pr.getRecipient(0);
      expect(r.nextPayAt).to.be.greaterThan(await time.latest());
      expect(r.nextPayAt - BigInt(await time.latest())).to.be.lessThanOrEqual(BigInt(WEEK));
      expect(await usdg.balanceOf(alice.address)).to.equal(U(100));
    });

    it('I-3: plain setPaused(false) still pays every missed period, one per call (documented)', async () => {
      await pr.addRecipient(alice.address, U(100), WEEK, 0);
      await pr.payAllDue();
      await pr.setPaused(true);
      await time.increase(2 * WEEK + 100);
      await pr.setPaused(false);
      await pr.pay(0); await pr.pay(0);
      expect(await usdg.balanceOf(alice.address)).to.equal(U(300));
    });

    it('I-4: one recipient that cannot receive does not block payAllDue for the others', async () => {
      await pr.addRecipient(alice.address, U(100), WEEK, 0);
      await pr.addRecipient(bob.address, U(200), WEEK, 0);
      await usdg.freeze(alice.address, true);
      await expect(pr.payAllDue()).to.emit(pr, 'PaymentFailed').withArgs(0, alice.address, U(100));
      expect(await usdg.balanceOf(bob.address)).to.equal(U(200));
      expect(await usdg.balanceOf(alice.address)).to.equal(0);
      // alice's period stays due and is paid once she can receive again
      await usdg.freeze(alice.address, false);
      await expect(pr.pay(0)).to.emit(pr, 'Paid');
      expect(await usdg.balanceOf(alice.address)).to.equal(U(100));
      await expect(pr.pay(1)).to.be.revertedWithCustomError(pr, 'NotDue');
    });
  });

  describe('NounyHook', () => {
    let owner, alice, lp, manager, swapR, liqR, t0, t1, hook, key;
    const swap = (who, zeroForOne, amount) => swapR.connect(who).swap(key,
      { zeroForOne, amountSpecified: -amount, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT },
      { takeClaims: false, settleUsingBurn: false }, '0x');

    beforeEach(async () => {
      [owner, alice, lp] = await ethers.getSigners();
      manager = await ethers.deployContract('PoolManager', [owner.address]);
      swapR = await ethers.deployContract('PoolSwapTest', [await manager.getAddress()]);
      liqR = await ethers.deployContract('PoolModifyLiquidityTest', [await manager.getAddress()]);
      const a = await ethers.deployContract('MockFreezableToken'), b = await ethers.deployContract('MockFreezableToken');
      [t0, t1] = BigInt(await a.getAddress()) < BigInt(await b.getAddress()) ? [a, b] : [b, a];
      for (const t of [t0, t1]) for (const u of [owner, alice, lp]) {
        await t.mint(u.address, 10n ** 30n);
        await t.connect(u).approve(await swapR.getAddress(), ethers.MaxUint256);
        await t.connect(u).approve(await liqR.getAddress(), ethers.MaxUint256);
      }
      hook = await deployHook(manager);
      key = { currency0: await t0.getAddress(), currency1: await t1.getAddress(), fee: DYNAMIC, tickSpacing: 60, hooks: await hook.getAddress() };
    });
    afterEach(async () => { await network.provider.send('hardhat_setCode', [ARB_SYS, '0x']); });

    const seed = async () => liqR.connect(lp).modifyLiquidity(key, { tickLower: -6000, tickUpper: 6000, liquidityDelta: 10n ** 24n, salt: ethers.ZeroHash }, '0x');

    it('L-3: one swap per L2 block comes from ArbSys even though 0x64 has code (as on Robinhood Chain)', async () => {
      await hook.registerPool(key, ethers.ZeroAddress, 0);
      await manager.initialize(key, SQRT_1_1);
      await seed();
      const code = await ethers.provider.getCode(await (await ethers.deployContract('MockArbSys')).getAddress());
      await network.provider.send('hardhat_setCode', [ARB_SYS, code]);
      await network.provider.send('hardhat_setStorageAt', [ARB_SYS, '0x0', ethers.zeroPadValue(ethers.toBeHex(900_000_000), 32)]);
      await swap(alice, true, 10n ** 18n);
      const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24', 'int24', 'address'], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
      expect(await hook.lastSwapBlock(id, alice.address)).to.equal(900_000_000n); // the L2 number, not block.number
      // a later local block but the same ArbSys block: refused
      await expect(swap(alice, true, 10n ** 18n)).to.be.reverted;
      // the next L2 block: allowed
      await network.provider.send('hardhat_setStorageAt', [ARB_SYS, '0x0', ethers.zeroPadValue(ethers.toBeHex(900_000_001), 32)]);
      await swap(alice, true, 10n ** 18n);
      expect(await hook.lastSwapBlock(id, alice.address)).to.equal(900_000_001n);
    });

    it('L-3: without ArbSys (no data returned) it falls back to block.number', async () => {
      await hook.registerPool(key, ethers.ZeroAddress, 0);
      await manager.initialize(key, SQRT_1_1);
      await seed();
      const rc = await (await swap(alice, true, 10n ** 18n)).wait();
      const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24', 'int24', 'address'], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
      expect(await hook.lastSwapBlock(id, alice.address)).to.equal(BigInt(rc.blockNumber));
    });

    it('I-5: only the registrant can initialize the pool', async () => {
      await hook.connect(owner).registerPool(key, ethers.ZeroAddress, 0);
      await expect(manager.connect(alice).initialize(key, SQRT_1_1)).to.be.reverted;
      await manager.connect(owner).initialize(key, SQRT_1_1);
    });

    it('I-6: a payroll address that cannot receive does not block swaps; the share is skipped', async () => {
      await hook.registerPool(key, lp.address, 2000); // 20% of the fee to "payroll"
      await manager.initialize(key, SQRT_1_1);
      await seed();
      await t1.freeze(lp.address, true); // payroll can no longer receive token1
      const before = await t1.balanceOf(alice.address);
      await expect(swap(alice, true, 10n ** 18n)).to.emit(hook, 'PayrollSkipped');
      expect(await t1.balanceOf(alice.address)).to.be.greaterThan(before);
      await t1.freeze(lp.address, false);
      await network.provider.send('evm_mine');
      await expect(swap(alice, true, 10n ** 18n)).to.emit(hook, 'PayrollPaid');
    });
  });

  describe('NounyLPVault', () => {
    let owner, bot, stranger, manager, key, factory, vault, t0, f0, f1;
    beforeEach(async () => {
      [owner, bot, stranger] = await ethers.getSigners();
      manager = await ethers.deployContract('PoolManager', [owner.address]);
      const a = await ethers.deployContract('MockToken', ['A', 'A', 18]), b = await ethers.deployContract('MockToken', ['B', 'B', 18]);
      const [x, y] = BigInt(await a.getAddress()) < BigInt(await b.getAddress()) ? [a, b] : [b, a];
      t0 = x;
      const hook = await deployHook(manager);
      key = { currency0: await x.getAddress(), currency1: await y.getAddress(), fee: DYNAMIC, tickSpacing: 60, hooks: await hook.getAddress() };
      await hook.registerPool(key, ethers.ZeroAddress, 0);
      await manager.initialize(key, SQRT_1_1);
      f0 = await ethers.deployContract('MockFeed', [8, 1_0000_0000n]);
      f1 = await ethers.deployContract('MockFeed', [8, 1_0000_0000n]);
      factory = await ethers.deployContract('NounyLPVaultFactory', [await manager.getAddress(), bot.address]);
    });

    it('I-7: agent moves need at least 15 minutes between them', async () => {
      await expect(factory.createVault(key, f0, f1, DAY, 600, 6000, 0, 200)).to.be.reverted;
      await expect(factory.createVault(key, f0, f1, DAY, 600, 6000, 899, 200)).to.be.reverted;
      await factory.createVault(key, f0, f1, DAY, 600, 6000, 900, 200);
    });

    it('I-8: withdraw rejects the zero address; the factory admin hands over in two steps', async () => {
      await factory.createVault(key, f0, f1, DAY, 600, 6000, 3600, 200);
      const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24', 'int24', 'address'], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
      vault = await ethers.getContractAt('NounyLPVault', await factory.vaultOf(owner.address, id));
      await t0.mint(await vault.getAddress(), 10n ** 18n);
      await expect(vault.withdraw(t0, 1, ethers.ZeroAddress)).to.be.revertedWithCustomError(vault, 'BadParams');
      await vault.withdraw(t0, 1, owner.address);
      await expect(factory.connect(stranger).transferAdmin(stranger.address)).to.be.revertedWithCustomError(factory, 'NotAdmin');
      await factory.transferAdmin(stranger.address);
      expect(await factory.admin()).to.equal(owner.address);
      await expect(factory.connect(bot).acceptAdmin()).to.be.revertedWithCustomError(factory, 'NotAdmin');
      await factory.connect(stranger).acceptAdmin();
      expect(await factory.admin()).to.equal(stranger.address);
    });
  });
});
