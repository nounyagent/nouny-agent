// Picks config/<network>.json for the Hardhat network in use.
//   --network robinhood                -> config/robinhood.json
//   hardhat / localhost (local fork)   -> FORK_NETWORK (default robinhood)
const path = require('node:path');

module.exports = function netConfig(networkName) {
  const name = ['hardhat', 'localhost'].includes(networkName) ? (process.env.FORK_NETWORK || 'robinhood') : networkName;
  const cfg = require(path.join(__dirname, '..', 'config', `${name}.json`));
  return { name, ...cfg };
};
