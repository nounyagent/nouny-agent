// Randomized (fuzz) test: hundreds of random actions — oracle price moves, cheating routers, time jumps,
// unauthorized callers — while checking the vault's core invariants after every step:
//   1. A successful swap never returns less than the oracle-based minimum (price × (1 − maxSlippage)).
//   2. Vault balances change only by exactly the swap's input/output; nothing else leaks out.
//   3. Nobody but the operator can swap, and nobody but the owner can withdraw.
//   4. Total swap value inside a 24h window never exceeds the daily limit.
//   5. The owner can always withdraw everything at the end.
// Seeded, so failures are reproducible: FUZZ_SEED=123 FUZZ_RUNS=1000 npx hardhat test test/fuzz.test.js
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');

const SEED = Number(process.env.FUZZ_SEED || 20261114);
const RUNS = Number(process.env.FUZZ_RUNS || 300);

function prng(seed) { // mulberry32
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe(`AgentVault fuzz (seed ${SEED}, ${RUNS} steps)`, function () {
  if (process.env.FORK) return;

  it('invariants hold under random actions', async () => {
    const rnd = prng(SEED);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const [admin, owner, operator, stranger] = await ethers.getSigners();
    const dep = async (n, ...a) => { const c = await ethers.deployContract(n, a); await c.waitForDeployment(); return c; };

    const usdc = await dep('MockToken', 'USD', 'USD', 6);
    const weth = await dep('MockToken', 'WETH', 'WETH', 18);
    const fUsd = await dep('MockFeed', 8, 1_0000_0000n);
    let ethPrice = 2000;
    const fEth = await dep('MockFeed', 8, BigInt(Math.round(ethPrice * 1e8)));
    const router = await dep('MockRouter');
    await usdc.mint(router, 10n ** 18n);
    await weth.mint(router, 10n ** 30n);

    const SLIP = 100n; // 1%
    const LIMIT = 50_000n * 10n ** 18n;
    const factory = await dep('AgentVaultFactory', await router.getAddress(), operator.address,
      [await usdc.getAddress(), await weth.getAddress()], [await fUsd.getAddress(), await fEth.getAddress()], [86400, 7200], [0, 500]);
    await factory.connect(owner).createVault(SLIP, LIMIT);
    const vault = await ethers.getContractAt('AgentVault', await factory.vaultOf(owner.address));
    await usdc.mint(vault, 100_000n * 10n ** 6n);
    await weth.mint(vault, 20n * 10n ** 18n);

    const bal = { usdc: await usdc.balanceOf(vault), weth: await weth.balanceOf(vault) };
    let windowStart = 0, windowUsed = 0n;
    const stats = { ok: 0, rejectedPrice: 0, rejectedLimit: 0, unauthorized: 0, cheats: 0 };

    const setRates = async (factor) => { // router rate = fair × factor (factor < 1 means the pool/router cheats)
      const f = BigInt(Math.round(factor * 1e6));
      // 1 USDC unit (1e-6 USD) buys 1e12/price wei; scaled ×1e18 -> 1e30/price = 1e38/priceE8
      const usdToEth = 10n ** 38n / BigInt(Math.round(ethPrice * 1e8));
      await router.setRate(usdc, weth, (usdToEth * f) / 1_000_000n);
      const ethToUsd = (BigInt(Math.round(ethPrice * 1e8)) * 10n ** 18n) / 10n ** 20n; // USDC units per 1 wei, ×1e18
      await router.setRate(weth, usdc, (ethToUsd * f) / 1_000_000n);
    };

    for (let step = 0; step < RUNS; step++) {
      // time passes; the oracle moves up to ±3% and refreshes
      await time.increase(Math.floor(rnd() * 3 * 3600));
      ethPrice *= 1 + (rnd() - 0.5) * 0.06;
      const now = await time.latest();
      await fEth.set(BigInt(Math.round(ethPrice * 1e8)), now);
      await fUsd.set(1_0000_0000n, now);

      const action = rnd();
      if (action < 0.08) { // unauthorized callers
        const who = pick([stranger, owner, admin]);
        await expect(vault.connect(who).swap(usdc, weth, 500, 1n, 0)).to.be.reverted;
        if (who !== owner) await expect(vault.connect(who).withdraw(usdc, 1n, who.address)).to.be.reverted;
        stats.unauthorized++;
        continue;
      }

      // operator swap with a random router quality: mostly fair, sometimes cheating by up to 10%
      const cheat = rnd() < 0.3;
      const factor = cheat ? 1 - rnd() * 0.1 : 1 + rnd() * 0.005;
      if (cheat) stats.cheats++;
      await setRates(factor);
      const buy = rnd() < 0.5; // USDC -> WETH
      const [tin, tout, kin, kout] = buy ? [usdc, weth, 'usdc', 'weth'] : [weth, usdc, 'weth', 'usdc'];
      if (bal[kin] === 0n) continue;
      const amountIn = (bal[kin] * BigInt(Math.floor(rnd() * 400) + 1)) / 1000n; // 0.1%–40% of balance

      // expected oracle minimum (same math as the contract)
      const pIn = buy ? 10n ** 18n : BigInt(Math.round(ethPrice * 1e8)) * 10n ** 10n;
      const pOut = buy ? BigInt(Math.round(ethPrice * 1e8)) * 10n ** 10n : 10n ** 18n;
      const dIn = buy ? 6n : 18n, dOut = buy ? 18n : 6n;
      const valueUsd = (amountIn * pIn) / 10n ** dIn;
      const minOut = (((valueUsd * 10n ** dOut) / pOut) * (10_000n - SLIP)) / 10_000n;

      const nowTs = BigInt(await time.latest()) + 1n;
      const windowExpired = nowTs >= BigInt(windowStart) + 86400n;
      const usedBefore = windowExpired ? 0n : windowUsed;

      const beforeIn = await tin.balanceOf(vault), beforeOut = await tout.balanceOf(vault);
      let ok = true;
      try { await vault.connect(operator).swap(tin, tout, 500, amountIn, 0); } catch { ok = false; }
      const afterIn = await tin.balanceOf(vault), afterOut = await tout.balanceOf(vault);

      if (ok) {
        const got = afterOut - beforeOut;
        expect(got >= minOut, `step ${step}: got ${got} < oracle minimum ${minOut}`).to.equal(true); // invariant 1
        expect(beforeIn - afterIn).to.equal(amountIn); // invariant 2
        bal[kin] -= amountIn; bal[kout] += got;
        if (windowExpired) { windowStart = Number(nowTs); windowUsed = 0n; }
        windowUsed += valueUsd;
        expect(windowUsed <= LIMIT, `step ${step}: daily limit exceeded`).to.equal(true); // invariant 4
        stats.ok++;
      } else {
        expect(afterIn).to.equal(beforeIn); // a failed swap moves nothing
        expect(afterOut).to.equal(beforeOut);
        if (usedBefore + valueUsd > LIMIT) stats.rejectedLimit++; else stats.rejectedPrice++;
      }
      const withinLimit = usedBefore + valueUsd <= LIMIT;
      // liveness: a fair route within the daily limit must go through
      if (!cheat && withinLimit) expect(ok, `step ${step}: fair swap was rejected`).to.equal(true);
      // safety: a route more than 1% worse than the oracle must never go through
      if (factor < 0.989) expect(ok, `step ${step}: swap ${((1 - factor) * 100).toFixed(2)}% below oracle went through`).to.equal(false);
      expect(await usdc.balanceOf(vault)).to.equal(bal.usdc); // invariant 2 (global)
      expect(await weth.balanceOf(vault)).to.equal(bal.weth);
    }

    // invariant 5: the owner can always take everything out
    await vault.connect(owner).setPaused(true);
    await vault.connect(owner).withdraw(usdc, bal.usdc, owner.address);
    await vault.connect(owner).withdraw(weth, bal.weth, owner.address);
    expect(await usdc.balanceOf(vault)).to.equal(0n);
    expect(await weth.balanceOf(vault)).to.equal(0n);
    console.log(`      swaps ok ${stats.ok}, rejected (price) ${stats.rejectedPrice}, rejected (limit) ${stats.rejectedLimit}, unauthorized attempts ${stats.unauthorized}, cheating rounds ${stats.cheats}`);
    expect(stats.ok).to.be.greaterThan(RUNS / 4);
    expect(stats.rejectedPrice).to.be.greaterThan(0);
  });
});
