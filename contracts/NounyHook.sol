// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @notice Arbitrum precompile: the real L2 block number (block.number on Arbitrum chains is the L1 block number).
interface IArbSys {
    function arbBlockNumber() external view returns (uint256);
}

/// @title NounyHook
/// @notice Uniswap v4 hook for NOUNY "hooked pools":
///  - Dynamic fee: on the first swap of each block the hook records how far the price moved (in ticks) since the
///    previous observation and keeps an exponential moving average. The fee is `minFee + volatility × feePerTick`,
///    capped at `maxFee`. Fully on-chain: no one sets the fee by hand.
///  - One swap per block per address (tx.origin), using the L2 block number on Arbitrum chains such as Robinhood Chain.
///  - Payroll share: the pool owner can route a share (max 50%) of the swap fee to a payroll address. The LP fee is
///    lowered by that share and the same share is taken from the swap's unspecified amount and sent to payroll, so the
///    swapper pays the same total fee and LPs give up exactly that share.
/// Pools must be registered here before they are initialized, and must use the dynamic-fee flag.
contract NounyHook is IHooks {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeCast for uint256;

    struct PoolConfig {
        address owner; // can change payroll / share and hand over ownership
        address payroll; // receives the payroll share (zero = no share)
        uint16 shareBps; // share of the swap fee routed to payroll, in basis points of the fee (≤ 5000)
        bool initialized;
    }

    struct VolState {
        uint64 lastBlock; // L2 block of the last observation
        int24 lastTick;
        uint32 volE4; // EWMA of |Δtick| per observed block, scaled by 1e4
    }

    uint16 public constant MAX_SHARE_BPS = 5000;
    uint256 internal constant ALPHA_E4 = 2500; // EWMA weight of a new observation (25%)
    uint256 internal constant MAX_DECAY_STEPS = 32;
    address internal constant ARB_SYS = address(100);
    // transient slot for the hook-fee pips of the swap in progress (beforeSwap → afterSwap)
    bytes32 internal constant HOOK_FEE_SLOT = keccak256("nouny.hook.fee");

    IPoolManager public immutable poolManager;
    uint24 public immutable minFee; // pips (1e-6), e.g. 500 = 0.05%
    uint24 public immutable maxFee; // pips, e.g. 10000 = 1%
    uint24 public immutable feePerTick; // pips added per 1 tick of average move per block

    mapping(PoolId => PoolConfig) public pools;
    mapping(PoolId => VolState) public vol;
    mapping(PoolId => mapping(address => uint256)) public lastSwapBlock;

    event PoolRegistered(PoolId indexed id, address indexed owner, address payroll, uint16 shareBps);
    event PayrollChanged(PoolId indexed id, address payroll, uint16 shareBps);
    event OwnerChanged(PoolId indexed id, address owner);
    event PayrollPaid(PoolId indexed id, address indexed payroll, Currency currency, uint256 amount);
    event PayrollSkipped(PoolId indexed id, address indexed payroll, Currency currency, uint256 amount);

    error NotPoolManager();
    error NotPoolOwner();
    error NotDynamicFee();
    error NotRegistered();
    error AlreadyRegistered();
    error AlreadyInitialized();
    error BadShare();
    error BadFeeConfig();
    error OneSwapPerBlock();
    error HookNotImplemented();

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    constructor(IPoolManager poolManager_, uint24 minFee_, uint24 maxFee_, uint24 feePerTick_) {
        if (minFee_ == 0 || minFee_ > maxFee_ || maxFee_ > 100_000) revert BadFeeConfig(); // max 10%
        poolManager = poolManager_;
        minFee = minFee_;
        maxFee = maxFee_;
        feePerTick = feePerTick_;
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeSwap = true;
        p.afterSwap = true;
        p.afterSwapReturnDelta = true;
    }

    // ------------------------------------------------------------------ pool owner

    /// @notice Register a pool before it is initialized. The caller becomes its owner.
    function registerPool(PoolKey calldata key, address payroll, uint16 shareBps) external {
        if (address(key.hooks) != address(this)) revert NotRegistered();
        if (key.fee != LPFeeLibrary.DYNAMIC_FEE_FLAG) revert NotDynamicFee();
        PoolId id = key.toId();
        if (pools[id].owner != address(0)) revert AlreadyRegistered();
        _checkShare(payroll, shareBps);
        pools[id] = PoolConfig(msg.sender, payroll, shareBps, false);
        emit PoolRegistered(id, msg.sender, payroll, shareBps);
    }

    function setPayroll(PoolKey calldata key, address payroll, uint16 shareBps) external {
        PoolId id = key.toId();
        if (msg.sender != pools[id].owner) revert NotPoolOwner();
        _checkShare(payroll, shareBps);
        pools[id].payroll = payroll;
        pools[id].shareBps = shareBps;
        emit PayrollChanged(id, payroll, shareBps);
    }

    function setOwner(PoolKey calldata key, address owner) external {
        PoolId id = key.toId();
        if (msg.sender != pools[id].owner) revert NotPoolOwner();
        if (owner == address(0)) revert NotPoolOwner();
        pools[id].owner = owner;
        emit OwnerChanged(id, owner);
    }

    // ------------------------------------------------------------------ views

    /// @notice Current fee split for the next swap: total, LP part, payroll part (pips) and volatility (ticks × 1e4).
    function quoteFee(PoolKey calldata key)
        external
        view
        returns (uint24 totalFee, uint24 lpFee, uint24 payrollFee, uint32 volatilityE4)
    {
        PoolId id = key.toId();
        VolState memory v = vol[id];
        (, int24 tick,,) = poolManager.getSlot0(id);
        uint256 blk = _l2Block();
        if (blk != v.lastBlock && v.lastBlock != 0) v.volE4 = _nextVol(v, tick, blk);
        volatilityE4 = v.volE4;
        totalFee = _feeFor(v.volE4);
        (lpFee, payrollFee) = _split(totalFee, pools[id]);
    }

    // ------------------------------------------------------------------ hooks

    function beforeInitialize(address sender, PoolKey calldata key, uint160) external onlyPoolManager returns (bytes4) {
        if (key.fee != LPFeeLibrary.DYNAMIC_FEE_FLAG) revert NotDynamicFee();
        PoolConfig storage c = pools[key.toId()];
        if (c.owner == address(0)) revert NotRegistered();
        // only the registrant may initialize, so registering a key someone else is about to use gains nothing
        // (review I-5)
        if (sender != c.owner) revert NotPoolOwner();
        if (c.initialized) revert AlreadyInitialized();
        c.initialized = true;
        return IHooks.beforeInitialize.selector;
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        uint256 blk = _l2Block();

        // one swap per block per address
        if (lastSwapBlock[id][tx.origin] == blk) revert OneSwapPerBlock();
        lastSwapBlock[id][tx.origin] = blk;

        // volatility: one observation per block, taken before the first swap moves the price
        VolState memory v = vol[id];
        if (v.lastBlock != blk) {
            (, int24 tick,,) = poolManager.getSlot0(id);
            if (v.lastBlock != 0) v.volE4 = _nextVol(v, tick, blk);
            v.lastTick = tick;
            v.lastBlock = uint64(blk);
            vol[id] = v;
        }

        uint24 fee = _feeFor(v.volE4);
        (uint24 lpFee, uint24 payrollFee) = _split(fee, pools[id]);
        bytes32 slot = HOOK_FEE_SLOT;
        assembly ("memory-safe") {
            tstore(slot, payrollFee)
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, lpFee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        bytes32 slot = HOOK_FEE_SLOT;
        uint256 payrollFee;
        assembly ("memory-safe") {
            payrollFee := tload(slot)
            tstore(slot, 0)
        }
        if (payrollFee == 0) return (IHooks.afterSwap.selector, 0);

        // the payroll share is taken in the unspecified currency (output for exact-in, input for exact-out)
        bool specifiedIs0 = (params.amountSpecified < 0 == params.zeroForOne);
        (Currency c, int128 amt) = specifiedIs0 ? (key.currency1, delta.amount1()) : (key.currency0, delta.amount0());
        if (amt < 0) amt = -amt;
        uint256 amount = uint256(uint128(amt)) * payrollFee / LPFeeLibrary.MAX_LP_FEE;
        if (amount == 0) return (IHooks.afterSwap.selector, 0);

        PoolId id = key.toId();
        address payroll = pools[id].payroll;
        // A payroll address that cannot receive this currency must not block swaps (review I-6): if the transfer
        // fails, the share is simply not taken for this swap and the swapper keeps it.
        try poolManager.take(c, payroll, amount) {
            emit PayrollPaid(id, payroll, c, amount);
            return (IHooks.afterSwap.selector, amount.toInt128());
        } catch {
            emit PayrollSkipped(id, payroll, c, amount);
            return (IHooks.afterSwap.selector, 0);
        }
    }

    // ------------------------------------------------------------------ internal

    /// @dev Always ask ArbSys: on Arbitrum chains such as Robinhood Chain it answers with the L2 block number (its
    ///      account holds the placeholder code 0xfe, so a code-length check must not gate the call: review L-3).
    ///      Elsewhere the call returns no data and we fall back to block.number.
    function _l2Block() internal view returns (uint256) {
        (bool ok, bytes memory out) = ARB_SYS.staticcall(abi.encodeCall(IArbSys.arbBlockNumber, ()));
        if (ok && out.length == 32) return abi.decode(out, (uint256));
        return block.number;
    }

    function _nextVol(VolState memory v, int24 tick, uint256 blk) internal pure returns (uint32) {
        uint256 cur = v.volE4;
        // decay for blocks without an observation
        uint256 gap = blk > v.lastBlock ? blk - v.lastBlock - 1 : 0;
        if (gap > MAX_DECAY_STEPS) gap = MAX_DECAY_STEPS;
        for (uint256 i; i < gap; ++i) cur = cur * (10_000 - ALPHA_E4) / 10_000;
        int256 d = int256(tick) - int256(v.lastTick);
        uint256 move = uint256(d < 0 ? -d : d) * 10_000;
        cur = (cur * (10_000 - ALPHA_E4) + move * ALPHA_E4) / 10_000;
        return cur > type(uint32).max ? type(uint32).max : uint32(cur);
    }

    function _feeFor(uint32 volE4) internal view returns (uint24) {
        uint256 f = uint256(minFee) + uint256(volE4) * feePerTick / 10_000;
        return f > maxFee ? maxFee : uint24(f);
    }

    function _split(uint24 fee, PoolConfig memory c) internal pure returns (uint24 lpFee, uint24 payrollFee) {
        if (c.payroll == address(0) || c.shareBps == 0) return (fee, 0);
        payrollFee = uint24(uint256(fee) * c.shareBps / 10_000);
        lpFee = fee - payrollFee;
    }

    function _checkShare(address payroll, uint16 shareBps) internal pure {
        if (shareBps > MAX_SHARE_BPS || (shareBps > 0 && payroll == address(0))) revert BadShare();
    }

    // ------------------------------------------------------------------ unused hooks

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, BalanceDelta)
    {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, BalanceDelta)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
