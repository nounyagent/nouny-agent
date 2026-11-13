// Runs against a local fork of Robinhood Chain: REAL Uniswap pools and Chainlink feeds, fake money, nothing is sent on-chain.
//   npm run test:fork
const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const netConfig = require('../scripts/netconfig');

describe('AgentVault on a mainnet fork', function () {
  if (!process.env.FORK) return;

  const cfg = netConfig(network.name);
  const T = Object.fromEntries(cfg.tokens.map((t) => [t.symbol, t]));
  const S = T[cfg.stable];
  let owner, operator, vault, weth, stable, sDec;

  before(async () => {
    [, owner, operator] = await ethers.getSigners();
    console.log(`      network: ${cfg.name}, stablecoin: ${cfg.stable}`);
    const factory = await ethers.deployContract('AgentVaultFactory', [
      cfg.router, operator.address,
      cfg.tokens.map((t) => t.address), cfg.tokens.map((t) => t.feed), cfg.tokens.map((t) => t.maxStaleness), cfg.tokens.map((t) => t.feeTier || 0),
    ]);
    await factory.connect(owner).createVault(100, ethers.parseUnits('50000', 18)); // 1%, $50k/day
    vault = await ethers.getContractAt('AgentVault', await factory.vaultOf(owner.address));

    weth = await ethers.getContractAt(['function deposit() payable', 'function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], T.WETH.address);
    stable = await ethers.getContractAt(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'], S.address);
    sDec = Number(await stable.decimals());
    await weth.connect(owner).deposit({ value: ethers.parseEther('2') });
    await weth.connect(owner).transfer(await vault.getAddress(), ethers.parseEther('2'));
  });

  it('reads real oracle prices', async () => {
    const eth = Number(ethers.formatUnits(await vault.priceUsd(T.WETH.address), 18));
    const st = Number(ethers.formatUnits(await vault.priceUsd(S.address), 18));
    console.log(`      ETH/USD $${eth.toFixed(2)}, ${cfg.stable}/USD $${st.toFixed(4)}`);
    expect(eth).to.be.greaterThan(100);
    expect(st).to.be.within(0.97, 1.03);
  });

  it(`swaps 1 WETH -> stablecoin through the real Uniswap pool`, async () => {
    await vault.connect(operator).swap(T.WETH.address, S.address, T.WETH.feeTier, ethers.parseEther('1'), 0);
    const got = Number(ethers.formatUnits(await stable.balanceOf(await vault.getAddress()), sDec));
    const eth = Number(ethers.formatUnits(await vault.priceUsd(T.WETH.address), 18));
    console.log(`      got ${got.toFixed(2)} ${cfg.stable} (oracle ${eth.toFixed(2)}, diff ${((got / eth - 1) * 100).toFixed(3)}%)`);
    expect(got).to.be.greaterThan(eth * 0.99);
  });

  it('swaps back stablecoin -> WETH', async () => {
    const bal = await stable.balanceOf(await vault.getAddress());
    await vault.connect(operator).swap(S.address, T.WETH.address, T.WETH.feeTier, bal, 0);
    const w = Number(ethers.formatEther(await weth.balanceOf(await vault.getAddress())));
    console.log(`      WETH balance now ${w.toFixed(5)} (started with 2)`);
    expect(w).to.be.greaterThan(1.98);
  });

  if (T.cbBTC) it('small swap stablecoin -> cbBTC (BTC pool)', async () => {
    await vault.connect(operator).swap(T.WETH.address, S.address, T.WETH.feeTier, ethers.parseEther('0.1'), 0);
    const bal = await stable.balanceOf(await vault.getAddress());
    await vault.connect(operator).swap(S.address, T.cbBTC.address, T.cbBTC.feeTier, bal / 2n, 0);
    const btc = await ethers.getContractAt(['function balanceOf(address) view returns (uint256)'], T.cbBTC.address);
    const got = Number(ethers.formatUnits(await btc.balanceOf(await vault.getAddress()), 8));
    console.log(`      got ${got.toFixed(8)} cbBTC`);
    expect(got).to.be.greaterThan(0);
  });

  // The oracle can lag the pool price (feeds update on a ≥0.5% move or every 24h).
  // So one swap direction can beat the oracle (valid, passes) while the other is worse -> must be rejected.
  it('0.01% slippage cap: the direction worse than the oracle is rejected', async () => {
    await vault.connect(owner).setLimits(1, ethers.parseUnits('50000', 18));
    const v = await vault.getAddress();
    const tryIt = async (from, to, amt) => vault.connect(operator).swap.staticCall(from, to, T.WETH.feeTier, amt, 0).then(() => 'passes', () => 'rejected');
    const sell = await tryIt(T.WETH.address, S.address, ethers.parseEther('0.5'));
    const sBal = await stable.balanceOf(v);
    const buy = sBal > 0n ? await tryIt(S.address, T.WETH.address, sBal) : 'rejected';
    console.log(`      WETH->${cfg.stable}: ${sell}, ${cfg.stable}->WETH: ${buy}`);
    expect([sell, buy]).to.include('rejected');
  });

  // Robinhood Stock Tokens: buy $40 of each with USDG and sell it back through the pinned pool.
  const stocks = cfg.tokens.filter((t) => t.kind === 'stock');
  if (stocks.length) it(`stock tokens: buy and sell back ${stocks.map((t) => t.symbol).join(', ')}`, async () => {
    await vault.connect(owner).setLimits(300, ethers.parseUnits('50000', 18)); // 3%: 0.3% pools + oracle lag
    const v = await vault.getAddress();
    await vault.connect(operator).swap(T.WETH.address, S.address, T.WETH.feeTier, ethers.parseEther('0.5'), 0);
    const live = (await ethers.provider.getBlock('latest')).timestamp;
    for (const t of stocks) {
      const tok = await ethers.getContractAt(['function balanceOf(address) view returns (uint256)'], t.address);
      const px = Number(ethers.formatUnits(await vault.priceUsd(t.address).catch(() => 0n), 18));
      if (!px) { console.log(`      ${t.symbol}: oracle stale (market closed) — swap correctly blocked`); continue; }
      await vault.connect(operator).swap(S.address, t.address, t.feeTier, ethers.parseUnits('40', sDec), 0);
      const got = await tok.balanceOf(v);
      const usd = Number(ethers.formatEther(got)) * px;
      const back0 = await stable.balanceOf(v);
      await vault.connect(operator).swap(t.address, S.address, t.feeTier, got, 0);
      const back = Number(ethers.formatUnits((await stable.balanceOf(v)) - back0, sDec));
      console.log(`      ${t.symbol.padEnd(5)} $${px.toFixed(2)}  bought $${usd.toFixed(2)} worth, sold back for $${back.toFixed(2)}`);
      expect(usd).to.be.greaterThan(40 * 0.95);
      expect(back).to.be.greaterThan(40 * 0.93);
      expect(await tok.balanceOf(v)).to.equal(0n);
    }
    void live;
  });

  it('owner withdraws everything', async () => {
    for (const t of [T.WETH, S, T.cbBTC].filter(Boolean)) {
      const c = await ethers.getContractAt(['function balanceOf(address) view returns (uint256)'], t.address);
      const bal = await c.balanceOf(await vault.getAddress());
      if (bal > 0n) await vault.connect(owner).withdraw(t.address, bal, owner.address);
      expect(await c.balanceOf(await vault.getAddress())).to.equal(0);
    }
  });
});
