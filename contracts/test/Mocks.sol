// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Mock contracts — FOR TESTS ONLY, never deploy.

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockToken is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockFeed {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;

    constructor(uint8 d, int256 a) {
        decimals = d;
        answer = a;
        updatedAt = block.timestamp;
    }

    function set(int256 a, uint256 t) external {
        answer = a;
        updatedAt = t;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// @notice Mock router: swaps at a fixed rate (tokenOut per tokenIn, 18 decimals) and can "cheat".
contract MockRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    mapping(address => mapping(address => uint256)) public rate; // 1e18 = 1:1 in smallest units
    bool public ignoreMinimum; // simulates a malicious router that ignores amountOutMinimum
    address public divertTo; // simulates a router that sends output to another address

    function setRate(address a, address b, uint256 r) external {
        rate[a][b] = r;
    }

    function setEvil(bool ignoreMin, address divert) external {
        ignoreMinimum = ignoreMin;
        divertTo = divert;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 out) {
        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        out = (p.amountIn * rate[p.tokenIn][p.tokenOut]) / 1e18;
        if (!ignoreMinimum) require(out >= p.amountOutMinimum, "Too little received");
        IERC20(p.tokenOut).transfer(divertTo == address(0) ? p.recipient : divertTo, out);
    }
}
