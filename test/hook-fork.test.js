// NounyHook on a local fork of Robinhood Chain against the REAL Uniswap v4 PoolManager, with real WETH and USDG.
//   npm run test:fork:hook      (FORK=1, nothing is sent on-chain)
const { expect } = require('chai');
const { ethers } = require('hardhat');
const netConfig = require('../scripts/netconfig');

const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const FLAGS = (1n << 13n) | (1n << 7n) | (1n << 6n) | (1n << 2n), ALL = (1n << 14n) - 1n;
const MIN_SQRT = 4295128739n + 1n, MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const sqrtBig = (n) => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };

describe('NounyHook on a Robinhood Chain fork (real v4 PoolManager)', function () {
  if (!process.env.FORK || (process.env.FORK_NETWORK || 'robinhood') !== 'robinhood') return;
  const cfg = netConfig('hardhat');
  const T = Object.fromEntries(cfg.tokens.map((t) => [t.symbol, t]));
  let me, payroll, hook, swapR, liqR, weth, usdg, key;

  before(async () => {
    [me, payroll] = await ethers.getSigners();
    expect((await ethers.provider.getCode(POOL_MANAGER)).length).to.be.gt(1000);
    // hook at a mined CREATE2 address
    const dep = await ethers.deployContract('Create2Deployer');
    const init = (await (await ethers.getContractFactory('NounyHook')).getDeployTransaction(POOL_MANAGER, 500, 10000, 50)).data;
    const h = ethers.keccak256(init), from = await dep.getAddress();
    let addr;
    for (let i = 0n; ; i++) { const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32); addr = ethers.getCreate2Address(from, salt, h); if ((BigInt(addr) & ALL) === FLAGS) { await (await dep.deploy(salt, init)).wait(); break; } }
    hook = await ethers.getContractAt('NounyHook', addr);
    swapR = await ethers.deployContract('PoolSwapTest', [POOL_MANAGER]);
    liqR = await ethers.deployContract('PoolModifyLiquidityTest', [POOL_MANAGER]);

    // real WETH (wrap ETH) and real USDG (bought on the Uniswap V3 pool)
    weth = await ethers.getContractAt(['function deposit() payable', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], T.WETH.address);
    usdg = await ethers.getContractAt(['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], T.USDG.address);
    await weth.deposit({ value: ethers.parseEther('40') });
    const v3 = await ethers.getContractAt(['function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)'], cfg.router);
    await weth.approve(cfg.router, ethers.MaxUint256);
    await v3.exactInputSingle([T.WETH.address, T.USDG.address, T.WETH.feeTier, me.address, ethers.parseEther('15'), 0, 0]);
    for (const t of [weth, usdg]) for (const r of [swapR, liqR]) await t.approve(await r.getAddress(), ethers.MaxUint256);

    // pool WETH/USDG with the hook, priced from the Chainlink ETH/USD feed
    const [c0, c1] = BigInt(T.WETH.address) < BigInt(T.USDG.address) ? [T.WETH, T.USDG] : [T.USDG, T.WETH];
    key = { currency0: c0.address, currency1: c1.address, fee: 0x800000, tickSpacing: 60, hooks: addr };
    const feed = await ethers.getContractAt(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)'], T.WETH.feed);
    const eth = (await feed.latestRoundData())[1]; // 8 decimals
    // raw price = token1 per token0 in base units
    const num = c0 === T.WETH ? eth * 10n ** 6n : 10n ** 18n * 10n ** 8n, den = c0 === T.WETH ? 10n ** 8n * 10n ** 18n : eth * 10n ** 6n;
    const sqrtP = sqrtBig((num << 192n) / den);
    await hook.registerPool(key, payroll.address, 2000);
    const pm = await ethers.getContractAt(['function initialize((address,address,uint24,int24,address),uint160) returns (int24)'], POOL_MANAGER);
    await (await pm.initialize([key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks], sqrtP)).wait();
    const tick = Math.floor(Math.log(Number(num) / Number(den)) / Math.log(1.0001) / 60) * 60;
    await liqR.modifyLiquidity(key, { tickLower: tick - 6000, tickUpper: tick + 6000, liquidityDelta: 15n * 10n ** 14n, salt: ethers.ZeroHash }, '0x');
    console.log(`      pool WETH/USDG at ETH $${(Number(eth) / 1e8).toFixed(2)}, hook ${addr}`);
  });

  it('quotes the minimum fee split 80/20 with payroll', async () => {
    const q = await hook.quoteFee(key);
    expect([q.totalFee, q.lpFee, q.payrollFee]).to.deep.equal([500n, 400n, 100n]);
  });

  it('swaps WETH → USDG through the real PoolManager; payroll receives USDG', async () => {
    const zeroForOne = key.currency0.toLowerCase() === T.WETH.address.toLowerCase();
    const p0 = await usdg.balanceOf(payroll.address), u0 = await usdg.balanceOf(me.address);
    await swapR.swap(key, { zeroForOne, amountSpecified: -ethers.parseEther('0.5'), sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT }, { takeClaims: false, settleUsingBurn: false }, '0x');
    const got = (await usdg.balanceOf(me.address)) - u0, paid = (await usdg.balanceOf(payroll.address)) - p0;
    console.log(`      0.5 WETH → ${(Number(got) / 1e6).toFixed(2)} USDG, payroll got ${(Number(paid) / 1e6).toFixed(4)} USDG`);
    expect(got).to.be.gt(0n); expect(paid).to.be.gt(0n);
    expect(paid).to.equal((got + paid) * 100n / 1_000_000n);
  });

  it('a second swap from the same address in the same block is rejected', async () => {
    await ethers.provider.send('evm_setAutomine', [false]);
    const zeroForOne = key.currency0.toLowerCase() !== T.WETH.address.toLowerCase(); // USDG → WETH
    const s = (amt) => swapR.swap(key, { zeroForOne, amountSpecified: -amt, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT }, { takeClaims: false, settleUsingBurn: false }, '0x', { gasLimit: 1_500_000 });
    const a = await s(100_000_000n), b = await s(100_000_000n);
    await ethers.provider.send('evm_mine', []);
    await ethers.provider.send('evm_setAutomine', [true]);
    expect((await ethers.provider.getTransactionReceipt(a.hash)).status).to.equal(1);
    expect((await ethers.provider.getTransactionReceipt(b.hash)).status).to.equal(0);
  });
});
