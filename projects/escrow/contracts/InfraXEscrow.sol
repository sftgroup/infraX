// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IInfraXEscrow} from "./interfaces/IInfraXEscrow.sol";

/**
 * @title InfraXEscrow
 * @notice InfraX 平台托管记账合约（OE-1，2026-08-16）
 *
 * 设计要点（docs/PAYMASTER_ONCHAIN_ESCROW_DESIGN.md §4）：
 *  1. 资金安全：平台托管资金从 EOA 迁入本合约（Owner 治理，密钥 HSM/轮换，无外部多签），消除私钥单点。
 *  2. 计费链上化：charge/refund 纯 storage 记账（无真实转账），原子防超扣。
 *  3. 零信任边界：资金状态链上可校验；ledger 降级为索引/对账层。
 *  4. 向后兼容：escrowMode feature flag 双轨，ledger 保留 fallback。
 *  5. 成本可控：记账式扣款 ~21k-50k gas/次，可批量摊薄。
 *
 * 安全要点：
 *  - withdraw 走 CEI（先扣余额再转账）+ ReentrancyGuard；charge/refund 无外部调用天然低危。
 *  - relayer 受 perTx/perDay 限额约束（默认 1/10 OXA，owner 可配），防 relayer 私钥失陷。
 *  - UUPS 升级仅 owner，且升级前必须 pause（升级 = 暂停计费窗口）。
 *  - pause 仅冻结 charge/refund；存管/提现不受阻（用户资产随时可取）。
 *  - ERC20 存取使用 SafeERC20。
 */
