// NounyLPVault on Uniswap v4's real PoolManager (local), in a NounyHook pool.
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');

const FLAGS = (1n << 13n) | (1n << 7n) | (1n << 6n) | (1n << 2n), ALL = (1n << 14n) - 1n;
const SQRT_1_1 = 79228162514264337593543950336n;
const MIN_SQRT = 4295128739n + 1n, MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const E18 = 10n ** 18n;

async function deployHook(deployer, manager) {
  const F = await ethers.getContractFactory('NounyHook');
  const init = (await F.getDeployTransaction(await manager.getAddress(), 500, 10000, 50)).data;
  const h = ethers.keccak256(init), from = await deployer.getAddress();
  for (let i = 0n; ; i++) { const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32); const a = ethers.getCreate2Address(from, salt, h); if ((BigInt(a) & ALL) === FLAGS) { await (await deployer.deploy(salt, init)).wait(); return a; } }
}

describe('NounyLPVault (agent rebalancing)', function () {
  if (process.env.FORK) return;
  let owner, bot, trader, stranger, manager, swapR, liqR, t0, t1, f0, f1, key, factory, vault;

  const swap = (who, zeroForOne, amount) => swapR.connect(who).swap(key, { zeroForOne, amountSpecified: -amount, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT }, { takeClaims: false, settleUsingBurn: false }, '0x');
  const slot0 = async () => { const [tick] = await vault.prices(); return Number(tick); };
  // Chainlink follows the market: point the mock token0 feed at the current pool price (token1 stays $1)
  const syncOracle = async () => {
    await f0.set(1_0000_0000n, await time.latest()); await f1.set(1_0000_0000n, await time.latest());
    const tick = await slot0();
    await f0.set(BigInt(Math.round(1e8 * Math.pow(1.0001, tick))), await time.latest());
    return tick;
  };

  beforeEach(async () => {
    [owner, bot, trader, stranger] = await ethers.getSigners();
    manager = await ethers.deployContract('PoolManager', [owner.address]);
    swapR = await ethers.deployContract('PoolSwapTest', [await manager.getAddress()]);
    liqR = await ethers.deployContract('PoolModifyLiquidityTest', [await manager.getAddress()]);
    const a = await ethers.deployContract('MockToken', ['Token A', 'TKA', 18]), b = await ethers.deployContract('MockToken', ['Token B', 'TKB', 18]);
    await a.mint(owner.address, 10n ** 30n); await b.mint(owner.address, 10n ** 30n);
    [t0, t1] = BigInt(await a.getAddress()) < BigInt(await b.getAddress()) ? [a, b] : [b, a];
    for (const t of [t0, t1]) { await t.transfer(trader.address, 10n ** 27n); for (const u of [owner, trader]) { await t.connect(u).approve(await swapR.getAddress(), ethers.MaxUint256); await t.connect(u).approve(await liqR.getAddress(), ethers.MaxUint256); } }
    const hook = await deployHook(await ethers.deployContract('Create2Deployer'), manager);
    key = { currency0: await t0.getAddress(), currency1: await t1.getAddress(), fee: 0x800000, tickSpacing: 60, hooks: hook };
    await (await ethers.getContractAt('NounyHook', hook)).registerPool(key, ethers.ZeroAddress, 0);
    await manager.initialize(key, SQRT_1_1);
    // background liquidity from someone else
    await liqR.modifyLiquidity(key, { tickLower: -12000, tickUpper: 12000, liquidityDelta: 10n ** 24n, salt: ethers.ZeroHash }, '0x');
    f0 = await ethers.deployContract('MockFeed', [8, 1_0000_0000n]); // both $1 → oracle price 1.0
    f1 = await ethers.deployContract('MockFeed', [8, 1_0000_0000n]);
    factory = await ethers.deployContract('NounyLPVaultFactory', [await manager.getAddress(), bot.address]);
    await factory.connect(owner).createVault(key, await f0.getAddress(), await f1.getAddress(), 86400, 600, 6000, 3600, 200); // width 600–6000 ticks, 1 h, 2%
    vault = await ethers.getContractAt('NounyLPVault', await factory.vaultOf(owner.address, ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24', 'int24', 'address'], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]))));
    await t0.transfer(await vault.getAddress(), 1000n * E18);
    await t1.transfer(await vault.getAddress(), 1000n * E18);
  });

  it('factory: one vault per owner and pool, NOUNY operator installed, owner set', async () => {
    expect(await vault.owner()).to.equal(owner.address);
    expect(await vault.operator()).to.equal(bot.address);
    expect(await factory.vaultCount()).to.equal(1n);
    expect((await factory.vaults(0, 10))[0]).to.equal(await vault.getAddress());
    await expect(factory.connect(owner).createVault(key, await f0.getAddress(), await f1.getAddress(), 86400, 600, 6000, 3600, 200)).to.be.revertedWithCustomError(factory, 'VaultExists');
  });

  it('agent opens a position around the price; tokens stay with the vault/pool', async () => {
    await expect(vault.connect(bot).rebalance(-600, 600)).to.emit(vault, 'Rebalanced');
    expect(await vault.liquidity()).to.be.gt(0n);
    expect([await vault.tickLower(), await vault.tickUpper()]).to.deep.equal([-600n, 600n]);
    const [a0, a1] = await vault.positionAmounts();
    expect(a0 + a1).to.be.closeTo(2000n * E18, 2n * E18); // nearly everything deployed at price 1
    expect(await t0.balanceOf(bot.address)).to.equal(0n);
  });

  it('agent follows the price after it moves, and earns fees for the owner', async () => {
    await vault.connect(bot).rebalance(-600, 600);
    for (let i = 0; i < 6; i++) { await swap(trader, false, 20000n * E18); } // push price up (token1 in)
    await time.increase(3600);
    const tick = await syncOracle();
    expect(tick).to.be.gt(600); // now out of range
    const lo = Math.floor(tick / 60) * 60 - 600, hi = lo + 1200;
    const rc = await (await vault.connect(bot).rebalance(lo, hi)).wait();
    const ev = rc.logs.map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'Rebalanced');
    expect(ev.args.fees0 + ev.args.fees1).to.be.gt(0n); // collected LP fees from the swaps
    expect(await vault.tickLower()).to.equal(BigInt(lo));
  });

  it('rejects ranges that exclude the price, are too narrow/wide, or misaligned', async () => {
    await expect(vault.connect(bot).rebalance(600, 1200)).to.be.revertedWithCustomError(vault, 'BadRange'); // price outside
    await expect(vault.connect(bot).rebalance(-60, 60)).to.be.revertedWithCustomError(vault, 'BadRange'); // too narrow (120 < 600)
    await expect(vault.connect(bot).rebalance(-6000, 6060)).to.be.revertedWithCustomError(vault, 'BadRange'); // too wide
    await expect(vault.connect(bot).rebalance(-610, 600)).to.be.revertedWithCustomError(vault, 'BadRange'); // misaligned
  });

  it('refuses to rebalance when the pool price is off the Chainlink price', async () => {
    await f1.set(1_1000_0000n, await time.latest()); // token1 now $1.10 → oracle price 0.909, pool still 1.0 (≈10% off)
    await expect(vault.connect(bot).rebalance(-600, 600)).to.be.revertedWithCustomError(vault, 'PriceOffOracle');
    await f1.set(1_0100_0000n, await time.latest()); // 1% off → allowed (cap 2%)
    await expect(vault.connect(bot).rebalance(-600, 600)).not.to.be.reverted;
  });

  it('rejects stale oracle prices', async () => {
    await f0.set(1_0000_0000n, (await time.latest()) - 90000);
    await expect(vault.connect(bot).rebalance(-600, 600)).to.be.revertedWithCustomError(vault, 'StaleOracle');
  });

  it('agent is rate-limited; owner is not', async () => {
    await vault.connect(bot).rebalance(-600, 600);
    await expect(vault.connect(bot).rebalance(-1200, 1200)).to.be.revertedWithCustomError(vault, 'TooSoon');
    await vault.connect(owner).rebalance(-1200, 1200);
    await time.increase(3600);
    await vault.connect(bot).rebalance(-600, 600);
  });

  it('only the owner exits and withdraws — even while paused; the agent can never move funds out', async () => {
    await vault.connect(bot).rebalance(-600, 600);
    await expect(vault.connect(bot).exit()).to.be.revertedWithCustomError(vault, 'NotOwner');
    await expect(vault.connect(bot).withdraw(await t0.getAddress(), 1n, bot.address)).to.be.revertedWithCustomError(vault, 'NotOwner');
    await expect(vault.connect(stranger).rebalance(-600, 600)).to.be.revertedWithCustomError(vault, 'NotAllowed');
    await vault.setPaused(true);
    await time.increase(3600);
    await expect(vault.connect(bot).rebalance(-600, 600)).to.be.revertedWithCustomError(vault, 'IsPaused');
    await vault.exit();
    expect(await vault.liquidity()).to.equal(0n);
    const b0 = await t0.balanceOf(owner.address), b1 = await t1.balanceOf(owner.address);
    await vault.withdraw(await t0.getAddress(), ethers.MaxUint256, owner.address);
    await vault.withdraw(await t1.getAddress(), ethers.MaxUint256, owner.address);
    const got = (await t0.balanceOf(owner.address)) - b0 + (await t1.balanceOf(owner.address)) - b1;
    expect(got).to.be.closeTo(2000n * E18, 10n ** 6n); // everything back (minus pool rounding dust)
  });

  it('owner can revoke the agent and change limits within bounds', async () => {
    await vault.setOperator(ethers.ZeroAddress);
    await expect(vault.connect(bot).rebalance(-600, 600)).to.be.revertedWithCustomError(vault, 'NotAllowed');
    await expect(vault.setParams(0, 6000, 3600, 200)).to.be.revertedWithCustomError(vault, 'BadParams');
    await expect(vault.setParams(600, 6000, 3600, 1001)).to.be.revertedWithCustomError(vault, 'BadParams');
    await expect(vault.connect(bot).setParams(600, 6000, 0, 200)).to.be.revertedWithCustomError(vault, 'NotOwner');
  });

  it('fuzz: random price moves + agent rebalances — the vault never loses tokens to anyone but the pool', async () => {
    let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    await vault.connect(bot).rebalance(-1200, 1200);
    for (let i = 0; i < 25; i++) {
      await swap(trader, rnd() < 0.5, BigInt(Math.floor(rnd() * 1500) + 1) * E18);
      await time.increase(3600);
      const tick = await syncOracle();
      const lo = Math.floor(tick / 60) * 60 - 600 - 60 * Math.floor(rnd() * 20), hi = lo + 1200 + 60 * Math.floor(rnd() * 40);
      if (tick >= lo && tick < hi) await vault.connect(bot).rebalance(lo, hi);
      expect(await t0.balanceOf(bot.address)).to.equal(0n);
      expect(await t1.balanceOf(bot.address)).to.equal(0n);
    }
    await vault.exit();
    expect(await vault.liquidity()).to.equal(0n);
    await syncOracle();
    // value check at final pool price: within a few % of the 2000 deposited (impermanent loss + fees)
    const [, poolX96] = await vault.prices();
    const v = (await t0.balanceOf(await vault.getAddress())) * poolX96 / (1n << 96n) + (await t1.balanceOf(await vault.getAddress()));
    expect(v).to.be.gt(1500n * E18);
  });
});
