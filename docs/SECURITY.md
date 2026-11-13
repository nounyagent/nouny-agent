# NOUNY AgentVault — audit package

This document is the starting point for an independent security review. It describes the scope, the trust model, the invariants we expect to hold, and the issues already identified internally.

> The internal review below was performed by the development team (AI-assisted). It is **not** a substitute for an independent audit.

## 1. Scope

| File | nSLOC | Description |
|---|---|---|
| `contracts/AgentVault.sol` | ~223 | Per-user non-custodial vault; operator-only Uniswap V3 swaps with oracle-enforced minimum output and a daily value cap |
| `contracts/AgentVaultFactory.sol` | ~76 | Deploys one vault per wallet with a fixed token/oracle/pool list and the current default operator |
| `contracts/PayrollVault.sol` | ~140 | Per-owner payroll: owner-set recipients, amounts and intervals; anyone may trigger due payments |
| `contracts/PayrollFactory.sol` | ~30 | One payroll per wallet, fixed stablecoin, no admin |
| **Total** | **~470** | |

Out of scope: `contracts/test/Mocks.sol` (test only), the Node.js backend (`server/`), and the website. The backend holds the operator key; its compromise is part of the threat model below.

- Solidity `0.8.24`, `viaIR`, optimizer 200 runs, EVM `cancun`
- Dependencies: OpenZeppelin Contracts `5.1.0` (`SafeERC20`, `ReentrancyGuard`, `IERC20Metadata`)
- External integrations: Uniswap V3 `SwapRouter02.exactInputSingle`, Chainlink `AggregatorV3Interface`

## 2. Target deployment

**Robinhood Chain** (chain ID 4663, Arbitrum Orbit L2). Base (8453) is also supported by config.

