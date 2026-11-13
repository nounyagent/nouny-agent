# Security

> **Status: beta, not independently audited.** The contracts are covered by unit, fuzz and mainnet-fork tests and an internal review, but no external audit has been done yet. Only deposit amounts you can afford to lose, and keep your vault's daily limit small.

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

Solidity 0.8.24 (`viaIR`, optimizer 200, EVM `cancun`), OpenZeppelin Contracts 5.1.0 (`SafeERC20`, `ReentrancyGuard`). External integrations: Uniswap V3 `SwapRouter02.exactInputSingle` and Chainlink `AggregatorV3Interface`.

The NOUNY website and backend are not in this repository. The backend holds the operator (bot) key, so its compromise is part of the threat model below.

## 2. Roles and trust

| Role | Powers | Trust |
|---|---|---|
| **Vault owner** (you) | Deposit; `withdraw` any token at any time (also while paused); pause; replace or revoke the operator; set limits; edit the vault's token list | Fully trusted for their own vault |
| **Operator** (NOUNY bot) | `swap` between allowed tokens through the pinned pool; trigger due payroll payments | **Untrusted.** The contracts assume its key can be stolen |
| **AgentVaultFactory admin** | `setDefaultOperator` for vaults created **afterwards**; two-step admin transfer | Cannot change tokens, oracles, staleness limits or pools, and cannot touch existing vaults |
| **PayrollFactory** | — | No admin at all |
| **Chainlink feeds** | Price for the minimum-output check and the daily cap | Trusted, with freshness and positive-price checks |
| **Uniswap router and pools** | Trade execution | Not trusted for the output amount: the vault checks its own balance before and after |

## 3. Worst case if the NOUNY bot is compromised

**Vaults.** A stolen bot key can only trade a vault's tokens against each other through the pinned pools. It can never withdraw or send funds anywhere else. Each swap must return at least the oracle value minus `maxSlippageBps`, and the total value swapped per 24 hours is capped by `dailyLimitUsd`. The worst loss per day is therefore roughly:

```
dailyLimitUsd × (maxSlippageBps + pool fee + oracle lag)
```

For example: a $1,000 daily limit, 1 % max slippage, a 0.3 % pool and up to 0.5 % oracle lag ≈ **$18 per day**, until you pause the vault or revoke the operator.

**Payroll.** The bot can only trigger payments that are due, to the addresses and amounts you set, once per interval. It cannot redirect, increase or bring forward any payment. The worst it can do is stop paying, and then anyone, including you, can call `payAllDue()`.

## 4. Guarantees (invariants)

AgentVault:

1. Only the owner can move tokens out (`withdraw`); the operator and the router cannot.
2. A successful swap delivers at least `oracleExpectedOut × (1 − maxSlippageBps / 10,000)`, whatever minimum the operator passes and whatever the router reports.
3. A swap changes vault balances by exactly `−amountIn` of `tokenIn` and `+amountOut` of `tokenOut`.
4. The oracle value of successful swaps within a 24-hour window never exceeds `dailyLimitUsd`.
5. Swaps only use the pool fee tier pinned for the pair.
6. The router approval is 0 after every swap.
7. Stale (older than `maxStaleness`), future-dated or non-positive oracle answers make `swap` revert.
8. Factory changes never alter an existing vault, and the factory's token / oracle / pool list cannot change.
9. The owner can always withdraw, including while paused or with the operator revoked.

PayrollVault:

1. Payments only go to an address the owner registered, for the amount the owner set.
2. Each recipient is paid at most once per interval: `pay` / `payAllDue` move `nextPayAt` forward by one interval per payment.
3. Only the owner can add, change or remove recipients, pause, or withdraw; the owner can withdraw at any time.

Invariants 1–4 of AgentVault are exercised by the randomized test [`test/fuzz.test.js`](../test/fuzz.test.js), which uses oracle moves, cheating routers, unauthorized callers and time jumps. Payroll limits are fuzzed in [`test/Payroll.test.js`](../test/Payroll.test.js).

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

Robinhood Stock Tokens are issued by Robinhood and may carry their own transfer rules and regional availability. The fork tests confirm that a vault contract can hold, buy and sell the 10 listed stock tokens, but those token contracts are outside this scope.

## 6. Verify it yourself

```bash
npm install
npm run build
npm test                    # unit + fuzz tests
npm run test:fork           # real Robinhood Chain pools and oracles on a local fork
npm run check               # every token, feed and pool in config/robinhood.json, on-chain
npm run verify:deployment   # deployed factories match this repository (config and bytecode)
```

## 7. Reporting a vulnerability

Please **do not** open a public issue for security problems. Report them privately through this repository's **Security → Report a vulnerability** page, with a description and, if possible, a test that reproduces the problem. We will acknowledge the report, and we will credit you if you wish once a fix is live.
