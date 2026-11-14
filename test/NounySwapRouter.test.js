const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { mine, time } = require('@nomicfoundation/hardhat-network-helpers');

const FLAGS = (1n << 13n) | (1n << 7n) | (1n << 6n) | (1n << 2n), ALL = (1n << 14n) - 1n;
const SQRT_1_1 = 79228162514264337593543950336n;
const E18 = 10n ** 18n;

describe('NounySwapRouter (hooked pool swaps)', function () {
  if (process.env.FORK) return;
  let owner, user, payroll, manager, liqR, router, t0, t1, hook, key;

  beforeEach(async () => {
    [owner, user, payroll] = await ethers.getSigners();
    manager = await ethers.deployContract('PoolManager', [owner.address]);
    liqR = await ethers.deployContract('PoolModifyLiquidityTest', [await manager.getAddress()]);
    router = await ethers.deployContract('NounySwapRouter', [await manager.getAddress()]);
    const a = await ethers.deployContract('MockToken', ['A', 'A', 18]), b = await ethers.deployContract('MockToken', ['B', 'B', 18]);
    [t0, t1] = BigInt(await a.getAddress()) < BigInt(await b.getAddress()) ? [a, b] : [b, a];
    for (const t of [t0, t1]) { await t.mint(owner.address, 10n ** 27n); await t.mint(user.address, 1000n * E18); await t.approve(await liqR.getAddress(), ethers.MaxUint256); await t.connect(user).approve(await router.getAddress(), ethers.MaxUint256); }
    const dep = await ethers.deployContract('Create2Deployer');
    const init = (await (await ethers.getContractFactory('NounyHook')).getDeployTransaction(await manager.getAddress(), 500, 10000, 50)).data;
    const h = ethers.keccak256(init);
    for (let i = 0n; ; i++) { const s = ethers.zeroPadValue(ethers.toBeHex(i), 32); hook = ethers.getCreate2Address(await dep.getAddress(), s, h); if ((BigInt(hook) & ALL) === FLAGS) { await (await dep.deploy(s, init)).wait(); break; } }
    key = { currency0: await t0.getAddress(), currency1: await t1.getAddress(), fee: 0x800000, tickSpacing: 60, hooks: hook };
    await (await ethers.getContractAt('NounyHook', hook)).registerPool(key, payroll.address, 2000);
    await manager.initialize(key, SQRT_1_1);
    await liqR.modifyLiquidity(key, { tickLower: -6000, tickUpper: 6000, liquidityDelta: 10n ** 24n, salt: ethers.ZeroHash }, '0x');
  });

  const deadline = async () => (await time.latest()) + 600;

  it('swaps token0 → token1: pulls exactly amountIn, sends output to the user, payroll gets its share, router keeps nothing', async () => {
    const b0 = await t0.balanceOf(user.address), b1 = await t1.balanceOf(user.address), p1 = await t1.balanceOf(payroll.address);
    await expect(router.connect(user).swapExactIn(key, true, 10n * E18, 9n * E18, await deadline())).to.emit(router, 'Swapped');
    expect(b0 - (await t0.balanceOf(user.address))).to.equal(10n * E18);
    const got = (await t1.balanceOf(user.address)) - b1;
    expect(got).to.be.closeTo(10n * E18, E18 / 50n); // price 1, 0.05% fee + tiny impact
    expect((await t1.balanceOf(payroll.address)) - p1).to.be.gt(0n);
    for (const t of [t0, t1]) expect(await t.balanceOf(await router.getAddress())).to.equal(0n);
  });

  it('swaps token1 → token0', async () => {
    const b0 = await t0.balanceOf(user.address);
    await router.connect(user).swapExactIn(key, false, 5n * E18, 4n * E18, await deadline());
    expect((await t0.balanceOf(user.address)) - b0).to.be.closeTo(5n * E18, E18 / 50n);
  });

  it('reverts when the output is below the minimum (slippage guard)', async () => {
    await expect(router.connect(user).swapExactIn(key, true, 10n * E18, 11n * E18, await deadline())).to.be.revertedWithCustomError(router, 'TooLittleReceived');
  });

  it('reverts after the deadline and on zero amounts', async () => {
    await expect(router.connect(user).swapExactIn(key, true, E18, 0, (await time.latest()) - 1)).to.be.revertedWithCustomError(router, 'Expired');
    await expect(router.connect(user).swapExactIn(key, true, 0, 0, await deadline())).to.be.revertedWithCustomError(router, 'ZeroAmount');
  });

  it('the hook still limits each wallet to one swap per block through the router', async () => {
    await network.provider.send('evm_setAutomine', [false]);
    const g = { gasLimit: 1_000_000 }, dl = await deadline();
    const a = await router.connect(user).swapExactIn(key, true, E18, 0, dl, g), b = await router.connect(user).swapExactIn(key, false, E18, 0, dl, g);
    await mine(1);
    await network.provider.send('evm_setAutomine', [true]);
    expect((await ethers.provider.getTransactionReceipt(a.hash)).status).to.equal(1);
    expect((await ethers.provider.getTransactionReceipt(b.hash)).status).to.equal(0);
  });

  it('only the PoolManager can call the callback', async () => {
    await expect(router.unlockCallback('0x')).to.be.revertedWithCustomError(router, 'NotPoolManager');
  });
});
