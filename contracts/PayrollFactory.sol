// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PayrollVault} from "./PayrollVault.sol";

/// @title PayrollFactory
/// @notice Each wallet creates one PayrollVault paying in the factory's stablecoin. No admin, no fees.
contract PayrollFactory {
    address public immutable token;

    mapping(address => address) public payrollOf;
    address[] private _all;

    event PayrollCreated(address indexed owner, address payroll);

    error PayrollExists(address payroll);

    constructor(address token_) {
        require(token_ != address(0), "token");
        token = token_;
    }

    function createPayroll() external returns (address payroll) {
        if (payrollOf[msg.sender] != address(0)) revert PayrollExists(payrollOf[msg.sender]);
        payroll = address(new PayrollVault(msg.sender, token));
        payrollOf[msg.sender] = payroll;
        _all.push(payroll);
        emit PayrollCreated(msg.sender, payroll);
    }

    function payrollCount() external view returns (uint256) {
        return _all.length;
    }

    /// @notice Page through all payroll vaults (used by the keeper that triggers due payments).
    function payrolls(uint256 start, uint256 count) external view returns (address[] memory out) {
        uint256 n = _all.length;
        if (start >= n) return out;
        if (count > n - start) count = n - start;
        out = new address[](count);
        for (uint256 i; i < count; ++i) out[i] = _all[start + i];
    }
}
