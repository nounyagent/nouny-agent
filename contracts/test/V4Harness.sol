// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Test-only: pulls Uniswap v4's own PoolManager and test routers into the Hardhat build.
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {TestERC20} from "@uniswap/v4-core/src/test/TestERC20.sol";

/// @notice Minimal CREATE2 factory used to place the hook at an address whose low bits encode its permissions.
contract Create2Deployer {
    event Deployed(address addr);

    function deploy(bytes32 salt, bytes calldata initCode) external returns (address addr) {
        bytes memory code = initCode;
        assembly {
            addr := create2(0, add(code, 0x20), mload(code), salt)
        }
        require(addr != address(0), "create2 failed");
        emit Deployed(addr);
    }
}
