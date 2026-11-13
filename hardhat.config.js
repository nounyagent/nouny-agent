require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');

// Read-only setup: compiles and tests the NOUNY contracts. No private keys are needed or read.
const RPC = process.env.ROBINHOOD_RPC_URL || 'https://robinhood.drpc.org';

module.exports = {
  solidity: {
    version: '0.8.24',
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun' },
  },
  networks: {
    // FORK=1 runs the tests against a local copy of Robinhood Chain (real Uniswap pools and Chainlink feeds).
    hardhat: process.env.FORK ? { forking: { url: RPC }, chainId: 4663 } : {},
    robinhood: { url: RPC, chainId: 4663 },
  },
  mocha: { timeout: 300_000 },
};
