// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Read-only probe for `npm run verify:deployment`, never deployed: it is run with eth_call as creation code.
///         The constructor applies NounyHook._l2Block() line for line and returns
///         (code length at ArbSys 0x64, block.number, ArbSys.arbBlockNumber(), the block number the hook uses).
///         On Robinhood Chain the hook must use the L2 number from ArbSys, not block.number (the L1 number).
///         Suggested by the HEY Research Lab review (L-3); a Hardhat fork cannot show the difference.
contract L2BlockProbe {
    constructor() {
        address arbSys = address(100);
        (bool ok, bytes memory out) = arbSys.staticcall(abi.encodeWithSignature("arbBlockNumber()"));
        uint256 arb = ok && out.length == 32 ? abi.decode(out, (uint256)) : 0;
        uint256 used = ok && out.length == 32 ? arb : block.number; // NounyHook._l2Block()
        bytes memory r = abi.encode(arbSys.code.length, block.number, arb, used);
        assembly {
            return(add(r, 32), mload(r))
        }
    }
}
