// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @title NounySwapRouter
/// @notice Minimal exact-input swap router for Uniswap v4 pools (NOUNY hooked pools). The caller approves the input
///         token to this router; the router pulls exactly `amountIn`, swaps, and sends the output straight to the
///         caller. Reverts if the output is below `minAmountOut` or after `deadline`. Holds no funds between calls.
contract NounySwapRouter is IUnlockCallback {
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;

    struct Swap {
        address payer;
        PoolKey key;
        bool zeroForOne;
        uint128 amountIn;
        uint128 minAmountOut;
    }

    event Swapped(address indexed user, bytes32 indexed poolId, bool zeroForOne, uint256 amountIn, uint256 amountOut);

    error Expired();
    error TooLittleReceived(uint256 amountOut, uint256 minAmountOut);
    error NotPoolManager();
    error NativeNotSupported();
    error ZeroAmount();

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    function swapExactIn(PoolKey calldata key, bool zeroForOne, uint128 amountIn, uint128 minAmountOut, uint256 deadline)
        external
        returns (uint256 amountOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (amountIn == 0) revert ZeroAmount();
        if (key.currency0.isAddressZero()) revert NativeNotSupported();
        amountOut = abi.decode(poolManager.unlock(abi.encode(Swap(msg.sender, key, zeroForOne, amountIn, minAmountOut))), (uint256));
        emit Swapped(msg.sender, keccak256(abi.encode(key)), zeroForOne, amountIn, amountOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        Swap memory s = abi.decode(data, (Swap));
        BalanceDelta d = poolManager.swap(
            s.key,
            SwapParams({
                zeroForOne: s.zeroForOne,
                amountSpecified: -int256(uint256(s.amountIn)),
                sqrtPriceLimitX96: s.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (Currency cin, Currency cout) = s.zeroForOne ? (s.key.currency0, s.key.currency1) : (s.key.currency1, s.key.currency0);
        (int128 din, int128 dout) = s.zeroForOne ? (d.amount0(), d.amount1()) : (d.amount1(), d.amount0());

        // pay the input (may be less than amountIn if the price limit was hit)
        uint256 pay = uint256(uint128(-din));
        poolManager.sync(cin);
        IERC20(Currency.unwrap(cin)).safeTransferFrom(s.payer, address(poolManager), pay);
        poolManager.settle();

        uint256 out = dout > 0 ? uint256(uint128(dout)) : 0;
        if (out < s.minAmountOut) revert TooLittleReceived(out, s.minAmountOut);
        if (out > 0) poolManager.take(cout, s.payer, out);
        return abi.encode(out);
    }
}
