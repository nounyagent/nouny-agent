# NOUNY user guide

App: **https://nounyagent.com** · each feature has its own page: [Agents](https://nounyagent.com/agents), [Markets](https://nounyagent.com/markets), [Pools](https://nounyagent.com/pools), [Payroll](https://nounyagent.com/payroll), [Leaderboard](https://nounyagent.com/leaderboard), [$NOUNY](https://nounyagent.com/token), [Docs](https://nounyagent.com/docs).

1. [Connect your wallet](#1-connect-your-wallet)
2. [Build a paper agent](#2-build-a-paper-agent)
3. [Strategies](#3-strategies)
4. [Get ready for live trading](#4-get-ready-for-live-trading)
5. [Create and fund your vault](#5-create-and-fund-your-vault)
6. [Run a live agent](#6-run-a-live-agent)
7. [Withdraw, pause or stop](#7-withdraw-pause-or-stop)
8. [Payroll](#8-payroll)
9. [Pools: swap and provide liquidity](#9-pools-swap-and-provide-liquidity)
10. [Fees and limits](#10-fees-and-limits)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Connect your wallet

Click **Connect wallet** and pick your wallet (MetaMask, OKX Wallet, Rabby, Coinbase Wallet or any browser wallet).

Your wallet asks you to **sign a message** ("Sign in with Ethereum"). This proves you own the address. It is **not a transaction**: it costs nothing and moves no funds. You stay signed in for 7 days on that browser, or until you click your address → **Log out**.

> NOUNY never asks for your seed phrase or private key. Anyone who does is not NOUNY.

## 2. Build a paper agent

Paper agents trade **virtual money** ($10,000 each) on **real prices**. Use them to try strategies before risking anything.

1. Go to **[Agent Studio](https://nounyagent.com/agents)**.
2. **Name**: 3–32 letters or numbers.
3. **Strategy**: see [Strategies](#3-strategies). Each one has a few settings; the defaults are sensible.
4. **Mode**: *Paper*.
5. **Market**: 30 crypto (BTC, ETH, SOL, XRP, DOGE, LINK, AVAX, NEAR, SUI, ZEC, BNB, ADA, TRX, LTC, BCH, UNI, AAVE, TAO, ENA, WLD, ICP, INJ, ONDO, HBAR, XLM, APT, DOT, ARB, FET, FIL), 23 perpetuals (BTC-PERP, ETH-PERP, SOL-PERP, HYPE-PERP, XRP-PERP, DOGE-PERP, SUI-PERP, LINK-PERP, BNB-PERP, ADA-PERP, AVAX-PERP, LTC-PERP, AAVE-PERP, ENA-PERP, TAO-PERP, ONDO-PERP, NEAR-PERP, WLD-PERP, ARB-PERP, APT-PERP, TRX-PERP, BCH-PERP, ZEC-PERP) or 25 stocks and ETFs (AAPL, NVDA, TSLA, MSFT, AMZN, GOOGL, META, SPY, QQQ, COIN, AMD, NFLX, AVGO, PLTR, HOOD, MSTR, ORCL, JPM, V, WMT, DIS, UBER, INTC, IWM, DIA).
6. Click **Backtest & launch**.

NOUNY first **backtests** the strategy on the last 720 hourly candles (30 days for crypto; for stocks, US market hours only, so roughly 5 months) and shows the result next to simply holding the market. The agent then makes **one decision every hour**: buy, sell or hold, with the reason written in its **Decision log**.

Every agent appears on the public **leaderboard**, compared with "just holding" since the day it launched. You can run up to 5 agents.

## 3. Strategies

All strategies are long-only: they either hold the asset or hold cash (USDG in live mode).

| Strategy | Buys when | Sells when | Settings |
|---|---|---|---|
| **Momentum** | price breaks above its recent high (and is above its average) | price falls a set % from its peak since entry (trailing stop) | breakout window (6–168 h), trailing stop (1–30 %), position size |
| **Mean reversion** | price is unusually far *below* its average (in standard deviations) | price is back at the average, or the stop loss hits | average window (10–200 h), entry distance (0.5–4 σ), stop loss (1–50 %), position size |
| **Custom (MA crossover)** | the fast moving average crosses above the slow one | fast crosses below slow, stop loss, or take profit | fast (2–100 h), slow (5–400 h), stop loss, take profit, position size |

*Position size* is the % of the agent's cash used for each buy (10–100 %).

## 4. Get ready for live trading

Live agents trade on **Robinhood Chain** (an Ethereum layer 2, chain ID **4663**). You need:

- **A little ETH on Robinhood Chain for gas.** Creating a vault and depositing costs a fraction of a cent; 0.0005 ETH is plenty. ETH on Ethereum, Base or another chain does not count: bridge some to Robinhood Chain first.
- **USDG on Robinhood Chain**: the dollar the agents trade with. Start small: $10–$50 is enough to try it.

When you sign a vault transaction, the app asks your wallet to switch to Robinhood Chain and adds the network if it is missing:

| Setting | Value |
|---|---|
| Network name | Robinhood Chain |
| RPC URL | `https://robinhood.drpc.org` |
| Chain ID | `4663` |
| Currency | ETH |
| Explorer | `https://robinhoodchain.blockscout.com` |

## 5. Create and fund your vault

Your **vault** is a smart contract that belongs to your wallet. The NOUNY agent can swap inside it within your limits, but **can never take funds out**. Only you can withdraw, at any time.

1. In Agent Studio, the **Live trading vault** card appears at the top. Choose:
   - **Daily trading limit (USD)**: the most the agent may swap in 24 hours (for example $500).
   - **Max slippage (%)**: the worst price the agent may accept, measured against the Chainlink oracle price (0.1–5 %; 1 % is a good default, 2 % for stocks with 0.3 % pools).
2. Click **Create vault** and confirm in your wallet.
3. **Deposit**: pick **USDG**, enter an amount and confirm. This is a normal token transfer to your vault.

The card then shows your balances, their value from Chainlink prices, the daily limit and how much of it is left today.

## 6. Run a live agent

1. In **New agent**, set **Mode** to **Live**.
2. Pick a market: **ETH / USDG**, **BTC / USDG** or a stock (**AAPL, NVDA, TSLA, MSFT, AMZN, GOOGL, META, SPY, QQQ, COIN** / USDG).
3. Click **Backtest & launch**.

Each hour the agent decides. On **buy** it swaps part of your USDG into the asset; on **sell** it swaps it back. Each trade in the Decision log links to its transaction on the explorer.

- One live agent per vault.
- Your vault needs at least $5 and agent access switched **on**.
- If a trade is larger than what is left of your daily limit, the agent trades the part that fits and continues next hour.
- **Stocks trade Monday–Friday.** Stock oracle prices pause on weekends, so the vault refuses stock swaps until they update. The agent simply holds.

## 7. Withdraw, pause or stop

All of these are on the vault card and are signed by **your** wallet:

| Button | Effect |
|---|---|
| **Withdraw** | Sends a token from the vault to your wallet. Type an amount or `max`. Works even when paused. |
| **Pause vault** / **Resume vault** | While paused, no swaps can happen. |
| **Revoke agent access** / **Give agent access** | Removes or restores the bot's permission to swap. Your agents stop trading until you give access back. |
| Agent **Pause** / **Delete** | Stops that agent's decisions. Deleting removes its history from NOUNY; your vault and funds are untouched. |

Even if the NOUNY website went offline, you could still withdraw by calling `withdraw(token, amount, yourAddress)` on your vault from the explorer ("Write contract").

## 8. Payroll

Pay people in USDG on a schedule.

1. Open **[Payroll](https://nounyagent.com/payroll)** and click **Create payroll vault** (one per wallet).
2. **Deposit** USDG.
3. **Add recipient**: their wallet address, amount, schedule (**weekly**, **every 2 weeks** or **monthly** = every 30 days) and the date of the first payment (empty = now).
4. That's it. The NOUNY bot checks every hour and pays each salary when it is due.

The card shows the balance, the monthly cost and the **runway** (how many months the balance covers). If a payment is due but the balance is too low, it is skipped and paid as soon as you top up. You can also click **Pay due now** yourself.

Only you can add or remove recipients and withdraw. The bot, or anyone else, can only trigger a payment that is due, to the address and amount you set, once per period.

## 9. Pools: swap and provide liquidity

Open **[Pools](https://nounyagent.com/pools)**.

**Swap WETH ↔ USDG**

Swaps on this page go through **Uniswap V3**, using Uniswap's official SwapRouter02 and QuoterV2 on Robinhood Chain. For your amount, the site quotes the 0.01 %, 0.05 % and 0.3 % WETH / USDG pools and uses the one that returns the most. NOUNY adds no fee; you pay only that pool's fee and gas.

1. In the **Swap** card, pick the direction (the ⇄ button) and enter an amount. The card shows what you receive, the Uniswap pool fee and the minimum you will get (1 % below the quote).
2. The first time, click **Approve** for the token you pay with. The approval is for the Uniswap SwapRouter02.
3. Click **Swap** and confirm in your wallet. The tokens go straight to your wallet. If the price moves more than 1 % before your transaction lands, or it lands more than 10 minutes later, it reverts and nothing is traded.

**The hooked pool**

NOUNY also runs a **WETH / USDG** pool on Uniswap v4 with the NOUNY hook: its fee rises when the price moves fast and falls when markets are calm (0.05 % to 1 %), and each address can swap only once per block. Liquidity in it comes from LP vaults (below).

**Provide liquidity with an LP vault**

1. In the **LP vault** card, choose your limits: range width (min and max, in %), how often the agent may move the range, and the maximum gap between the pool price and Chainlink.
2. Click **Create vault** and confirm. The vault is yours, one per wallet.
3. **Deposit** WETH and USDG into it.
4. The agent checks every hour. It opens a range around the current price and moves it when the price gets near an edge or leaves the range, only within your limits and only when the pool price matches Chainlink. Every decision appears in the **Agent decision log**.

You can **Exit** (pull all liquidity back into the vault) and **Withdraw** at any time, even while paused. **Pause** or **Revoke agent access** stops the agent from moving your range.

Providing liquidity has risk: when the price moves, the position ends up holding more of the token that fell (impermanent loss). Fees earned are added back into the position.

## 10. Fees and limits

- **NOUNY fees: none.** You pay network gas for your own transactions (fractions of a cent on Robinhood Chain). The bot pays gas for agent trades and payroll runs.
- **Uniswap pool fee** on each live trade: 0.01 % (ETH), 0.05 % (BTC, AAPL, NVDA, GOOGL, SPY, QQQ, COIN) or 0.3 % (TSLA, MSFT, AMZN, META), plus price impact.
- Pools on Robinhood Chain are still small (tens to hundreds of thousands of dollars), so keep trade sizes small to limit price impact. The slippage limit protects you: a trade that would be worse than your max slippage versus the oracle is refused.
- Paper agents simulate 0.1 % cost per trade.

## 11. Troubleshooting

| Message | Meaning / fix |
|---|---|
| "Wallet account changed — please sign in again" | You switched accounts in your wallet. Connect again. |
| Wallet does not switch to Robinhood Chain | Add the network manually with the settings in [section 4](#4-get-ready-for-live-trading), then try again. |
| "insufficient funds for gas" | Your wallet has no ETH **on Robinhood Chain**. Bridge a little ETH there. |
| "daily limit reached" | The vault's 24-hour limit is used up; the agent continues when it resets. |
| "price moved too much (slippage guard)" | The pool price was worse than your max slippage versus the oracle. Nothing was traded. |
| "oracle price is paused or stale" | Usually a stock on a weekend. The agent retries every hour. |
| "agent access to the vault was revoked" / "vault is paused" | Use **Give agent access** / **Resume vault**. |
| "Not enough liquidity on Uniswap for this amount" (swap) | No Uniswap V3 WETH / USDG pool can fill that size. Try a smaller amount. |
| "Too little received" (swap) | The price moved more than 1 % between the quote and your transaction. Nothing was traded; get a fresh quote and try again. |
| "One swap per block" (hooked pool) | Your address already swapped in the hooked pool in the current block. Try again a second later. |
| "Price is too far from the oracle" (LP vault) | The pool price differs from Chainlink by more than your limit, so the agent waits. Nothing is moved. |
| A due salary was not paid | Check the payroll balance; it is paid within the hour after you deposit. |
