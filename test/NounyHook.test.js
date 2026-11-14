// NounyHook against Uniswap v4's real PoolManager (local), using Uniswap's own test routers.
const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { mine } = require('@nomicfoundation/hardhat-network-helpers');

const FLAGS = (1n << 13n) | (1n << 7n) | (1n << 6n) | (1n << 2n); // beforeInitialize | beforeSwap | afterSwap | afterSwapReturnDelta
const ALL = (1n << 14n) - 1n;
const DYNAMIC = 0x800000;
const SQRT_1_1 = 79228162514264337593543950336n;
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const E18 = 10n ** 18n;

// Mine a CREATE2 salt so the hook address carries exactly its permission bits.
async function deployHook(deployer, manager, args = [500, 10000, 50]) {
  const F = await ethers.getContractFactory('NounyHook');
  const init = (await F.getDeployTransaction(await manager.getAddress(), ...args)).data;
  const hash = ethers.keccak256(init), from = await deployer.getAddress();
  for (let i = 0n; ; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const addr = ethers.getCreate2Address(from, salt, hash);
    if ((BigInt(addr) & ALL) === FLAGS) {
      await (await deployer.deploy(salt, init)).wait();
      return ethers.getContractAt('NounyHook', addr);
    }
  }
}

describe('NounyHook (Uniswap v4)', function () {
  if (process.env.FORK) return;
  let owner, lp, alice, bob, payroll, manager, swapR, liqR, t0, t1, hook, key, deployer;

  async function swap(who, zeroForOne, amount, exactIn = true, overrides = {}) {
    return swapR.connect(who).swap(key,
      { zeroForOne, amountSpecified: exactIn ? -amount : amount, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT },
      { takeClaims: false, settleUsingBurn: false }, '0x', overrides);
  }
  const bal = (t, a) => t.balanceOf(a);

  beforeEach(async () => {
    [owner, lp, alice, bob, payroll] = await ethers.getSigners();
    manager = await ethers.deployContract('PoolManager', [owner.address]);
    swapR = await ethers.deployContract('PoolSwapTest', [await manager.getAddress()]);
    liqR = await ethers.deployContract('PoolModifyLiquidityTest', [await manager.getAddress()]);
    const a = await ethers.deployContract('TestERC20', [10n ** 30n]), b = await ethers.deployContract('TestERC20', [10n ** 30n]);
    [t0, t1] = BigInt(await a.getAddress()) < BigInt(await b.getAddress()) ? [a, b] : [b, a];
    for (const u of [alice, bob, lp]) for (const t of [t0, t1]) await t.transfer(u.address, 10n ** 26n);
    for (const u of [owner, alice, bob, lp]) for (const t of [t0, t1]) {
      await t.connect(u).approve(await swapR.getAddress(), ethers.MaxUint256);
      await t.connect(u).approve(await liqR.getAddress(), ethers.MaxUint256);
    }
    deployer = await ethers.deployContract('Create2Deployer');
    hook = await deployHook(deployer, manager);
    key = { currency0: await t0.getAddress(), currency1: await t1.getAddress(), fee: DYNAMIC, tickSpacing: 60, hooks: await hook.getAddress() };
  });

  async function setupPool(share = 2000, to = payroll.address) {
    await hook.connect(owner).registerPool(key, share ? to : ethers.ZeroAddress, share);
    await manager.initialize(key, SQRT_1_1);
    await liqR.connect(lp).modifyLiquidity(key, { tickLower: -6000, tickUpper: 6000, liquidityDelta: 10n ** 24n, salt: ethers.ZeroHash }, '0x');
  }

  it('lives at an address that encodes exactly its permissions', async () => {
    expect(BigInt(await hook.getAddress()) & ALL).to.equal(FLAGS);
    const F = await ethers.getContractFactory('NounyHook');
    await expect(F.deploy(await manager.getAddress(), 500, 10000, 50)).to.be.reverted; // wrong address bits
  });

  it('rejects bad fee configs', async () => {
    const F = await ethers.getContractFactory('NounyHook');
    await expect(F.deploy(await manager.getAddress(), 0, 10000, 50)).to.be.revertedWithCustomError(F, 'BadFeeConfig');
    await expect(F.deploy(await manager.getAddress(), 2000, 1000, 50)).to.be.revertedWithCustomError(F, 'BadFeeConfig');
  });

  it('only registered dynamic-fee pools can be initialized, once', async () => {
    await expect(manager.initialize(key, SQRT_1_1)).to.be.reverted; // not registered
    await expect(hook.registerPool({ ...key, fee: 3000 }, payroll.address, 100)).to.be.revertedWithCustomError(hook, 'NotDynamicFee');
    await expect(hook.registerPool({ ...key, hooks: ethers.ZeroAddress }, payroll.address, 100)).to.be.revertedWithCustomError(hook, 'NotRegistered');
    await hook.registerPool(key, payroll.address, 100);
    await expect(hook.connect(alice).registerPool(key, alice.address, 100)).to.be.revertedWithCustomError(hook, 'AlreadyRegistered');
    await manager.initialize(key, SQRT_1_1);
    expect((await hook.pools(await poolId())).initialized).to.equal(true);
  });

  async function poolId() {
    return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24', 'int24', 'address'], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
  }

  it('starts at the minimum fee and splits it with payroll', async () => {
    await setupPool(2000);
    const q = await hook.quoteFee(key);
    expect(q.totalFee).to.equal(500n);
    expect(q.lpFee).to.equal(400n);
    expect(q.payrollFee).to.equal(100n);
  });

  it('exact-in swap: payroll receives its share of the output, swapper pays the same total fee', async () => {
    await setupPool(2000);
    const p0 = await bal(t1, payroll.address), a1 = await bal(t1, alice.address);
    const tx = await swap(alice, true, E18);
    const rc = await tx.wait();
    const paid = (await bal(t1, payroll.address)) - p0, got = (await bal(t1, alice.address)) - a1;
    const ev = rc.logs.map((l) => { try { return hook.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'PayrollPaid');
    expect(ev.args.amount).to.equal(paid);
    // payroll share = 100 pips of the output before the hook took it
    expect(paid).to.equal((got + paid) * 100n / 1_000_000n);
    // total cost ≈ 0.05% + price impact: output within 0.1% of input at price 1
    expect(got + paid).to.be.closeTo(E18, E18 / 1000n);
  });

  it('exact-out swap: payroll share is taken in the input currency', async () => {
    await setupPool(2000);
    const p0 = await bal(t0, payroll.address);
    await swap(alice, true, E18 / 2n, false);
    expect((await bal(t0, payroll.address)) - p0).to.be.gt(0n);
  });

  it('no payroll configured: no share taken, LP keeps the full fee', async () => {
    await setupPool(0);
    const q = await hook.quoteFee(key);
    expect(q.payrollFee).to.equal(0n);
    expect(q.lpFee).to.equal(500n);
    const p0 = await bal(t1, payroll.address);
    await swap(alice, true, E18);
    expect(await bal(t1, payroll.address)).to.equal(p0);
  });

  it('one swap per block per address; other addresses and the next block are fine', async () => {
    await setupPool(2000);
    await network.provider.send('evm_setAutomine', [false]);
    const g = { gasLimit: 1_000_000 };
    const s1 = await swap(alice, true, E18, true, g), s2 = await swap(alice, false, E18, true, g), s3 = await swap(bob, true, E18, true, g);
    await mine(1);
    await network.provider.send('evm_setAutomine', [true]);
    const status = async (t) => (await ethers.provider.getTransactionReceipt(t.hash)).status;
    expect(await status(s1)).to.equal(1);
    expect(await status(s2)).to.equal(0); // second swap by alice in the same block reverted
    expect(await status(s3)).to.equal(1);
    await expect(swap(alice, false, E18)).not.to.be.reverted; // next block
  });

  it('fee rises with price moves, stays within [min, max], and decays when calm', async () => {
    await setupPool(2000);
    for (let i = 0; i < 8; i++) await swap(i % 2 ? bob : alice, i % 2 === 0, 300n * E18); // large back-and-forth moves
    const hot = await hook.quoteFee(key);
    expect(hot.totalFee).to.be.gt(500n);
    expect(hot.totalFee).to.be.lte(10000n);
    expect(hot.volatilityE4).to.be.gt(0n);
    await mine(40);
    const calm = await hook.quoteFee(key);
    expect(calm.totalFee).to.be.lt(hot.totalFee);
  });

  it('owner controls: payroll and share bounds, ownership transfer', async () => {
    await setupPool(2000);
    await expect(hook.connect(alice).setPayroll(key, alice.address, 100)).to.be.revertedWithCustomError(hook, 'NotPoolOwner');
    await expect(hook.setPayroll(key, payroll.address, 5001)).to.be.revertedWithCustomError(hook, 'BadShare');
    await expect(hook.setPayroll(key, ethers.ZeroAddress, 100)).to.be.revertedWithCustomError(hook, 'BadShare');
    await hook.setPayroll(key, bob.address, 5000);
    expect((await hook.quoteFee(key)).payrollFee).to.equal(250n);
    await expect(hook.setOwner(key, ethers.ZeroAddress)).to.be.revertedWithCustomError(hook, 'NotPoolOwner');
    await hook.setOwner(key, alice.address);
    await expect(hook.setPayroll(key, bob.address, 0)).to.be.revertedWithCustomError(hook, 'NotPoolOwner');
    await hook.connect(alice).setPayroll(key, bob.address, 0);
  });

  it('only the PoolManager can call hook functions', async () => {
    await setupPool(2000);
    await expect(hook.beforeSwap(alice.address, key, { zeroForOne: true, amountSpecified: -1, sqrtPriceLimitX96: MIN_SQRT }, '0x'))
      .to.be.revertedWithCustomError(hook, 'NotPoolManager');
    await expect(hook.beforeInitialize(alice.address, key, SQRT_1_1)).to.be.revertedWithCustomError(hook, 'NotPoolManager');
  });

  it('fuzz: random swaps — fee always in range, payroll gets exactly the reported share, pool stays solvent', async () => {
    await setupPool(3000);
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const users = [alice, bob, lp];
    let reported = 0n;
    const p0 = (await bal(t0, payroll.address)) + (await bal(t1, payroll.address));
    for (let i = 0; i < 60; i++) {
      const q = await hook.quoteFee(key);
      expect(q.totalFee).to.be.gte(500n); expect(q.totalFee).to.be.lte(10000n);
      expect(q.lpFee + q.payrollFee).to.equal(q.totalFee);
      const amt = BigInt(Math.floor(1 + rnd() * 50)) * E18 / 10n;
      const rc = await (await swap(users[i % 3], rnd() < 0.5, amt, rnd() < 0.7)).wait();
      for (const l of rc.logs) { try { const e = hook.interface.parseLog(l); if (e.name === 'PayrollPaid') reported += e.args.amount; } catch {} }
      if (rnd() < 0.3) await mine(Math.floor(rnd() * 5));
    }
    const p1 = (await bal(t0, payroll.address)) + (await bal(t1, payroll.address));
    expect(p1 - p0).to.equal(reported);
    // LP can still withdraw all liquidity
    await liqR.connect(lp).modifyLiquidity(key, { tickLower: -6000, tickUpper: 6000, liquidityDelta: -(10n ** 24n), salt: ethers.ZeroHash }, '0x');
  });
});
