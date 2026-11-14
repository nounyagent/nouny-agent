require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');

// Read-only setup: compiles and tests the NOUNY contracts. No private keys are needed or read.
const RPC = process.env.ROBINHOOD_RPC_URL || 'https://robinhood.drpc.org';

module.exports = {
  solidity: {
    compilers: [
      // AgentVault, PayrollVault and their factories
      { version: '0.8.24', settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun' } },
      // Hooked pools: NounyHook, NounyLPVault, NounySwapRouter (Uniswap v4 is pinned to 0.8.26)
      { version: '0.8.26', settings: { optimizer: { enabled: true, runs: 44444444 }, viaIR: true, evmVersion: 'cancun' } },
    ],
  },
  networks: {
    // FORK=1 runs the tests against a local copy of Robinhood Chain (real Uniswap pools and Chainlink feeds).
    hardhat: process.env.FORK
      ? { forking: { url: RPC }, chainId: 4663 }
      : { allowUnlimitedContractSize: true }, // the local Uniswap v4 PoolManager used in unit tests exceeds 24 KB
    robinhood: { url: RPC, chainId: 4663 },
  },
  mocha: { timeout: 300_000 },
};
