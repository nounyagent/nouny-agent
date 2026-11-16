# Contract reference

Sources: [`contracts/`](../contracts). Solidity 0.8.24, OpenZeppelin 5.1.0, compiled with `viaIR`, optimizer 200 runs, EVM `cancun`.

## AgentVault (one per wallet, via AgentVaultFactory)

| Function | Who | What |
|---|---|---|
| `withdraw(token, amount, to)` | owner | Send tokens out. Works while paused. |
| `setPaused(bool)` | owner | Stop / allow swaps. |
| `setOperator(address)` | owner | Replace or revoke (`address(0)`) the NOUNY bot. |
| `setLimits(maxSlippageBps, dailyLimitUsd)` | owner | Slippage cap (max 5 %) and 24 h swap value cap (USD, 18 decimals). |
| `setToken(token, feed, maxStaleness, feeTier)` / `removeToken(token)` | owner | Edit the vault's own token list. |
| `swap(tokenIn, tokenOut, feeTier, amountIn, minOut)` | operator | Uniswap V3 `exactInputSingle`, output always back to the vault. |
| `remainingDailyUsd()`, `priceUsd(token)`, `allowedTokens()` | view | |

Every swap is against the base token (USDG): oracle-computed minimum output (`maxSlippageBps` vs Chainlink), stale (`maxStaleness`) or non-positive prices rejected, pool fee tier pinned per token, daily USD cap, exact router approval reset to 0, vault balance checked before and after.

## AgentVaultFactory

`createVault(maxSlippageBps, dailyLimitUsd)` creates the caller's vault (one per wallet). The token / feed / staleness / fee-tier list is fixed at deployment (`getDefaults()`); the admin can only rotate the operator used for **new** vaults (`setDefaultOperator`), never existing ones.

## PayrollVault (one per wallet, via PayrollFactory)

| Function | Who | What |
|---|---|---|
| `addRecipient(to, amount, interval, firstPayAt)` | owner | Interval 1–366 days, first payment within a year (0 = now). Max 100 active recipients (removing one frees its place). |
| `updateRecipient(id, amount, interval, nextPayAt)` / `removeRecipient(id)` | owner | Recipient address is fixed. |
| `withdraw(amount)` (`type(uint256).max` = all), `rescue(token, amount)`, `setPaused(bool)` | owner | Pausing defers payments; after `setPaused(false)` missed periods can be paid. |
| `resumeAndSkipMissed()` | owner | Unpause and move overdue recipients to their next future date, without paying the missed periods. |
| `pay(id)` | anyone | Pays one due period; reverts if not due or balance too low. |
| `payAllDue()` | anyone | Pays every due recipient once; skips those the balance cannot cover (`Skipped`) and those whose transfer fails (`PaymentFailed`, period stays due). |
| `getRecipients()`, `dueNow()` | view | |

## PayrollFactory

`createPayroll()` (one per wallet), `payrollOf(owner)`, `payrollCount()`, `payrolls(start, count)`. Fixed stablecoin (USDG), no admin.

---

# Hooked pools (Uniswap v4)

Sources: `NounyHook.sol`, `NounyLPVault.sol` (vault + factory), `NounySwapRouter.sol`. Solidity 0.8.26, `@uniswap/v4-core` 1.0.2, compiled with `viaIR`, optimizer 44,444,444 runs, EVM `cancun`. Addresses: [`deployments/robinhood-hooked.json`](../deployments/robinhood-hooked.json).

## NounyHook

A hook runs inside the Uniswap v4 PoolManager on every swap of the pools that use it. Its address encodes its permissions: `beforeInitialize`, `beforeSwap`, `afterSwap`, `afterSwapReturnDelta`. It cannot touch liquidity.

| Function | Who | What |
|---|---|---|
| `registerPool(key, payroll, shareBps)` | anyone, before the pool is initialized | The caller becomes the pool owner and is the only one who can initialize it. The pool must use the dynamic-fee flag. |
| `setPayroll(key, payroll, shareBps)` | pool owner | Route a share of the swap fee (max 50 %) to a payroll address. 0 = no share. |
| `setOwner(key, owner)` | pool owner | Hand over the pool. |
| `quoteFee(key)` | view | Fee for the next swap: total, LP part, payroll part, and the current volatility. |
| `pools(id)`, `vol(id)`, `lastSwapBlock(id, address)` | view | |

- **Dynamic fee.** On the first swap of each block the hook records how many ticks the price moved since the last observation and keeps a moving average. Fee = `minFee + volatility × feePerTick`, capped at `maxFee`. Deployed with 0.05 %, 1 % and 0.005 % per tick. Nobody sets the fee by hand.
- **One swap per block per address** (`tx.origin`), using the real L2 block number from the ArbSys precompile (always called; on chains without it the hook falls back to `block.number`).
- **Payroll share.** The LP fee is lowered by the share and the same amount is taken from the swap output and sent to payroll, so the swapper pays the same total fee. If the payroll address cannot receive, the share is skipped and the swap still goes through.

## NounyLPVault (one per wallet and pool, via NounyLPVaultFactory)

Holds one liquidity position. Tokens only leave the vault through the owner.

| Function | Who | What |
|---|---|---|
| `rebalance(lower, upper)` | operator (agent) or owner | Removes the liquidity and adds everything the vault holds into the new range. |
| `exit()` | owner | Pulls all liquidity back into the vault. No price checks: the owner can always get out. |
| `withdraw(token, amount, to)` | owner | Sends idle tokens out (`type(uint256).max` = all). Works while paused. |
| `setPaused(bool)` / `setOperator(address)` | owner | Stop the agent, or replace / revoke (`address(0)`) it. |
| `setParams(minWidth, maxWidth, minInterval, maxDeviationBps)` | owner | Range width bounds (ticks), minimum time between agent rebalances, max pool-vs-oracle gap (≤ 10 %). |
| `prices()`, `positionAmounts()`, `poolKey()` | view | Pool tick, pool and oracle price; tokens in the position. |

Every **agent** rebalance is checked: the pool price must be within `maxDeviationBps` of the Chainlink price, the vault must not be paused, at least `minInterval` must have passed, and the current tick must lie inside the new range, whose width is within `[minWidth, maxWidth]`. Fees earned are added back into the position on each rebalance.

**Deposits** are plain token transfers to the vault; the agent puts them to work on its next run.

## NounyLPVaultFactory

`createVault(key, feed0, feed1, maxStaleness, minWidth, maxWidth, minInterval, maxDeviationBps)` creates the caller's vault for that pool (one per wallet and pool). `vaultOf(owner, poolId)`, `vaultCount()`, `vaults(start, count)`. The admin can only change the operator given to **new** vaults (`setDefaultOperator`), never existing ones.

## NounySwapRouter

`swapExactIn(key, zeroForOne, amountIn, minAmountOut, deadline)`: pulls exactly `amountIn` from the caller (approve first), swaps in the v4 pool and sends the output to the caller. Reverts if the deadline passed or the output is below `minAmountOut`. Holds no funds and has no owner.
