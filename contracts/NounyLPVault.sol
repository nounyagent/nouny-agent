// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {LiquidityAmounts} from "@uniswap/v4-core/test/utils/LiquidityAmounts.sol";

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @title NounyLPVault
/// @notice A user's liquidity position in one Uniswap v4 pool (e.g. a NounyHook pool), managed by the NOUNY agent.
///
/// The agent (operator) can only move the position's range with `rebalance`: it removes the liquidity and adds
/// everything the vault holds back into the new range. Tokens never leave the vault except through the owner.
/// Every rebalance is checked on-chain:
///  - the pool price must be within `maxDeviationBps` of the Chainlink price (no rebalancing into a manipulated price),
///  - the current tick must lie inside the new range, whose width must be within [minWidth, maxWidth],
///  - at most one agent rebalance per `minInterval` seconds.
/// The owner can exit (pull all liquidity back into the vault) and withdraw at any time, even while paused.
contract NounyLPVault is IUnlockCallback {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    enum Action { Rebalance, Exit }

    bytes32 public constant SALT = bytes32(0);
    uint16 public constant MAX_DEVIATION_CAP_BPS = 1000; // 10%

    IPoolManager public immutable poolManager;
    address public immutable owner;
    IAggregatorV3 public immutable feed0; // USD price of currency0
    IAggregatorV3 public immutable feed1; // USD price of currency1
    uint32 public immutable maxStaleness;
    uint8 internal immutable dec0;
    uint8 internal immutable dec1;
    PoolKey internal _key;

    address public operator;
    bool public paused;
    uint24 public minWidth; // ticks
    uint24 public maxWidth; // ticks
    uint32 public minInterval; // seconds between agent rebalances
    uint16 public maxDeviationBps; // pool vs oracle price

    int24 public tickLower;
    int24 public tickUpper;
    uint128 public liquidity;
    uint64 public lastRebalance;

    event Rebalanced(int24 tickLower, int24 tickUpper, uint128 liquidity, int24 tick, uint256 fees0, uint256 fees1, address by);
    event Exited(uint256 fees0, uint256 fees1);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event OperatorChanged(address indexed operator);
    event ParamsChanged(uint24 minWidth, uint24 maxWidth, uint32 minInterval, uint16 maxDeviationBps);
    event PausedChanged(bool paused);

    error NotOwner();
    error NotAllowed();
    error NotPoolManager();
    error IsPaused();
    error TooSoon();
    error BadRange();
    error BadParams();
    error PriceOffOracle(uint256 poolX96, uint256 oracleX96);
    error StaleOracle();
    error BadOracle();
    error NativeNotSupported();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        IPoolManager poolManager_,
        address owner_,
        address operator_,
        PoolKey memory key_,
        IAggregatorV3 feed0_,
        IAggregatorV3 feed1_,
        uint32 maxStaleness_,
        uint24 minWidth_,
        uint24 maxWidth_,
        uint32 minInterval_,
        uint16 maxDeviationBps_
    ) {
        if (key_.currency0.isAddressZero() || key_.currency1.isAddressZero()) revert NativeNotSupported();
        poolManager = poolManager_;
        owner = owner_;
        operator = operator_;
        _key = key_;
        feed0 = feed0_;
        feed1 = feed1_;
        maxStaleness = maxStaleness_;
        dec0 = IERC20Metadata(Currency.unwrap(key_.currency0)).decimals();
        dec1 = IERC20Metadata(Currency.unwrap(key_.currency1)).decimals();
        _setParams(minWidth_, maxWidth_, minInterval_, maxDeviationBps_);
        emit OperatorChanged(operator_);
    }

    // ------------------------------------------------------------------ agent + owner

    /// @notice Move the whole position to [lower, upper). Callable by the operator (rate-limited) or the owner.
    function rebalance(int24 lower, int24 upper) external {
        bool isOwner = msg.sender == owner;
        if (!isOwner && msg.sender != operator) revert NotAllowed();
        if (paused && !isOwner) revert IsPaused();
        if (!isOwner && block.timestamp < uint256(lastRebalance) + minInterval) revert TooSoon();

        (uint160 sqrtP, int24 tick,,) = poolManager.getSlot0(_key.toId());
        int24 sp = _key.tickSpacing;
        uint256 width = uint256(int256(upper) - int256(lower));
        if (lower >= upper || lower % sp != 0 || upper % sp != 0 || width < minWidth || width > maxWidth) revert BadRange();
        if (lower < TickMath.MIN_TICK || upper > TickMath.MAX_TICK || tick < lower || tick >= upper) revert BadRange();
        _checkOracle(sqrtP);

        lastRebalance = uint64(block.timestamp);
        poolManager.unlock(abi.encode(Action.Rebalance, lower, upper, msg.sender));
    }

    // ------------------------------------------------------------------ owner

    /// @notice Pull all liquidity back into the vault (no price checks: the owner can always get out).
    function exit() external onlyOwner {
        poolManager.unlock(abi.encode(Action.Exit, int24(0), int24(0), msg.sender));
    }

    /// @notice Withdraw idle tokens (call `exit` first to include the position). `type(uint256).max` = everything.
    function withdraw(address token, uint256 amount, address to) external onlyOwner {
        if (amount == type(uint256).max) amount = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    function setOperator(address operator_) external onlyOwner {
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedChanged(p);
    }

    function setParams(uint24 minWidth_, uint24 maxWidth_, uint32 minInterval_, uint16 maxDeviationBps_) external onlyOwner {
        _setParams(minWidth_, maxWidth_, minInterval_, maxDeviationBps_);
    }

    // ------------------------------------------------------------------ views

    function poolKey() external view returns (PoolKey memory) {
        return _key;
    }

    /// @notice Current pool tick, pool price and oracle price (both token1 per token0 in raw units, X96).
    function prices() external view returns (int24 tick, uint256 poolX96, uint256 oracleX96) {
        (uint160 sqrtP, int24 t,,) = poolManager.getSlot0(_key.toId());
        return (t, FullMath.mulDiv(sqrtP, sqrtP, 1 << 96), _oracleX96());
    }

    /// @notice Token amounts currently in the position (excluding uncollected fees).
    function positionAmounts() external view returns (uint256 amount0, uint256 amount1) {
        if (liquidity == 0) return (0, 0);
        (uint160 sqrtP,,,) = poolManager.getSlot0(_key.toId());
        return LiquidityAmounts.getAmountsForLiquidity(
            sqrtP, TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), liquidity
        );
    }

    // ------------------------------------------------------------------ v4 callback

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (Action action, int24 lower, int24 upper, address by) = abi.decode(data, (Action, int24, int24, address));

        (uint256 fees0, uint256 fees1) = _removeAll();
        if (action == Action.Exit) {
            emit Exited(fees0, fees1);
            return "";
        }

        (uint160 sqrtP, int24 tick,,) = poolManager.getSlot0(_key.toId());
        uint256 b0 = _bal(_key.currency0);
        uint256 b1 = _bal(_key.currency1);
        // leave 1 wei of each as rounding headroom (the pool rounds amounts owed up)
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), b0 > 0 ? b0 - 1 : 0, b1 > 0 ? b1 - 1 : 0
        );
        if (liq > 0) {
            (BalanceDelta d,) = poolManager.modifyLiquidity(
                _key, ModifyLiquidityParams(lower, upper, int256(uint256(liq)), SALT), ""
            );
            _settle(_key.currency0, d.amount0());
            _settle(_key.currency1, d.amount1());
        }
        tickLower = lower;
        tickUpper = upper;
        liquidity = liq;
        emit Rebalanced(lower, upper, liq, tick, fees0, fees1, by);
        return "";
    }

    // ------------------------------------------------------------------ internal

    function _removeAll() internal returns (uint256 fees0, uint256 fees1) {
        if (liquidity == 0) return (0, 0);
        (BalanceDelta d, BalanceDelta fees) = poolManager.modifyLiquidity(
            _key, ModifyLiquidityParams(tickLower, tickUpper, -int256(uint256(liquidity)), SALT), ""
        );
        liquidity = 0;
        _take(_key.currency0, d.amount0());
        _take(_key.currency1, d.amount1());
        fees0 = uint256(int256(fees.amount0()));
        fees1 = uint256(int256(fees.amount1()));
    }

    function _take(Currency c, int128 amount) internal {
        if (amount > 0) poolManager.take(c, address(this), uint256(int256(amount)));
    }

    function _settle(Currency c, int128 amount) internal {
        if (amount >= 0) {
            _take(c, amount);
            return;
        }
        poolManager.sync(c);
        IERC20(Currency.unwrap(c)).safeTransfer(address(poolManager), uint256(-int256(amount)));
        poolManager.settle();
    }

    function _bal(Currency c) internal view returns (uint256) {
        return IERC20(Currency.unwrap(c)).balanceOf(address(this));
    }

    function _price(IAggregatorV3 f) internal view returns (uint256) {
        (, int256 a,, uint256 updatedAt,) = f.latestRoundData();
        if (a <= 0) revert BadOracle();
        if (updatedAt > block.timestamp || block.timestamp - updatedAt > maxStaleness) revert StaleOracle();
        return uint256(a) * 10 ** (18 - f.decimals()); // 18-decimal USD
    }

    function _oracleX96() internal view returns (uint256) {
        // raw price of currency0 in currency1 = (p0 / p1) * 10^(dec1 - dec0)
        return FullMath.mulDiv(_price(feed0) * 10 ** dec1, 1 << 96, _price(feed1) * 10 ** dec0);
    }

    function _checkOracle(uint160 sqrtP) internal view {
        uint256 poolX96 = FullMath.mulDiv(sqrtP, sqrtP, 1 << 96);
        uint256 oracleX96 = _oracleX96();
        uint256 diff = poolX96 > oracleX96 ? poolX96 - oracleX96 : oracleX96 - poolX96;
        if (diff * 10_000 > oracleX96 * maxDeviationBps) revert PriceOffOracle(poolX96, oracleX96);
    }

    function _setParams(uint24 minWidth_, uint24 maxWidth_, uint32 minInterval_, uint16 maxDeviationBps_) internal {
        if (minWidth_ == 0 || minWidth_ > maxWidth_ || maxDeviationBps_ == 0 || maxDeviationBps_ > MAX_DEVIATION_CAP_BPS) {
            revert BadParams();
        }
        minWidth = minWidth_;
        maxWidth = maxWidth_;
        minInterval = minInterval_;
        maxDeviationBps = maxDeviationBps_;
        emit ParamsChanged(minWidth_, maxWidth_, minInterval_, maxDeviationBps_);
    }
}