| | Address |
|---|---|
| Uniswap V3 SwapRouter02 | `0xcaf681a66d020601342297493863e78c959e5cb2` |
| USDG (base token, fee tier 0) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` — feed USDG/USD `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2` |
| WETH (pinned pool 0.01%) | `0x0bd7d308f8e1639fab988df18a8011f41eacad73` — feed ETH/USD `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` |
| cbBTC (pinned pool 0.05%) | `0xcec185eb182c47d1ba1efc84e6959e18cd620be4` — feed CBBTC/USD `0x0009cD492adf8167f9eEBf1293556A673530a21a` |

All feeds: 8 decimals, 24h heartbeat, 0.5% deviation threshold. `maxStaleness` = 90,000 s. Addresses are verified on-chain by `npm run check:robinhood` (token symbol, feed description, freshness, and that each pinned pool exists with liquidity).

## 3. Roles and trust assumptions

| Role | Powers | Trust |
|---|---|---|
| **Vault owner** (end user) | deposit (plain transfer), `withdraw` any token any time (also when paused), `setPaused`, `setOperator` (incl. revoke with `address(0)`), `setLimits`, `setToken` / `removeToken` | Fully trusted for their own vault |
| **Operator** (NOUNY backend bot) | `swap` only, between allowed tokens, through the pinned pool | **Untrusted.** Assume the key can be stolen |
| **Factory admin** | `setDefaultOperator` (affects new vaults only), 2-step admin transfer | Cannot change tokens, feeds, staleness, pool tiers, or touch existing vaults |
| **Chainlink feeds** | price source for the minimum-output check and daily cap | Trusted, with freshness and positivity checks |
| **Uniswap router / pools** | execution | Untrusted for output amount — the vault checks its own balance delta |

### Maximum loss from a compromised operator

The operator can only trade the vault's tokens against each other through the pinned pools. Each swap must return at least `oracleValue × (1 − maxSlippageBps)`, and the total oracle value swapped per 24h window is capped by `dailyLimitUsd`. The worst case per window is therefore roughly:

```
dailyLimitUsd × (maxSlippageBps + pool fee + oracle deviation)
```

e.g. a $1,000 limit, 1% slippage, 0.01% pool fee and up to 0.5% oracle lag ≈ **$15 per day**, until the owner pauses or revokes the operator. Funds can never leave the vault except through the owner's `withdraw`.

## 4. Invariants

1. Only the owner can move tokens out of the vault (`withdraw`); the operator and router cannot.
2. A successful `swap` delivers at least `expectedOut × (1 − maxSlippageBps / 10_000)` of `tokenOut`, where `expectedOut` is derived from Chainlink prices — regardless of `minOutFromOperator` or what the router reports.
3. A swap's net effect on vault balances is exactly `−amountIn` of `tokenIn` and `+amountOut` of `tokenOut`.
4. The sum of `valueUsd` of successful swaps within a window never exceeds `dailyLimitUsd`.
5. Swaps only use the pool fee tier pinned for the pair (`max(feeTier(tokenIn), feeTier(tokenOut))`, non-zero).
6. Router approval after a swap is 0.
7. Stale (`> maxStaleness`), future-dated or non-positive oracle answers make `swap` revert.
8. Factory changes never alter an existing vault; the factory's token/oracle/pool list is immutable.
9. The owner can always withdraw, including while paused or with the operator revoked.

Invariants 1–4 are exercised by the randomized test `test/fuzz.test.js` (oracle moves, cheating routers, unauthorized callers, time jumps), including liveness (fair swaps within the limit succeed) and safety (routes > 1% below the oracle never succeed).

## 5. Internal review — findings

| ID | Severity | Title | Status |
|---|---|---|---|
| NV-01 | Medium | Operator could choose any fee tier, routing through a thin or expensive pool to bleed value on every swap | **Fixed** — tiers pinned per token; `swap` reverts unless `feeTier` equals the pinned tier |
| NV-02 | Medium | Factory admin could replace the default token/oracle list, giving new vaults a malicious price feed | **Fixed** — list fixed in the constructor; only `setDefaultOperator` remains |
| NV-03 | Low | No L2 sequencer uptime check. Robinhood Chain has no Chainlink sequencer-uptime feed | **Acknowledged** — mitigated by staleness checks; see 6.1 |
| NV-04 | Low | Fixed 24h windows: up to 2 × `dailyLimitUsd` can be swapped around a window boundary | **Acknowledged** — bounded and documented |
| NV-05 | Low | Oracle can lag the market by up to the 0.5% deviation threshold; the effective protection is `maxSlippageBps` ± 0.5% | **Acknowledged** — default slippage 1%; UI minimum 0.1% |
| NV-06 | Info | `setToken` lets the owner register any feed; a wrong feed only harms the owner's own vault | Acknowledged |
| NV-07 | Info | Ownership is not transferable; a lost owner key locks the vault's funds | Acknowledged (by design: one vault per wallet) |
| NV-08 | Info | Native ETH sent to the vault (e.g. via `selfdestruct`) cannot be recovered | Acknowledged |

## 6. Questions for auditors

1. **Oracle robustness on an Arbitrum Orbit chain without a sequencer-uptime feed.** Is `maxStaleness` = 90,000 s (24h heartbeat + buffer) acceptable, or should a tighter bound / secondary check be added?
2. **Price math.** `valueUsd = amountIn × priceIn / 10^decIn`, `expectedOut = valueUsd × 10^decOut / priceOut`. Any precision or overflow edge cases for tokens with unusual decimals (≤ 18 expected)?
3. **Daily window.** Is the fixed-window design acceptable, or should it be a rolling window?
4. **Pool manipulation.** With the minimum output tied to Chainlink, can an attacker profit from manipulating the pinned pool (e.g. sandwiching the operator) beyond `maxSlippageBps`?
5. **Token behaviour.** USDG and WETH on Robinhood Chain are upgradeable/proxy tokens. Any assumptions (balance-delta check, `forceApprove`) that could break with fee-on-transfer or rebasing behaviour?
6. **Reentrancy.** `swap` and `withdraw` are `nonReentrant`; owner setters are not. Any cross-function path through token or router callbacks?

## 7. How to build and test

```bash
cd contracts
npm ci
npx hardhat compile
npm test                                   # 21 unit tests + randomized invariant test
FUZZ_SEED=1 FUZZ_RUNS=2000 npx hardhat test test/fuzz.test.js
npm run test:fork                          # Robinhood Chain mainnet fork (real Uniswap, Chainlink, USDG)
npm run check:robinhood                    # verify deployment addresses on-chain
```

Fork tests need `ROBINHOOD_RPC_URL` (public: `https://robinhood.drpc.org`).
