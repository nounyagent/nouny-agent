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

Every swap: oracle-computed minimum output (`maxSlippageBps` vs Chainlink), stale (`maxStaleness`) or non-positive prices rejected, pool fee tier pinned per token, daily USD cap, exact router approval reset to 0, vault balance checked before and after.

## AgentVaultFactory

`createVault(maxSlippageBps, dailyLimitUsd)` creates the caller's vault (one per wallet). The token / feed / staleness / fee-tier list is fixed at deployment (`getDefaults()`); the admin can only rotate the operator used for **new** vaults (`setDefaultOperator`), never existing ones.

## PayrollVault (one per wallet, via PayrollFactory)

| Function | Who | What |
|---|---|---|
| `addRecipient(to, amount, interval, firstPayAt)` | owner | Interval 1–366 days, first payment within a year (0 = now). Max 100 recipients. |
| `updateRecipient(id, amount, interval, nextPayAt)` / `removeRecipient(id)` | owner | Recipient address is fixed. |
| `withdraw(amount)` (`type(uint256).max` = all), `rescue(token, amount)`, `setPaused(bool)` | owner | |
| `pay(id)` | anyone | Pays one due period; reverts if not due or balance too low. |
| `payAllDue()` | anyone | Pays every due recipient once; skips (event `Skipped`) those the balance cannot cover. |
| `getRecipients()`, `dueNow()` | view | |

## PayrollFactory

`createPayroll()` (one per wallet), `payrollOf(owner)`, `payrollCount()`, `payrolls(start, count)`. Fixed stablecoin (USDG), no admin.
