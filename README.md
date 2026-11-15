<p align="center"><img src="assets/logo.svg" alt="NOUNY" width="96"></p>

<h1 align="center">NOUNY Agent</h1>

<p align="center">
No-code trading agents for crypto and tokenized stocks, on-chain payroll and hooked Uniswap v4 pools, on <b>Robinhood Chain</b>.<br>
Your funds stay in a vault that <b>only you</b> control.
</p>

<p align="center">
<a href="https://nounyagent.com">Open the app</a> ·
<a href="https://nounyagent.com/docs">Website docs</a> ·
<a href="docs/USER-GUIDE.md">User guide</a> ·
<a href="docs/CONTRACTS.md">Contracts</a> ·
<a href="docs/SECURITY.md">Security</a> ·
<a href="https://x.com/nounyagent">X</a>
</p>

---

## What you can do

| Feature | What it is | Money |
|---|---|---|
| **Paper agents** | Build an agent (momentum, mean reversion or moving-average crossover), backtest it on real prices and let it run every hour. | Virtual $10,000 |
| **Live agents** | The same agent trades **your own on-chain vault** through Uniswap on Robinhood Chain: ETH, BTC and 10 Robinhood Stock Tokens against USDG. | Real (USDG) |
| **Payroll** | A payroll vault that pays salaries in USDG automatically — weekly, every 2 weeks or monthly. | Real (USDG) |
| **Swap** | Swap WETH ↔ USDG on the Pools page through Uniswap V3, at the best of its fee tiers for your amount. No NOUNY fee. | Real (WETH, USDG) |
| **Hooked pool** | A WETH / USDG Uniswap v4 pool whose fee follows volatility. Open an **LP vault** that the agent keeps in range. | Real (WETH, USDG) |

