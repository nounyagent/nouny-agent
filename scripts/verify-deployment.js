// Checks the live NOUNY deployment on Robinhood Chain against this repository (read-only, no keys):
//   npm run build && npm run verify:deployment
// - AgentVaultFactory: token list, Chainlink feeds, staleness limits and pinned pool fee tiers match config/robinhood.json
// - PayrollFactory: pays in USDG
// - the deployed runtime bytecode matches the code compiled from this repo
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const cfg = require('../config/robinhood.json');
const dep = require('../deployments/robinhood.json');
const pay = require('../deployments/robinhood-payroll.json');

const RPC = process.env.ROBINHOOD_RPC_URL || 'https://robinhood.drpc.org';
const p = new ethers.JsonRpcProvider(RPC, cfg.chainId, { staticNetwork: true, batchMaxCount: 1 });
let ok = true;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  ok &&= cond;
};

// Runtime bytecode compiled from this repo (artifacts/build-info, created by `npm run build`).
function compiled(name) {
  const dir = path.join(__dirname, '..', 'artifacts', 'build-info');
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).output.contracts[`contracts/${name}.sol`]?.[name];
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

async function sameCode(name, address) {
  const out = compiled(name);
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

  await sameCode('AgentVaultFactory', dep.factory);
  await sameCode('PayrollFactory', pay.payrollFactory);

  console.log(ok ? '\nDeployment matches this repository.' : '\nMISMATCH — do not trust this deployment.');
  if (!ok) process.exitCode = 1;
})().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