contract InfraXEscrow is
    Initializable,
    OwnableUpgradeable,
    UUPSUpgradeable,
    PausableUpgradeable,
    IInfraXEscrow
{
    using SafeERC20 for IERC20;

    // ---- 状态 ----
    /// @notice 用户原生托管余额（wei）
    mapping(address => uint256) private _balances;
    /// @notice 用户 ERC20 托管余额 token => user => amount
    mapping(address => mapping(address => uint256)) private _erc20Balances;
    /// @notice 授权 relayer 扣款集合
    mapping(address => bool) private _relayers;
    /// @notice 单日累计扣款 user => day => amount
    mapping(address => mapping(uint256 => uint256)) private _dailyCharged;
    /// @notice 用户级限额（0 = 使用默认）
    mapping(address => ChargeLimit) private _chargeLimits;

    /// @notice 默认限额
    uint256 public defaultPerTxLimit;
    uint256 public defaultPerDayLimit;

    struct ChargeLimit {
        uint256 perTx;
        uint256 perDay;
    }

    // ---- 常量 ----
    /// @notice 默认单笔限额（1 OXA，可配）
    uint256 public constant DEFAULT_PER_TX_LIMIT = 1 ether;
    /// @notice 默认单日限额（10 OXA，可配）
    uint256 public constant DEFAULT_PER_DAY_LIMIT = 10 ether;

    // ---- 重入防护（手写 storage 槽位：OZ 5.6 ReentrancyGuard 带 constructor 不满足升级安全） ----
    /// @dev 1=未进入, 2=已进入
    uint256 private _reentrancyStatus;

    modifier nonReentrant() {
        require(_reentrancyStatus == 1, "ESCROW: reentrancy");
        _reentrancyStatus = 2;
        _;
        _reentrancyStatus = 1;
    }

    // ---- 修饰器 ----
    modifier onlyRelayerOrOwner() {
        require(_relayers[msg.sender] || msg.sender == owner(), "ESCROW: not authorized");
        _;
    }

    // ---- 初始化 ----
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) external initializer {
        require(owner_ != address(0), "ESCROW: zero owner");
        __Ownable_init(owner_);
        __Pausable_init();
        defaultPerTxLimit = DEFAULT_PER_TX_LIMIT;
        defaultPerDayLimit = DEFAULT_PER_DAY_LIMIT;
        _reentrancyStatus = 1;
    }

    // ================================================================
    // 用户侧：存管 / 提现
    // ================================================================
    function deposit() external payable override {
        require(msg.value > 0, "ESCROW: zero amount");
        _balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value, address(0));
    }

    function depositERC20(address token, uint256 amount) external override {
        require(token != address(0), "ESCROW: zero token");
        require(amount > 0, "ESCROW: zero amount");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        _erc20Balances[token][msg.sender] += amount;
        emit Deposited(msg.sender, amount, token);
    }

    // REQ-1（AgentX 智能账户充值闭环）：代他人入账，记账到 user 名下，msg.sender 仅作来源记录。
    // 语义与 EntryPoint.depositTo 对齐：用户可自由帮任意地址入账（非出金操作，无资金风险），
    // 不要求 relayer/owner 权限；withdraw 仍仅本人可取。事件携带 by（充值者）供对账索引。
    function depositFor(address user) external payable override {
        require(msg.value > 0, "ESCROW: zero amount");
        require(user != address(0), "ESCROW: zero user");
        _balances[user] += msg.value;
        emit DepositedFor(user, msg.value, address(0), msg.sender);
    }

    function depositForERC20(address token, uint256 amount, address user) external override {
        require(token != address(0), "ESCROW: zero token");
        require(amount > 0, "ESCROW: zero amount");
        require(user != address(0), "ESCROW: zero user");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        _erc20Balances[token][user] += amount;
        emit DepositedFor(user, amount, token, msg.sender);
    }

    function withdraw(uint256 amount) external override nonReentrant {
        require(amount > 0, "ESCROW: zero amount");
        uint256 bal = _balances[msg.sender];
        require(bal >= amount, "ESCROW: insufficient balance");
        // CEI：先改状态再交互
        _balances[msg.sender] = bal - amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "ESCROW: transfer failed");
        emit Withdrawn(msg.sender, amount, address(0));
    }

    function withdrawERC20(address token, uint256 amount) external override nonReentrant {
        require(token != address(0), "ESCROW: zero token");
        require(amount > 0, "ESCROW: zero amount");
        uint256 bal = _erc20Balances[token][msg.sender];
        require(bal >= amount, "ESCROW: insufficient balance");
        _erc20Balances[token][msg.sender] = bal - amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, token);
    }

    // ================================================================
    // 计费侧：charge / refund（仅 relayer/owner，storage 原子记账）
    // ================================================================
    function charge(address user, uint256 amount, string calldata ref)
        external
        override
        whenNotPaused
        onlyRelayerOrOwner
        returns (uint256)
    {
        require(user != address(0), "ESCROW: zero user");
        require(amount > 0, "ESCROW: zero amount");
        uint256 bal = _balances[user];
        require(bal >= amount, "ESCROW: insufficient balance");

        (uint256 perTx, uint256 perDay) = _chargeLimitOf(user);
        require(amount <= perTx, "ESCROW: exceeds per-tx limit");

        uint256 day = _today();
        uint256 used = _dailyCharged[user][day];
        require(used + amount <= perDay, "ESCROW: exceeds per-day limit");

        _balances[user] = bal - amount;
        _dailyCharged[user][day] = used + amount;
        emit Charged(user, amount, ref);
        return _balances[user];
    }

    function refund(address user, uint256 amount, string calldata ref)
        external
        override
        whenNotPaused
        onlyRelayerOrOwner
        returns (uint256)
    {
        require(user != address(0), "ESCROW: zero user");
        require(amount > 0, "ESCROW: zero amount");
        // 退差：余额回补 + 当日累计回退（不超扣额度）
        _balances[user] += amount;
        uint256 day = _today();
        uint256 used = _dailyCharged[user][day];
        _dailyCharged[user][day] = used >= amount ? used - amount : 0;
        emit Refunded(user, amount, ref);
        return _balances[user];
    }

    // ================================================================
    // 治理侧（仅 Owner，智能合约直接治理，无外部多签）
    // ================================================================
    function setRelayer(address relayer, bool enabled) external override onlyOwner {
        require(relayer != address(0), "ESCROW: zero relayer");
        _relayers[relayer] = enabled;
        emit RelayerSet(relayer, enabled);
    }

    function setChargeLimit(address user, uint256 perTx, uint256 perDay) external override onlyOwner {
        require(user != address(0), "ESCROW: zero user");
        ChargeLimit storage l = _chargeLimits[user];
        if (perTx > 0) l.perTx = perTx;
        if (perDay > 0) l.perDay = perDay;
        emit ChargeLimitSet(user, l.perTx, l.perDay);
    }

    function setChargeDefaultLimit(uint256 perTx, uint256 perDay) external override onlyOwner {
        require(perTx > 0 && perDay > 0, "ESCROW: zero limit");
        defaultPerTxLimit = perTx;
        defaultPerDayLimit = perDay;
        emit ChargeDefaultLimitSet(perTx, perDay);
    }

    function pause() external override onlyOwner {
        _pause();
    }

    function unpause() external override onlyOwner {
        _unpause();
    }

    // ================================================================
    // 只读
    // ================================================================
    function balanceOf(address user) external view override returns (uint256) {
        return _balances[user];
    }

    function erc20BalanceOf(address token, address user) external view override returns (uint256) {
        return _erc20Balances[token][user];
    }

    function chargedToday(address user, uint256 day) external view override returns (uint256) {
        return _dailyCharged[user][day];
    }

    function chargeLimitOf(address user) external view override returns (uint256 perTx, uint256 perDay) {
        return _chargeLimitOf(user);
    }

    function relayerEnabled(address relayer) external view override returns (bool) {
        return _relayers[relayer];
    }

    // ================================================================
    // 内部
    // ================================================================
    function _chargeLimitOf(address user) internal view returns (uint256 perTx, uint256 perDay) {
        ChargeLimit storage l = _chargeLimits[user];
        perTx = l.perTx > 0 ? l.perTx : defaultPerTxLimit;
        perDay = l.perDay > 0 ? l.perDay : defaultPerDayLimit;
    }

    function _today() internal view returns (uint256) {
        return block.timestamp / 1 days;
    }

    /// @notice UUPS 升级仅 owner，且要求已暂停（升级 = 暂停计费窗口）
    function _authorizeUpgrade(address) internal override onlyOwner {
        require(paused(), "ESCROW: upgrade requires pause");
    }

    /// @dev 接收原生资产兜底（含合约直接转账场景）
    receive() external payable {}
}
