# Security

The contracts are covered by unit, fuzz and mainnet-fork tests and an internal review. Keep your vault's daily limit small: it caps what can be traded per day.

1. [Scope](#1-scope)
2. [Roles and trust](#2-roles-and-trust)
3. [Worst case if the NOUNY bot is compromised](#3-worst-case-if-the-nouny-bot-is-compromised)
4. [Guarantees (invariants)](#4-guarantees-invariants)
5. [Known limitations](#5-known-limitations)
6. [Verify it yourself](#6-verify-it-yourself)
7. [Reporting a vulnerability](#7-reporting-a-vulnerability)

## 1. Scope

| File | Description |
|---|---|
| [`contracts/AgentVault.sol`](../contracts/AgentVault.sol) | Per-user, non-custodial trading vault. The operator may only swap through pinned Uniswap V3 pools, with a Chainlink-enforced minimum output and a daily value cap. |
| [`contracts/AgentVaultFactory.sol`](../contracts/AgentVaultFactory.sol) | One vault per wallet, with a token / oracle / pool list fixed at deployment. |
| [`contracts/PayrollVault.sol`](../contracts/PayrollVault.sol) | Per-user payroll in USDG. The owner sets recipients, amounts and intervals; anyone may trigger a payment once it is due. |
| [`contracts/PayrollFactory.sol`](../contracts/PayrollFactory.sol) | One payroll per wallet, fixed stablecoin, no admin. |
| [`contracts/NounyHook.sol`](../contracts/NounyHook.sol) | Uniswap v4 hook: volatility-based dynamic fee, one swap per block per address, optional payroll share of the fee. Cannot touch liquidity. |
| [`contracts/NounyLPVault.sol`](../contracts/NounyLPVault.sol) | Per-user liquidity vault for one v4 pool, plus its factory. The operator may only move the range, near the Chainlink price and within the owner's limits. |
| [`contracts/NounySwapRouter.sol`](../contracts/NounySwapRouter.sol) | Exact-input swap router for v4 pools with a minimum output and a deadline. No owner, holds no funds. |

AgentVault and Payroll: Solidity 0.8.24 (`viaIR`, optimizer 200, EVM `cancun`), OpenZeppelin Contracts 5.1.0 (`SafeERC20`, `ReentrancyGuard`). Hooked pools: Solidity 0.8.26 (`viaIR`, optimizer 44,444,444, EVM `cancun`), `@uniswap/v4-core` 1.0.2. External integrations: Uniswap V3 `SwapRouter02.exactInputSingle`, the Uniswap v4 `PoolManager`, and Chainlink `AggregatorV3Interface`.

The NOUNY website and backend are not in this repository. The backend holds the operator (bot) key, so its compromise is part of the threat model below.

## 2. Roles and trust

| Role | Powers | Trust |
|---|---|---|
| **Vault owner** (you) | Deposit; `withdraw` any token at any time (also while paused); pause; replace or revoke the operator; set limits; edit the vault's token list | Fully trusted for their own vault |
| **Operator** (NOUNY bot) | `swap` between allowed tokens through the pinned pool; trigger due payroll payments | **Untrusted.** The contracts assume its key can be stolen |
| **AgentVaultFactory admin** | `setDefaultOperator` for vaults created **afterwards**; two-step admin transfer | Cannot change tokens, oracles, staleness limits or pools, and cannot touch existing vaults |
| **PayrollFactory** | — | No admin at all |
| **Chainlink feeds** | Price for the minimum-output check and the daily cap | Trusted, with freshness and positive-price checks |
| **LP vault owner** (you) | Deposit; `exit` and `withdraw` at any time (also while paused); pause; replace or revoke the operator; set range and oracle limits; rebalance | Fully trusted for their own LP vault |
| **Operator on an LP vault** (NOUNY bot) | `rebalance` only: move the range, within the owner's limits, near the oracle price, once per interval | **Untrusted** |
| **Hooked pool owner** | `setPayroll` (up to 50 % of the swap fee to a payroll address) and `setOwner` | Cannot change the fee formula, block swaps or touch liquidity. The swapper's total fee does not change; LPs give up the payroll share |
| **NounyLPVaultFactory admin** | `setDefaultOperator` for vaults created **afterwards** | Cannot touch existing LP vaults |
| **Uniswap router and pools** | Trade execution | Not trusted for the output amount: the vault checks its own balance before and after |

## 3. Worst case if the NOUNY bot is compromised

**Vaults.** A stolen bot key can only swap a vault's tokens against USDG through the pinned pools. It can never withdraw or send funds anywhere else. Each swap must return at least the oracle value minus `maxSlippageBps`, and the total value swapped per 24 hours is capped by `dailyLimitUsd`. The worst loss per day is therefore roughly:

```
dailyLimitUsd × (maxSlippageBps + pool fee + oracle lag)
```

For example: a $1,000 daily limit, 1 % max slippage, a 0.3 % pool and up to 0.5 % oracle lag ≈ **$18 per day**, until you pause the vault or revoke the operator.

**Payroll.** The bot can only trigger payments that are due, to the addresses and amounts you set, once per interval. It cannot redirect, increase or bring forward any payment. The worst it can do is stop paying, and then anyone, including you, can call `payAllDue()`.

**LP vaults.** A stolen bot key can only call `rebalance`. It can never withdraw or send tokens out. Each rebalance must keep the current price inside the new range, use a width within your `[minWidth, maxWidth]`, happen when the pool price is within `maxDeviationBps` of Chainlink, and wait `minInterval` since the last one. The worst it can do is place the range badly within those bounds (for example always at the narrowest width), which lowers fees and can increase impermanent loss, until you pause the vault, revoke the operator or `exit`.

## 4. Guarantees (invariants)

AgentVault:

1. Only the owner can move tokens out (`withdraw`); the operator and the router cannot.
2. A successful swap delivers at least `oracleExpectedOut × (1 − maxSlippageBps / 10,000)`, whatever minimum the operator passes and whatever the router reports.
3. A swap changes vault balances by exactly `−amountIn` of `tokenIn` and `+amountOut` of `tokenOut`.
4. The oracle value of successful swaps within a 24-hour window never exceeds `dailyLimitUsd`.
5. Swaps are always against the base token (USDG) and only use the pool fee tier pinned for the token.
6. The router approval is 0 after every swap.
7. Stale (older than `maxStaleness`), future-dated or non-positive oracle answers make `swap` revert. Registering a token only needs the feed to answer a positive price, so vaults can be created while stock feeds pause at weekends.
8. Factory changes never alter an existing vault, and the factory's token / oracle / pool list cannot change.
9. The owner can always withdraw, including while paused or with the operator revoked.

PayrollVault:

1. Payments only go to an address the owner registered, for the amount the owner set.
2. Each recipient is paid at most once per interval: `pay` / `payAllDue` move `nextPayAt` forward by one interval per payment.
3. Only the owner can add, change or remove recipients, pause, or withdraw; the owner can withdraw at any time.
4. At most 100 recipients are active at once; removing one frees its place.
5. In `payAllDue`, a recipient whose transfer fails (for example an address frozen by the token issuer) is skipped with `PaymentFailed` and its period stays due; the others are still paid.

NounyLPVault:

1. Only the owner can move tokens out (`withdraw`); the operator, the factory and the pool cannot.
2. An operator rebalance reverts unless the pool price is within `maxDeviationBps` of the Chainlink price, the current tick is inside the new range, the width is within `[minWidth, maxWidth]`, the vault is not paused and `minInterval` has passed.
3. Stale, future-dated or non-positive oracle answers make an operator rebalance revert.
4. The owner can always `exit` and `withdraw`, including while paused, with the operator revoked, or with a broken oracle.

NounyHook:

1. The fee is always between `minFee` and `maxFee` and is computed on-chain; nobody can set it by hand.
2. An address can swap at most once per L2 block in a hooked pool.
3. The payroll share is at most 50 % of the fee, and only the pool owner can change it. If the payroll address cannot receive, the share is skipped (`PayrollSkipped`) and the swap goes through.
4. Only the address that registered a pool can initialize it.

Invariants 1–4 of AgentVault are exercised by the randomized test [`test/fuzz.test.js`](../test/fuzz.test.js), which uses oracle moves, cheating routers, unauthorized callers and time jumps. Payroll limits are fuzzed in [`test/Payroll.test.js`](../test/Payroll.test.js). The hooked-pool rules are tested against a local v4 PoolManager in [`test/NounyHook.test.js`](../test/NounyHook.test.js), [`test/NounyLPVault.test.js`](../test/NounyLPVault.test.js) and [`test/NounySwapRouter.test.js`](../test/NounySwapRouter.test.js), and against the real PoolManager on a fork in [`test/hook-fork.test.js`](../test/hook-fork.test.js).

## 5. Known limitations

| ID | Severity | Issue | Status |
|---|---|---|---|
| NV-01 | Medium | The operator could pick any fee tier and route through a thin pool | **Fixed**: the tier is pinned per token |
| NV-02 | Medium | The factory admin could swap the oracle list for new vaults | **Fixed**: the list is fixed at deployment |
| NV-03 | Low | Robinhood Chain has no Chainlink L2 sequencer-uptime feed | Acknowledged: mitigated by staleness checks |
| NV-04 | Low | Fixed 24 h windows: up to 2 × `dailyLimitUsd` can be swapped around a window boundary | Acknowledged |
| NV-05 | Low | Oracles can lag the market by up to their 0.5 % deviation threshold, so effective protection is `maxSlippageBps` ± 0.5 % | Acknowledged |
| NV-06 | Info | `setToken` lets the owner register any feed; a wrong feed only affects the owner's own vault | Acknowledged |
| NV-07 | Info | Vault and payroll ownership cannot be transferred; a lost owner key locks the funds | By design |
| NV-08 | Info | Native ETH force-sent to a vault cannot be recovered | Acknowledged |
| NV-09 | Info | Stock-token oracles follow US equities 24/5 and pause on weekends; stock swaps revert until they update | By design: safer than trading on a frozen price |
| NV-10 | Info | Uniswap pools on Robinhood Chain are small (about $20k–$400k), so large swaps hit the slippage guard | Acknowledged: keep sizes small |
| NV-11 | Low | Payroll: if the keeper is offline for several intervals, missed periods are paid one per call afterwards (catch-up), never more than owed | By design |
| NV-12 | Low | The one-swap-per-block rule is keyed on `tx.origin`: it limits each signing address, not a set of addresses controlled by one party, and users of a shared relayer share one limit | Acknowledged |
| NV-13 | Low | Liquidity providers carry impermanent loss; the agent moving the range does not remove it | By design: explained in the user guide |
| NV-14 | Info | The hook's fee settings (`minFee`, `maxFee`, `feePerTick`) are immutable; changing them needs a new hook and pool | By design |
| NV-15 | Info | LP vaults and the swap router do not support native ETH; the pool uses WETH | By design |
| NV-16 | Info | LP vault ownership cannot be transferred; a lost owner key locks the funds | By design |

### Independent security review by HEY Research Lab (commit `0e1396a`, 16 Nov 2026)

[HEY Research Lab](https://heyresearch.xyz) reviewed AgentVault, AgentVaultFactory, PayrollVault, PayrollFactory, NounyHook, NounySwapRouter, NounyLPVault and its factory at commit `0e1396a`. This is an independent security review, not an audit. It found no critical, high or medium issues; the main claims held (the vault bot cannot move value out, payroll only pays registered recipients when due, and the five deployed contracts matched the commit).

All findings below are fixed in this repository. Because deployed contracts cannot be changed, the fixed AgentVaultFactory, PayrollFactory, NounyHook (with a new WETH / USDG pool) and NounyLPVaultFactory were redeployed on 16 Nov 2026 (addresses in the [README](../README.md)); NounySwapRouter did not change. HEY Research Lab re-tested commit `e79bca2` and the new deployments on 17 Nov 2026. The three low-severity findings are fixed, eight notes are fixed and I-7 is mitigated. Independent security review, not an audit.

| ID | Severity | Issue | Status |
|---|---|---|---|
| L-1 | Low | New AgentVaults could not be created for ~27–30 h each weekend: registering a token required a fresh price, and stock feeds pause | **Fixed**: registration only checks that the feed answers a positive price; `swap` still rejects stale prices |
| L-2 | Low | Removed payroll recipients still counted toward the 100 cap | **Fixed**: the cap counts active recipients; a separate bound of 1,000 records keeps `payAllDue` within gas |
| L-3 | Low | NounyHook's one-swap-per-block used the L1 block on Robinhood Chain (ArbSys holds code `0xfe`, which skipped the call) | **Fixed**: always asks ArbSys; `verify:deployment` now checks the live L2 block logic |
| I-1 | Info | Token-to-token swaps could route through a pool a compromised bot creates at the pinned tier | **Fixed**: every swap must be against the base token (USDG) |
| I-2 | Info | USDG feed heartbeat (24 h) close to its 25 h staleness limit | **Fixed**: USDG limit raised to 27 h in `config/robinhood.json` |
| I-3 | Info | Unpausing a payroll lets every missed period be paid | **Fixed**: `resumeAndSkipMissed()` resumes without paying them; plain unpause keeps the catch-up behaviour (NV-11) |
| I-4 | Info | One reverting transfer stopped `payAllDue` for everyone | **Fixed**: per-recipient skip with `PaymentFailed` |
| I-5 | Info | Anyone who registered a pool key first became its owner | **Fixed**: only the registrant can initialize the pool |
| I-6 | Info | A payroll address that cannot receive blocked one swap direction | **Fixed**: the share is skipped instead |
| I-7 | Info | LP rebalance has no minimum amounts and `minInterval` could be 0 | **Mitigated**: at least 15 minutes between agent moves; a rebalance still has no minimum amounts, which stay bounded by the oracle band |
| I-8 | Info | LP factory had no admin transfer; LP `withdraw` accepted `to = 0` | **Fixed**: two-step admin transfer; zero address rejected |
| I-9 | Info | An old, empty vault (`0x2a07…AaF11`) still names the bot as operator | **Fixed**: the owner removed the operator on 17 Nov 2026 ([tx](https://robinhoodchain.blockscout.com/tx/0xd9f6776195697137c7967d0fd708eaf7c5f035d426b7bc533ac6805cf35e50e3)) |

The regression tests are in [`test/Review.test.js`](../test/Review.test.js).

Robinhood Stock Tokens are issued by Robinhood and may carry their own transfer rules and regional availability. The fork tests confirm that a vault contract can hold, buy and sell the 10 listed stock tokens, but those token contracts are outside this scope.

## 6. Verify it yourself

```bash
npm install
npm run build
npm test                    # unit + fuzz tests
npm run test:fork           # real Robinhood Chain pools and oracles on a local fork
npm run check               # every token, feed and pool in config/robinhood.json, on-chain
npm run verify:deployment   # deployed contracts match this repository (config and bytecode)
```

## 7. Reporting a vulnerability

Please **do not** open a public issue for security problems. Report them privately through this repository's **Security → Report a vulnerability** page, with a description and, if possible, a test that reproduces the problem. We will acknowledge the report, and we will credit you if you wish once a fix is live.