/// @title NounyLPVaultFactory
/// @notice One LP vault per (owner, pool). New vaults get the current NOUNY operator; owners control their own.
contract NounyLPVaultFactory {
    using PoolIdLibrary for PoolKey;

    IPoolManager public immutable poolManager;
    address public admin;
    address public defaultOperator;
    mapping(address owner => mapping(PoolId => address)) public vaultOf;
    address[] private _all;

    event VaultCreated(address indexed owner, PoolId indexed poolId, address vault);
    event DefaultOperatorChanged(address operator);

    error NotAdmin();
    error VaultExists(address vault);

    constructor(IPoolManager poolManager_, address operator_) {
        poolManager = poolManager_;
        admin = msg.sender;
        defaultOperator = operator_;
        emit DefaultOperatorChanged(operator_);
    }

    function createVault(
        PoolKey calldata key,
        IAggregatorV3 feed0,
        IAggregatorV3 feed1,
        uint32 maxStaleness,
        uint24 minWidth,
        uint24 maxWidth,
        uint32 minInterval,
        uint16 maxDeviationBps
    ) external returns (address vault) {
        PoolId id = key.toId();
        if (vaultOf[msg.sender][id] != address(0)) revert VaultExists(vaultOf[msg.sender][id]);
        vault = address(
            new NounyLPVault(poolManager, msg.sender, defaultOperator, key, feed0, feed1, maxStaleness, minWidth, maxWidth, minInterval, maxDeviationBps)
        );
        vaultOf[msg.sender][id] = vault;
        _all.push(vault);
        emit VaultCreated(msg.sender, id, vault);
    }

    function vaultCount() external view returns (uint256) {
        return _all.length;
    }

    /// @notice Page through all vaults (used by the NOUNY agent).
    function vaults(uint256 start, uint256 count) external view returns (address[] memory out) {
        uint256 n = _all.length;
        if (start >= n) return out;
        if (count > n - start) count = n - start;
        out = new address[](count);
        for (uint256 i; i < count; ++i) out[i] = _all[start + i];
    }

    function setDefaultOperator(address operator_) external {
        if (msg.sender != admin) revert NotAdmin();
        defaultOperator = operator_;
        emit DefaultOperatorChanged(operator_);
    }
}
