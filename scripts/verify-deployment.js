// Checks the live NOUNY deployment on Robinhood Chain against this repository (read-only, no keys):
//   npm run build && npm run verify:deployment
// - AgentVaultFactory: token list, Chainlink feeds, staleness limits and pinned pool fee tiers match config/robinhood.json
// - PayrollFactory: pays in USDG
// - Hooked pools: NounyHook fee settings and pool registration, NounyLPVaultFactory and NounySwapRouter wiring
// - the deployed runtime bytecode matches the code compiled from this repo
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const cfg = require('../config/robinhood.json');
const dep = require('../deployments/robinhood.json');
const pay = require('../deployments/robinhood-payroll.json');
const hooked = require('../deployments/robinhood-hooked.json');
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'; // Uniswap v4 PoolManager on Robinhood Chain

const RPC = process.env.ROBINHOOD_RPC_URL || 'https://robinhood.drpc.org';
const p = new ethers.JsonRpcProvider(RPC, cfg.chainId, { staticNetwork: true, batchMaxCount: 1 });
let ok = true;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  ok &&= cond;
};

// Runtime bytecode compiled from this repo (artifacts/build-info, created by `npm run build`).
function compiled(name, file = name) {
  const dir = path.join(__dirname, '..', 'artifacts', 'build-info');
  if (!fs.existsSync(dir)) return null;
  // newest build first: older build-info files can still hold earlier versions of a contract
  const files = fs.readdirSync(dir).sort((x, y) => fs.statSync(path.join(dir, y)).mtimeMs - fs.statSync(path.join(dir, x)).mtimeMs);
  for (const f of files) {
    const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).output.contracts[`contracts/${file}.sol`]?.[name];
    if (c) return c.evm.deployedBytecode;
  }
  return null;
}

// Immutable values are written into the runtime code at deploy time; compare with them zeroed out.
function stripImmutables(hex, out) {
  hex = hex.replace(/^0x/, '');
  for (const refs of Object.values(out.immutableReferences || {})) {
    for (const { start, length } of refs) hex = hex.slice(0, start * 2) + '0'.repeat(length * 2) + hex.slice((start + length) * 2);
  }
  return hex;
}

async function sameCode(name, address, file) {
  const out = compiled(name, file);
  if (!out) return console.log(`SKIP  ${name} bytecode check (run "npm run build" first)`);
  const onChain = await p.getCode(address);
  check(`${name} bytecode matches this repo`, stripImmutables(onChain, out) === stripImmutables(out.object, out), address);
}

(async () => {
  console.log(`Robinhood Chain via ${RPC}\n`);
  const F = new ethers.Contract(dep.factory, [
    'function getDefaults() view returns (address, address[], address[], uint32[], uint24[])',
    'function router() view returns (address)',
  ], p);
  const [operator, tokens, feeds, staleness, tiers] = await F.getDefaults();
  check('AgentVaultFactory deployed', (await p.getCode(dep.factory)).length > 2, dep.factory);
  check('router is Uniswap V3 SwapRouter02', (await F.router()).toLowerCase() === cfg.router.toLowerCase(), cfg.router);
  check('default operator = NOUNY bot', operator.toLowerCase() === dep.operator.toLowerCase(), operator);
  check(`${cfg.tokens.length} tokens`, tokens.length === cfg.tokens.length);
  cfg.tokens.forEach((t, i) => check(
    `  ${t.symbol.padEnd(5)} token, Chainlink feed, max age ${t.maxStaleness}s, pool fee ${(t.feeTier || 0) / 10000}%`,
    tokens[i].toLowerCase() === t.address.toLowerCase() && feeds[i].toLowerCase() === t.feed.toLowerCase() &&
      Number(staleness[i]) === t.maxStaleness && Number(tiers[i]) === (t.feeTier || 0),
  ));

  const P = new ethers.Contract(pay.payrollFactory, ['function token() view returns (address)'], p);
  check('PayrollFactory pays in USDG', (await P.token()).toLowerCase() === cfg.tokens[0].address.toLowerCase(), pay.payrollFactory);

  // hooked pools (Uniswap v4)
  const [minFee, maxFee, perTick] = hooked.hookArgs;
  const H = new ethers.Contract(hooked.hook, [
    'function poolManager() view returns (address)', 'function minFee() view returns (uint24)',
    'function maxFee() view returns (uint24)', 'function feePerTick() view returns (uint24)',
    'function pools(bytes32) view returns (address owner, address payroll, uint16 shareBps, bool initialized)',
  ], p);
  check('NounyHook deployed on the v4 PoolManager', (await H.poolManager()).toLowerCase() === POOL_MANAGER, hooked.hook);
  check(`  fee ${minFee / 1e4}%–${maxFee / 1e4}%, +${perTick / 1e4}% per tick of volatility`,
    Number(await H.minFee()) === minFee && Number(await H.maxFee()) === maxFee && Number(await H.feePerTick()) === perTick);
  const flags = BigInt(hooked.hook) & ((1n << 14n) - 1n);
  check('  address flags = beforeInitialize, beforeSwap, afterSwap, afterSwapReturnDelta', flags === ((1n << 13n) | (1n << 7n) | (1n << 6n) | (1n << 2n)));
  const pool = await H.pools(hooked.poolId);
  check(`  ${hooked.pools[0].label} pool registered`, pool.initialized, hooked.poolId);
  const L = new ethers.Contract(hooked.lpFactory, ['function poolManager() view returns (address)', 'function defaultOperator() view returns (address)'], p);
  check('NounyLPVaultFactory on the v4 PoolManager', (await L.poolManager()).toLowerCase() === POOL_MANAGER, hooked.lpFactory);
  check('  default operator = NOUNY bot', (await L.defaultOperator()).toLowerCase() === hooked.operator.toLowerCase());
  const R = new ethers.Contract(hooked.router, ['function poolManager() view returns (address)'], p);
  check('NounySwapRouter on the v4 PoolManager', (await R.poolManager()).toLowerCase() === POOL_MANAGER, hooked.router);

  await sameCode('AgentVaultFactory', dep.factory);
  await sameCode('PayrollFactory', pay.payrollFactory);
  await sameCode('NounyHook', hooked.hook);
  await sameCode('NounyLPVaultFactory', hooked.lpFactory, 'NounyLPVault');
  await sameCode('NounySwapRouter', hooked.router);

  // NounyHook's "one swap per block" must use the L2 block (ArbSys), not block.number, which on Arbitrum chains is
  // the L1 block. A Hardhat fork cannot show this, so run the hook's block logic on the live chain with eth_call.
  const probe = (() => {
    const dir = path.join(__dirname, '..', 'artifacts', 'build-info');
    if (!fs.existsSync(dir)) return null;
    for (const f of fs.readdirSync(dir)) {
      const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).output.contracts['contracts/tools/L2BlockProbe.sol']?.L2BlockProbe;
      if (c) return '0x' + c.evm.bytecode.object;
    }
    return null;
  })();
  if (!probe) console.log('SKIP  L2 block check (run "npm run build" first)');
  else {
    const [codeLen, l1, l2, used] = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256', 'uint256', 'uint256'], await p.call({ data: probe }));
    check('hook block logic uses the L2 block (ArbSys)', used === l2 && l2 > 0n, `L2 ${l2} · block.number ${l1} · code at 0x64: ${codeLen} byte(s)`);
  }

  console.log(ok ? '\nDeployment matches this repository.' : '\nMISMATCH — do not trust this deployment.');
  if (!ok) process.exitCode = 1;
})().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
