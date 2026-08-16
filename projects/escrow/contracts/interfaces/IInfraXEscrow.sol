// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IInfraXEscrow
 * @notice InfraX 平台托管记账合约接口（OE-1，2026-08-16）
 *         计费语义：charge/refund 均为 storage 原子记账（无真实转账），
 *         ledger 降级为索引/对账层后，本合约是资金状态唯一权威源。
 */
interface IInfraXEscrow {
    // ---- 事件（供对账/索引） ----
    event Deposited(address indexed user, uint256 amount, address token);
    event Withdrawn(address indexed user, uint256 amount, address token);
    event Charged(address indexed user, uint256 amount, string ref);
    event Refunded(address indexed user, uint256 amount, string ref);
    event RelayerSet(address indexed relayer, bool enabled);
    event ChargeLimitSet(address indexed user, uint256 perTx, uint256 perDay);
    event ChargeDefaultLimitSet(uint256 perTx, uint256 perDay);

    // ---- 用户侧 ----
    /// @notice 原生资产存管（msg.sender 入账）
    function deposit() external payable;

    /// @notice ERC20 存管（msg.sender 入账，safeTransferFrom）
    function depositERC20(address token, uint256 amount) external;

    /// @notice 原生资产提现（仅 msg.sender 本人余额，CEI + ReentrancyGuard）
    function withdraw(uint256 amount) external;

    /// @notice ERC20 提现（仅 msg.sender 本人余额）
    function withdrawERC20(address token, uint256 amount) external;

    /// @notice 原生余额（wei）
    function balanceOf(address user) external view returns (uint256);

    /// @notice ERC20 余额
    function erc20BalanceOf(address token, address user) external view returns (uint256);

    /// @notice 用户单日累计扣款（day = block.timestamp / 86400）
    function chargedToday(address user, uint256 day) external view returns (uint256);

    /// @notice 用户扣款限额（perTx / perDay，0 = 使用默认限额）
    function chargeLimitOf(address user) external view returns (uint256 perTx, uint256 perDay);

    // ---- 计费侧（仅授权 Relayer 或 Owner，受限额约束） ----
    /// @notice 链上原子预扣（storage 记账），返回扣后余额；超余额/超限额 revert
    function charge(address user, uint256 amount, string calldata ref) external returns (uint256 newBal);

    /// @notice 链上原子退差（storage 记账，同时回退当日累计），返回扣后余额
    function refund(address user, uint256 amount, string calldata ref) external returns (uint256 newBal);

    // ---- 治理侧（仅 Owner，智能合约直接治理，无外部多签） ----
    /// @notice 授权/撤销 relayer 扣款权
    function setRelayer(address relayer, bool enabled) external;

    /// @notice 设置用户级扣款限额（perTx=0 保留现值；perDay=0 保留现值）
    function setChargeLimit(address user, uint256 perTx, uint256 perDay) external;

    /// @notice 设置默认扣款限额（仅影响未单独设置的用户）
    function setChargeDefaultLimit(uint256 perTx, uint256 perDay) external;

    /// @notice 冻结计费（charge/refund 停用；存管/提现不受阻，用户资产随时可取）
    function pause() external;

    function unpause() external;

    // ---- 只读 ----
    function relayerEnabled(address relayer) external view returns (bool);
}