Each feature has its own page on the website: [Agents](https://nounyagent.com/agents) · [Markets](https://nounyagent.com/markets) · [Pools](https://nounyagent.com/pools) · [Payroll](https://nounyagent.com/payroll) · [Leaderboard](https://nounyagent.com/leaderboard) · [$NOUNY](https://nounyagent.com/token).

Markets for agents: crypto (BTC, ETH, SOL, …), perpetuals (paper only) and stocks — **AAPL, NVDA, TSLA, MSFT, AMZN, GOOGL, META, SPY, QQQ, COIN**.

## Quick start

1. Open **[the app](https://nounyagent.com)** and click **Connect wallet** (MetaMask, OKX Wallet, Rabby, Coinbase Wallet…). You only sign a message — no transaction, no fee.
2. In **[Agent Studio](https://nounyagent.com/agents)**, name an agent, pick a strategy and a market, and click **Backtest & launch**. It starts in **paper** mode.
3. For real money: create your **vault**, deposit **USDG** on Robinhood Chain and create an agent in **Live** mode.
4. To swap WETH ↔ USDG (through Uniswap V3) or provide liquidity to the hooked pool, open **[Pools](https://nounyagent.com/pools)**.

Step-by-step instructions, with what each button does: **[docs/USER-GUIDE.md](docs/USER-GUIDE.md)**.

## Contracts (Robinhood Chain, chain ID 4663)

| Contract | Address | Role |
|---|---|---|
| **AgentVaultFactory** | [`0x0315841Ff9eC63321Faa050e937FD8402053C090`](https://robinhoodchain.blockscout.com/address/0x0315841Ff9eC63321Faa050e937FD8402053C090) | Creates one `AgentVault` per wallet with a fixed token / oracle / pool list |
| **PayrollFactory** | [`0xeD9cE03E385554Bc829879EBa77cCBC1DeDce5bD`](https://robinhoodchain.blockscout.com/address/0xeD9cE03E385554Bc829879EBa77cCBC1DeDce5bD) | Creates one `PayrollVault` per wallet, pays in USDG, no admin |
| NOUNY bot (operator) | [`0x0Ea4979Ebc035Dc08eE8Fa3D9B19e665720141E2`](https://robinhoodchain.blockscout.com/address/0x0Ea4979Ebc035Dc08eE8Fa3D9B19e665720141E2) | May only **swap inside** vaults and **trigger** due payroll payments |
| **NounyHook** | [`0xB4aaB55e82646A63fD2774405c0356Da4652a0C4`](https://robinhoodchain.blockscout.com/address/0xB4aaB55e82646A63fD2774405c0356Da4652a0C4) | Uniswap v4 hook of the WETH / USDG hooked pool: dynamic fee, one swap per block per address, optional payroll share |
| **NounyLPVaultFactory** | [`0x804a52aDbF958FaAd15884C20A2fFE157A94c6eE`](https://robinhoodchain.blockscout.com/address/0x804a52aDbF958FaAd15884C20A2fFE157A94c6eE) | Creates one `NounyLPVault` per wallet and pool; new vaults get the NOUNY bot as operator |
| **NounySwapRouter** | [`0x184F6B10f518e0D334962c1AB9C20B993A2dAcb9`](https://robinhoodchain.blockscout.com/address/0x184F6B10f518e0D334962c1AB9C20B993A2dAcb9) | Exact-input swaps in hooked pools, with a minimum output and a deadline |
| Uniswap v4 PoolManager | [`0x8366a39cc670b4001a1121b8f6a443a643e40951`](https://robinhoodchain.blockscout.com/address/0x8366a39cc670b4001a1121b8f6a443a643e40951) | Holds the hooked pool's liquidity |
| Uniswap V3 SwapRouter02 | [`0xcaf681a66d020601342297493863e78c959e5cb2`](https://robinhoodchain.blockscout.com/address/0xcaf681a66d020601342297493863e78c959e5cb2) | The only router a vault swaps through |

Your own `AgentVault`, `PayrollVault` and `NounyLPVault` addresses are shown in the app and returned by `vaultOf(yourWallet)` / `payrollOf(yourWallet)` / `vaultOf(yourWallet, poolId)` on the factories.

> Deprecated: AgentVaultFactory `0x2bD4C69999C1eD04a9FAd6F3Fbae3904CCf0421E` (crypto only, replaced when stock tokens were added). Vaults created there still belong to their owners and can be withdrawn at any time.

### Tokens, oracles and pools

Every vault created by the factory above accepts exactly these tokens. Prices come from Chainlink; each token trades through one pinned Uniswap V3 pool against USDG.

| Token | Kind | Token contract | Chainlink feed | Uniswap V3 pool vs USDG |
|---|---|---|---|---|
| USDG | stablecoin | [0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168](https://robinhoodchain.blockscout.com/address/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168) | [0x61B7e5650328764B076A108EFF5fa7282a1B9aD2](https://robinhoodchain.blockscout.com/address/0x61B7e5650328764B076A108EFF5fa7282a1B9aD2) | — |
| WETH | crypto | [0x0bd7d308f8e1639fab988df18a8011f41eacad73](https://robinhoodchain.blockscout.com/address/0x0bd7d308f8e1639fab988df18a8011f41eacad73) | [0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9](https://robinhoodchain.blockscout.com/address/0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9) | 0.01% |
| cbBTC | crypto | [0xcec185eb182c47d1ba1efc84e6959e18cd620be4](https://robinhoodchain.blockscout.com/address/0xcec185eb182c47d1ba1efc84e6959e18cd620be4) | [0x0009cD492adf8167f9eEBf1293556A673530a21a](https://robinhoodchain.blockscout.com/address/0x0009cD492adf8167f9eEBf1293556A673530a21a) | 0.05% |
| AAPL | stock | [0xaf3d76f1834a1d425780943c99ea8a608f8a93f9](https://robinhoodchain.blockscout.com/address/0xaf3d76f1834a1d425780943c99ea8a608f8a93f9) | [0x6B22A786bAa607d76728168703a39Ea9C99f2cD0](https://robinhoodchain.blockscout.com/address/0x6B22A786bAa607d76728168703a39Ea9C99f2cD0) | 0.05% |
| NVDA | stock | [0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec](https://robinhoodchain.blockscout.com/address/0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec) | [0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15](https://robinhoodchain.blockscout.com/address/0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15) | 0.05% |
| TSLA | stock | [0x322f0929c4625ed5bad873c95208d54e1c003b2d](https://robinhoodchain.blockscout.com/address/0x322f0929c4625ed5bad873c95208d54e1c003b2d) | [0x4A1166a659A55625345e9515b32adECea5547C38](https://robinhoodchain.blockscout.com/address/0x4A1166a659A55625345e9515b32adECea5547C38) | 0.3% |
| MSFT | stock | [0xe93237c50d904957cf27e7b1133b510c669c2e74](https://robinhoodchain.blockscout.com/address/0xe93237c50d904957cf27e7b1133b510c669c2e74) | [0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E](https://robinhoodchain.blockscout.com/address/0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E) | 0.3% |
| AMZN | stock | [0x12f190a9f9d7d37a250758b26824b97ce941bf54](https://robinhoodchain.blockscout.com/address/0x12f190a9f9d7d37a250758b26824b97ce941bf54) | [0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C](https://robinhoodchain.blockscout.com/address/0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C) | 0.3% |
| GOOGL | stock | [0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3](https://robinhoodchain.blockscout.com/address/0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3) | [0xF6f373a037c30F0e5010d854385cA89185AE638b](https://robinhoodchain.blockscout.com/address/0xF6f373a037c30F0e5010d854385cA89185AE638b) | 0.05% |
| META | stock | [0xc0d6457c16cc70d6790dd43521c899c87ce02f35](https://robinhoodchain.blockscout.com/address/0xc0d6457c16cc70d6790dd43521c899c87ce02f35) | [0x7C38C00C30BEe9378381E7B6135d7283356D71b1](https://robinhoodchain.blockscout.com/address/0x7C38C00C30BEe9378381E7B6135d7283356D71b1) | 0.3% |
| SPY | stock | [0x117cc2133c37b721f49de2a7a74833232b3b4c0c](https://robinhoodchain.blockscout.com/address/0x117cc2133c37b721f49de2a7a74833232b3b4c0c) | [0x319724394D3A0e3669269846abE664Cd621f9f6A](https://robinhoodchain.blockscout.com/address/0x319724394D3A0e3669269846abE664Cd621f9f6A) | 0.05% |
| QQQ | stock | [0xd5f3879160bc7c32ebb4dc785f8a4f505888de68](https://robinhoodchain.blockscout.com/address/0xd5f3879160bc7c32ebb4dc785f8a4f505888de68) | [0x80901d846d5D7B030F26B480776EE3b29374C2ae](https://robinhoodchain.blockscout.com/address/0x80901d846d5D7B030F26B480776EE3b29374C2ae) | 0.05% |
| COIN | stock | [0x6330d8c3178a418788df01a47479c0ce7ccf450b](https://robinhoodchain.blockscout.com/address/0x6330d8c3178a418788df01a47479c0ce7ccf450b) | [0xA3a468A452940B7D6b69991207B508c609a98Ef2](https://robinhoodchain.blockscout.com/address/0xA3a468A452940B7D6b69991207B508c609a98Ef2) | 0.05% |

Stock tokens are Robinhood Stock Tokens. Their Chainlink feeds follow US equities 24/5 and already include the corporate-action multiplier (splits, dividends). They pause on weekends, so stock swaps are blocked until the feed updates again.

### Hooked pool: WETH / USDG

| | |
|---|---|
| Pool ID | `0x0f1b6d9e3fb170d7270cf8f448b7d72364fd58d22c164e312ff81a541f5d210e` |
| Tokens | WETH (currency0) / USDG (currency1), tick spacing 60, dynamic fee |
| Fee | 0.05 % when calm, plus 0.005 % per tick of average price move per block, capped at 1 %. Computed on-chain on every swap. |
| Swaps | One per block per address (blocks sandwiching and most MEV) |
| LP vaults | The agent moves your range to follow the price, only when the pool price is within your limit of Chainlink (WETH/USD and USDG/USD feeds), at most once per interval you set |

In the app, liquidity comes from LP vaults. Every swap through `NounySwapRouter` carries a minimum output (the app sets it 1 % below the quote) and a deadline, so it reverts instead of filling at a worse price.

## Who can do what

| | You (vault owner) | NOUNY bot | Anyone else |
|---|---|---|---|
| Deposit | ✅ | — | ✅ (it's just a transfer) |
| **Withdraw** | ✅ any time, even while paused | ❌ never | ❌ |
| Swap inside the vault | ❌ | ✅ within your limits | ❌ |
| Change limits, pause, revoke the bot | ✅ | ❌ | ❌ |
| Payroll: add / remove recipients | ✅ | ❌ | ❌ |
| Payroll: trigger a **due** payment | ✅ | ✅ | ✅ (only to the people and amounts you set) |
| LP vault: move the range (rebalance) | ✅ | ✅ within your limits, near the oracle price, once per interval | ❌ |
| LP vault: exit the pool, withdraw | ✅ any time, even while paused | ❌ never | ❌ |
| LP vault: change limits, pause, revoke the bot | ✅ | ❌ | ❌ |

Every agent swap is protected on-chain: the minimum output is computed from Chainlink (not by the bot), stale or invalid prices are rejected, the pool is pinned per token, total swap value is capped per 24 h, and the vault checks its own balance before and after. Every LP rebalance is checked on-chain too: pool price within your limit of Chainlink, current price inside the new range, range width within your bounds, and a minimum time between rebalances. Details: **[docs/CONTRACTS.md](docs/CONTRACTS.md)**.

## Verify the deployment yourself

This repository contains the exact source of the deployed contracts. Anyone can check that the code on-chain is this code:

```bash
npm install
npm run build
npm run verify:deployment
```

The script reads the contracts on Robinhood Chain (read-only, no keys). It checks every token, oracle, staleness limit and pool fee tier against [`config/robinhood.json`](config/robinhood.json), checks the hook's fee settings, permission flags and pool registration, and compares the deployed bytecode of **AgentVaultFactory, PayrollFactory, NounyHook, NounyLPVaultFactory and NounySwapRouter** with the code compiled from this repository.

### Run the tests

```bash
npm test             # 63 unit and fuzz tests (AgentVault, Payroll, NounyHook, NounyLPVault, NounySwapRouter)
npm run test:fuzz    # longer AgentVault fuzz run (2,000 random steps)
npm run test:fork    # against a local copy of Robinhood Chain: real Uniswap V3 pools, the real v4 PoolManager and Chainlink feeds
npm run check        # re-checks every token, feed and pool in config/robinhood.json on-chain
```

Requires Node.js 20+. The fork test uses `https://robinhood.drpc.org` by default (`ROBINHOOD_RPC_URL` to override).

## Repository layout

```
contracts/            AgentVault, AgentVaultFactory, PayrollVault, PayrollFactory,
                      NounyHook, NounyLPVault (+ factory), NounySwapRouter (+ test mocks and a local v4 harness)
test/                 unit, fuzz and fork tests
config/robinhood.json tokens, Chainlink feeds, pool fee tiers, router
deployments/          deployed addresses on Robinhood Chain (robinhood-hooked.json: hook, pool, LP factory, router)
scripts/              on-chain config check and deployment verification (read-only)
docs/                 user guide, contract reference, security model
```

## License

[MIT](LICENSE)
