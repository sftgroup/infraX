import { encodeFunctionData, type Address, type Hex } from 'viem';
import type { UserOperationV7 } from './types.js';
import { buildUserOp, type BuildUserOpParams } from './userop.js';

// ============================================================================
// InfraXEscrow 充值构建（REQ-1 / REQ-5，docs/AA_RELAY_BILLING.md §5）
//
// 计费主体是智能账户（op.sender）时，relay 服务费预扣来源于子账户的
// InfraXEscrow `_balances[account]`。AgentX 等调用方通过本模块：
//   1. EOA 直连（非 UserOp）：`InfraXEscrowAbi` + viem writeContract 调
//      `depositFor(user)` / `depositForBatch(users, amounts)` 代充值；
//   2. 智能账户自付（session key 兜底）：buildDepositFor*UserOp 组合
//      Kernel v3 execute / executeBatch 构建 UserOp（ERC-7579）。
//
// 函数 ABI 对齐 projects/escrow/contracts/interfaces/IInfraXEscrow.sol。
// ============================================================================

/** InfraXEscrow 充值函数 ABI（deposit/depositFor/depositForBatch/depositForERC20/depositForERC20Batch） */
export const InfraXEscrowAbi = [
  {
    type: 'function',
    name: 'deposit',
    inputs: [],
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'depositFor',
    inputs: [{ name: 'user', type: 'address', internalType: 'address' }],
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'depositForBatch',
    inputs: [
      { name: 'users', type: 'address[]', internalType: 'address[]' },
      { name: 'amounts', type: 'uint256[]', internalType: 'uint256[]' },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'depositForERC20',
    inputs: [
      { name: 'token', type: 'address', internalType: 'address' },
      { name: 'amount', type: 'uint256', internalType: 'uint256' },
      { name: 'user', type: 'address', internalType: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'depositForERC20Batch',
    inputs: [
      { name: 'token', type: 'address', internalType: 'address' },
      { name: 'users', type: 'address[]', internalType: 'address[]' },
      { name: 'amounts', type: 'uint256[]', internalType: 'uint256[]' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

/** 编码 `deposit()`：msg.sender 自身入账（智能账户自付时 msg.sender = 账户自身） */
export function encodeDeposit(): Hex {
  return encodeFunctionData({ abi: InfraXEscrowAbi, functionName: 'deposit', args: [] });
}

/** 编码 `depositFor(address user)`：msg.sender 支付、user 入账（REQ-1） */
export function encodeDepositFor(user: Address): Hex {
  return encodeFunctionData({ abi: InfraXEscrowAbi, functionName: 'depositFor', args: [user] });
}

/** 编码 `depositForBatch(address[] users, uint256[] amounts)`：单 tx 多账户（REQ-5，msg.value 须等于各额之和） */
export function encodeDepositForBatch(users: Address[], amounts: bigint[]): Hex {
  return encodeFunctionData({
    abi: InfraXEscrowAbi,
    functionName: 'depositForBatch',
    args: [users, amounts],
  });
}

/** 编码 `depositForERC20(address token, uint256 amount, address user)`（REQ-1，需 msg.sender 已授权 token） */
export function encodeDepositForERC20(token: Address, amount: bigint, user: Address): Hex {
  return encodeFunctionData({
    abi: InfraXEscrowAbi,
    functionName: 'depositForERC20',
    args: [token, amount, user],
  });
}

/** 编码 `depositForERC20Batch(address token, address[] users, uint256[] amounts)`（REQ-5） */
export function encodeDepositForERC20Batch(token: Address, users: Address[], amounts: bigint[]): Hex {
  return encodeFunctionData({
    abi: InfraXEscrowAbi,
    functionName: 'depositForERC20Batch',
    args: [token, users, amounts],
  });
}

// ----------------------------------------------------------------------------
// UserOp 构建（智能账户执行路径，Kernel v3 execute / executeBatch）
// ----------------------------------------------------------------------------

/** gas 可选段复用 buildUserOp 的类型定义（防两处定义漂移） */
export type EscrowGasParams = BuildUserOpParams['gas'];

/** 四个 UserOp 构建器共用的 Kernel execute 调用参数 */
interface DepositCall {
  target: Address;
  value: bigint;
  data: Hex;
}

/** 收敛构建：sender/nonce/factory/gas 公共段 → buildUserOp，call 由各充值函数注入 */
function buildDepositUserOp(
  params: Pick<BuildDepositForUserOpParams, 'sender' | 'nonce' | 'factory' | 'factoryData' | 'gas'>,
  call: DepositCall,
): UserOperationV7 {
  return buildUserOp({
    sender: params.sender,
    nonce: params.nonce,
    call,
    factory: params.factory,
    factoryData: params.factoryData,
    gas: params.gas,
  });
}

export interface BuildDepositForUserOpParams {
  sender: Address;
  nonce: bigint;
  /** InfraXEscrow 合约地址 */
  escrow: Address;
  /** 充值额（wei，native） */
  amount: bigint;
  /** 入账对象（计费主体智能账户） */
  user: Address;
  /** 首次部署时携带（§5.4 counterfactual） */
  factory?: Address;
  factoryData?: Hex;
  gas?: EscrowGasParams;
}

export interface BuildDepositForBatchUserOpParams {
  sender: Address;
  nonce: bigint;
  /** InfraXEscrow 合约地址 */
  escrow: Address;
  /** 入账对象列表（须与 amounts 等长） */
  users: Address[];
  /** 各账户充值额（wei，native；须与 users 等长，总额 = msg.value） */
  amounts: bigint[];
  factory?: Address;
  factoryData?: Hex;
  gas?: EscrowGasParams;
}

export interface BuildDepositForERC20UserOpParams {
  sender: Address;
  nonce: bigint;
  /** InfraXEscrow 合约地址 */
  escrow: Address;
  /** ERC20 token 地址（须已对 sender 授权） */
  token: Address;
  amount: bigint;
  /** 入账对象（计费主体智能账户） */
  user: Address;
  factory?: Address;
  factoryData?: Hex;
  gas?: EscrowGasParams;
}

export interface BuildDepositForERC20BatchUserOpParams {
  sender: Address;
  nonce: bigint;
  /** InfraXEscrow 合约地址 */
  escrow: Address;
  /** ERC20 token 地址（须已对 sender 授权） */
  token: Address;
  /** 入账对象列表（须与 amounts 等长） */
  users: Address[];
  /** 各账户充值额（须与 users 等长） */
  amounts: bigint[];
  factory?: Address;
  factoryData?: Hex;
  gas?: EscrowGasParams;
}

/**
 * 构建单账户原生充值 UserOp：
 *   callData = execute(escrow, amount, depositFor(user))
 * （Kernel 带 value 调 escrow，msg.sender = 智能账户、user 入账）
 */
export function buildDepositForUserOp(params: BuildDepositForUserOpParams): UserOperationV7 {
  return buildDepositUserOp(params, { target: params.escrow, value: params.amount, data: encodeDepositFor(params.user) });
}

/**
 * 构建多账户原生批量充值 UserOp（REQ-5）：
 *   callData = execute(escrow, Σamounts, depositForBatch(users, amounts))
 * ⚠️ users/amounts 必须等长，否则抛错（防链上 revert）。
 */
export function buildDepositForBatchUserOp(params: BuildDepositForBatchUserOpParams): UserOperationV7 {
  if (params.users.length !== params.amounts.length) {
    throw new Error(
      `[aa-sdk] depositForBatch: users(${params.users.length})/amounts(${params.amounts.length}) length mismatch`,
    );
  }
  const total = params.amounts.reduce((a, b) => a + b, 0n);
  return buildDepositUserOp(params, {
    target: params.escrow,
    value: total,
    data: encodeDepositForBatch(params.users, params.amounts),
  });
}

/**
 * 构建单账户 ERC20 充值 UserOp：
 *   callData = execute(escrow, 0, depositForERC20(token, amount, user))
 * ⚠️ 前置条件：sender 需先 approve token 给 escrow（transferFrom 拉款）。
 */
export function buildDepositForERC20UserOp(params: BuildDepositForERC20UserOpParams): UserOperationV7 {
  return buildDepositUserOp(params, {
    target: params.escrow,
    value: 0n,
    data: encodeDepositForERC20(params.token, params.amount, params.user),
  });
}

/**
 * 构建多账户 ERC20 批量充值 UserOp（REQ-5）：
 *   callData = execute(escrow, 0, depositForERC20Batch(token, users, amounts))
 * ⚠️ users/amounts 必须等长；前置条件：sender 已 approve token 给 escrow。
 */
export function buildDepositForERC20BatchUserOp(params: BuildDepositForERC20BatchUserOpParams): UserOperationV7 {
  if (params.users.length !== params.amounts.length) {
    throw new Error(
      `[aa-sdk] depositForERC20Batch: users(${params.users.length})/amounts(${params.amounts.length}) length mismatch`,
    );
  }
  return buildDepositUserOp(params, {
    target: params.escrow,
    value: 0n,
    data: encodeDepositForERC20Batch(params.token, params.users, params.amounts),
  });
}
