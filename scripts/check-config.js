// Verifies the addresses in config/<network>.json directly on-chain (read-only, no private key).
//   npx hardhat run scripts/check-config.js --network robinhood
const { ethers, network } = require('hardhat');
const netConfig = require('./netconfig');

const ERC20 = ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'];
const FEED = ['function description() view returns (string)', 'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)'];
const ROUTER = ['function factory() view returns (address)'];
const FACTORY = ['function getPool(address,address,uint24) view returns (address)'];
const POOL = ['function liquidity() view returns (uint128)'];

async function main() {
  const cfg = netConfig(network.name);
  let ok = true;
  const p = ethers.provider;
  const chainId = Number((await p.getNetwork()).chainId);
  const now = (await p.getBlock('latest')).timestamp;
  console.log(`Network: ${cfg.name} (config ${cfg.chainId}, RPC ${chainId})`);
  if (chainId !== cfg.chainId) { console.log('FAIL  chain ID mismatch'); ok = false; }

  let factory;
  try {
    factory = await new ethers.Contract(cfg.router, ROUTER, p).factory();
    console.log(`OK    router ${cfg.router} (factory ${factory})`);
  } catch (e) {
    console.log(`FAIL  router ${cfg.router}: ${e.shortMessage || e.message}`);
    ok = false;
  }

  const stable = cfg.tokens.find((t) => t.symbol === cfg.stable);
  for (const t of cfg.tokens) {
    try {
      const tok = new ethers.Contract(t.address, ERC20, p);
      const feed = new ethers.Contract(t.feed, FEED, p);
      const [sym, dec, desc, fdec, round] = await Promise.all([tok.symbol(), tok.decimals(), feed.description(), feed.decimals(), feed.latestRoundData()]);
      const price = Number(round[1]) / 10 ** Number(fdec);
      const age = now - Number(round[3]);
      const good = sym === t.symbol && desc === t.feedDescription && age <= t.maxStaleness && price > 0;
      ok &&= good;
      let poolInfo = '';
      if (t !== stable && factory) {
        const pool = await new ethers.Contract(factory, FACTORY, p).getPool(t.address, stable.address, t.feeTier);
        const liq = pool === ethers.ZeroAddress ? 0n : await new ethers.Contract(pool, POOL, p).liquidity();
        const poolOk = liq > 0n;
        ok &&= poolOk;
        poolInfo = `, pool ${t.symbol}/${stable.symbol} ${t.feeTier / 10000}% ${poolOk ? 'exists' : 'MISSING / EMPTY'}`;
      }
      console.log(`${good ? 'OK   ' : 'FAIL '} ${t.symbol}: token=${sym} (${dec} dec), feed="${desc}" $${price.toFixed(4)}, age ${age}s (max ${t.maxStaleness}s)${poolInfo}`);
    } catch (e) {
      ok = false;
      console.log(`FAIL  ${t.symbol}: ${e.shortMessage || e.message}`);
    }
  }
  console.log(ok ? '\nAll addresses verified.' : '\nSOMETHING IS WRONG — do not deploy.');
  if (!ok) process.exitCode = 1;
}

main();
