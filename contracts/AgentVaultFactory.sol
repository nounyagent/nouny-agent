// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AgentVault} from "./AgentVault.sol";

/// @title AgentVaultFactory
/// @notice Each wallet creates one AgentVault of its own. The factory holds the default token list
///         (tokens, Chainlink feeds, staleness limits and pinned pool fee tiers) and the NOUNY operator
///         installed into NEW vaults.
///
///         The token list is fixed at deployment and can never be changed, so the admin cannot point new
///         vaults at a malicious oracle or pool. Only the default operator can be rotated (e.g. after a bot
///         key compromise), and that never affects existing vaults — their owners control their own operator.
contract AgentVaultFactory {
    address public immutable router;
    address public admin;
    address public pendingAdmin;
    address public defaultOperator;

    address[] private _tokens;
    address[] private _feeds;
    uint32[] private _staleness;
    uint24[] private _feeTiers;

    mapping(address => address) public vaultOf;

    event VaultCreated(address indexed owner, address vault);
    event DefaultOperatorChanged(address indexed previous, address indexed current);
    event AdminTransferStarted(address indexed pendingAdmin);
    event AdminTransferred(address indexed admin);

    error NotAdmin();
    error VaultExists(address vault);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(
        address router_,
        address operator_,
        address[] memory tokens_,
        address[] memory feeds_,
        uint32[] memory staleness_,
        uint24[] memory feeTiers_
    ) {
        require(
            tokens_.length == feeds_.length && feeds_.length == staleness_.length && staleness_.length == feeTiers_.length,
            "length mismatch"
        );
        require(tokens_.length <= 20, "too many tokens");
        router = router_;
        admin = msg.sender;
        defaultOperator = operator_;
        _tokens = tokens_;
        _feeds = feeds_;
        _staleness = staleness_;
        _feeTiers = feeTiers_;
        emit DefaultOperatorChanged(address(0), operator_);
    }

    /// @notice Create a vault for the caller. Limits: max slippage (bps) & swap value per 24h (USD, 18 decimals).
    function createVault(uint16 maxSlippageBps, uint256 dailyLimitUsd) external returns (address vault) {
        if (vaultOf[msg.sender] != address(0)) revert VaultExists(vaultOf[msg.sender]);
        vault = address(
            new AgentVault(
                msg.sender, defaultOperator, router, maxSlippageBps, dailyLimitUsd, _tokens, _feeds, _staleness, _feeTiers
            )
        );
        vaultOf[msg.sender] = vault;
        emit VaultCreated(msg.sender, vault);
    }

    /// @notice Rotate the operator used for vaults created from now on. Existing vaults are not affected.
    function setDefaultOperator(address operator_) external onlyAdmin {
        emit DefaultOperatorChanged(defaultOperator, operator_);
        defaultOperator = operator_;
    }

    function getDefaults()
        external
        view
        returns (address operator, address[] memory tokens, address[] memory feeds, uint32[] memory staleness, uint24[] memory feeTiers)
    {
        return (defaultOperator, _tokens, _feeds, _staleness, _feeTiers);
    }

    function transferAdmin(address next) external onlyAdmin {
        pendingAdmin = next;
        emit AdminTransferStarted(next);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotAdmin();
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminTransferred(admin);
    }
}
