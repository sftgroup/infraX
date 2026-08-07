import {
  encodeFunctionData,
  isHex,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { randomBytes } from 'node:crypto';
import type { ChainAAConfig, NetworkId, SessionPermission, SessionPolicy, TokenLimit } from './types.js';
import { ConfigError } from './errors.js';
import { encodeExecute } from './userop.js';

// ============================================================================
// Session Key 权限管理（对齐 §7.2-§7.3，角色 B 免确认交易核心）
// 安全边界：白名单 + 单笔/日限额 + 有效期；session key 无权改 owner。
// 生命周期：本地密钥生成 + 登记 → 一次 UserOp 安装 session validator（用户签 1 次）
//           → 有效期内免签名交易 → 撤销（本地即时失效 + 链上 disableSession）。
// 零硬编码：session validator 模块地址来自 chainConfig.sessionModule
//           （env AA_{CHAIN}_SESSION_MODULE），缺失抛 ConfigError。
// ============================================================================

// --- 本地登记表 ------------------------------------------------------------
// 多网络（P0.4 扩展）：每网络独立授权，登记表按 network 维度隔离；
// 同一 sessionId/signer 密钥可跨网络复用，但授权记录各自生效。

export interface SessionStore {
  list(accountAddress: Address, network: NetworkId): Promise<SessionPolicy[]>;
  save(policy: SessionPolicy, accountAddress: Address): Promise<void>;
  remove(sessionId: string, network: NetworkId): Promise<void>;
}

/** 内存登记表（MVP 默认；上线可注入持久化实现） */
export class InMemorySessionStore implements SessionStore {
  private readonly map = new Map<string, { accountAddress: Address; network: NetworkId; policy: SessionPolicy }>();

  async list(accountAddress: Address, network: NetworkId): Promise<SessionPolicy[]> {
    const out: SessionPolicy[] = [];
    for (const v of this.map.values()) {
      if (
        v.accountAddress.toLowerCase() === accountAddress.toLowerCase() &&
        v.network === network
      ) {
        out.push(v.policy);
      }
    }
    return out;
  }

  async save(policy: SessionPolicy, accountAddress: Address): Promise<void> {
    // 同网络下以 sessionId 为键；不同网络视为独立授权记录（同 id 覆盖仅限同网络）
    this.map.set(`${policy.network}:${policy.sessionId}`, { accountAddress, network: policy.network, policy });
  }

  async remove(sessionId: string, network: NetworkId): Promise<void> {
    this.map.delete(`${network}:${sessionId}`);
  }
}

/** 默认登记表（进程内共享） */
const defaultStore = new InMemorySessionStore();

// --- 创建 / 撤销 / 查询 ------------------------------------------------------

export interface CreateSessionParams {
  /** 所属网络（缺省 'evm'；Solana 阶段见 §12）。每网络独立授权 */
  network?: NetworkId;
  /** session key 公钥地址（缺省 = 本地新建密钥对） */
  signer?: Address;
  validUntil: bigint;
  validAfter?: bigint;
  permissions: SessionPermission[];
}

export interface CreateSessionResult {
  policy: SessionPolicy;
  /** 本地生成的 session key 私钥（signer 缺省时存在，交由 InfraX/客户端托管） */
  privateKey?: Hex;
}

/** 校验策略合法性（§7.3：targets 非空；有效期正序） */
export function assertValidPolicy(policy: Pick<SessionPolicy, 'validUntil' | 'validAfter' | 'permissions'>): void {
  if (policy.validUntil <= policy.validAfter) {
    throw new Error('[aa-sdk] invalid session: validUntil must be > validAfter');
  }
  if (!policy.permissions || policy.permissions.length === 0) {
    throw new Error('[aa-sdk] invalid session: at least one permission required');
  }
  for (const p of policy.permissions) {
    if (!p.targets || p.targets.length === 0) {
      throw new Error('[aa-sdk] invalid permission: targets must be non-empty (empty = nothing allowed)');
    }
  }
}

/**
 * 生成新 session key（本地 secp256k1 密钥对）并登记权限策略。
 * 链上 enable 通过 encodeEnableSessionCall 组装 UserOp 完成（用户签 1 次）。
 */
export async function createSessionKey(
  params: CreateSessionParams,
  accountAddress: Address,
  store: SessionStore = defaultStore,
): Promise<CreateSessionResult> {
  let privateKey: Hex | undefined;
  let signer: Address;
  if (params.signer) {
    signer = params.signer; // 外部托管（如 InfraX）的 session key
  } else {
    privateKey = generatePrivateKey(); // 本地新建密钥对
    signer = privateKeyToAccount(privateKey).address;
  }
  const policy: SessionPolicy = {
    network: params.network ?? 'evm',
    sessionId: toHex(randomBytes(32)), // 32 字节随机 sessionId（bytes32）
    signer,
    validAfter: params.validAfter ?? 0n,
    validUntil: params.validUntil,
    permissions: params.permissions,
  };
  assertValidPolicy(policy);
  await store.save(policy, accountAddress);
  return { policy, privateKey };
}

/**
 * 撤销 session key（本地登记即时失效；链上 disable 由调用方通过
 * encodeDisableSessionCall 组装 UserOp 完成，撤销后立即生效）。
 */
export async function revokeSessionKey(
  sessionId: string,
  network: NetworkId = 'evm',
  store: SessionStore = defaultStore,
): Promise<void> {
  await store.remove(sessionId, network);
}

/** 列出账户在指定网络的全部 session（本地登记表；链上全量索引待 M4 事件索引） */
export async function listSessions(
  accountAddress: Address,
  network: NetworkId = 'evm',
  store: SessionStore = defaultStore,
): Promise<SessionPolicy[]> {
  return store.list(accountAddress, network);
}

// --- 链上 enable/disable 编码（ERC-7579 validator 模块管理） ----------------

/** ERC-7579 MODULE_TYPE_VALIDATOR */
export const MODULE_TYPE_VALIDATOR = 1n;

/** 任意地址转账哨兵（P0.12 §7.6）：enableSession calls 中 target=哨兵地址表示原生币任意转账授权 */
export const ANY_TRANSFER_SENTINEL = '0x0000000000000000000000000000000000000001' as Address;

/**
 * 单条 CallPermission（对齐链上 KernelSessionWithTokenLimitModule.CallPermission 结构）：
 * 由 enableSession 的 calls 数组元素直接编码，不再预编码为 bytes。
 */
export interface CallPermission {
  target: Address;
  selectors: Hex[];
  valueLimit: bigint;
  countLimit: bigint;
}

/** 由 SessionPermission 展开为链上 CallPermission（§7.3：selectors 空 = 全部方法） */
function toCallPermission(target: Address, p: SessionPermission): CallPermission {
  return {
    target,
    selectors: [...(p.selectors ?? [])],
    valueLimit: p.valueLimit ?? 0n,
    countLimit: BigInt(p.countLimit ?? 0),
  };
}

/**
 * Kernel v3 session validator 模块 ABI（对齐 ZeroDev KernelSessionModule / 链上 P0.12 模块
 * enableSession(bytes32,address,uint48,uint48,CallPermission[]) 真实签名，selector 0x7d993787）。
 */
const SessionModuleAbi = [
  {
    type: 'function',
    name: 'enableSession',
    inputs: [
      { name: 'sessionId', type: 'bytes32' },
      { name: 'sessionKey', type: 'address' },
      { name: 'validUntil', type: 'uint48' },
      { name: 'validAfter', type: 'uint48' },
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'selectors', type: 'bytes4[]' },
          { name: 'valueLimit', type: 'uint256' },
          { name: 'countLimit', type: 'uint256' },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'disableSession',
    inputs: [{ name: 'sessionId', type: 'bytes32' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

/** ERC-7579 标准模块安装/卸载接口 */
const ERC7579ModuleManagerAbi = [
  {
    type: 'function',
    name: 'installModule',
    inputs: [
      { name: 'moduleTypeId', type: 'uint256' },
      { name: 'module', type: 'address' },
      { name: 'initData', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'uninstallModule',
    inputs: [
      { name: 'moduleTypeId', type: 'uint256' },
      { name: 'module', type: 'address' },
      { name: 'deInitData', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

/**
 * session 模块数据序列化器：把策略/撤销请求编码为模块 enable/disable 数据。
 * 接口化以便部署阶段按真实模块契约校准（默认实现见 KernelV3SessionDataBuilder）。
 */
export interface SessionModuleDataBuilder {
  enableData(policy: SessionPolicy): Hex;
  disableData(sessionId: string): Hex;
}

function toBytes32(id: string): Hex {
  return (isHex(id) && id.length === 66 ? id : toHex(id, { size: 32 })) as Hex;
}

/**
 * 增强 session 模块 ABI（P0.12 §7.5）：KernelSessionWithTokenLimitModule 的
 * enableSession 增加 tokenLimits 参数（per-token 单笔/日限额）。
 * calls 为 CallPermission[] tuple（与链上真实签名一致，selector 0xc620957b）。
 */
const EnhancedSessionModuleAbi = [
  {
    type: 'function',
    name: 'enableSession',
    inputs: [
      { name: 'sessionId', type: 'bytes32' },
      { name: 'sessionKey', type: 'address' },
      { name: 'validUntil', type: 'uint48' },
      { name: 'validAfter', type: 'uint48' },
      {
        name: 'tokenLimits',
        type: 'tuple[]',
        components: [
          { name: 'token', type: 'address' },
          { name: 'maxPerTx', type: 'uint256' },
          { name: 'maxDaily', type: 'uint256' },
        ],
      },
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'selectors', type: 'bytes4[]' },
          { name: 'valueLimit', type: 'uint256' },
          { name: 'countLimit', type: 'uint256' },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

/**
 * 默认序列化器（P0.12 扩展）：permission.targets 逐一展开为 call 条目；
 * 含 tokenLimits / allowAnyTransfer 时切换增强模块 6 参数编码（§7.5-§7.6）：
 *  - tokenLimits = 各 permission.tokenLimits + allowAnyTransfer 哨兵条目（token=ANY_TRANSFER_SENTINEL）
 *  - calls 追加哨兵 target 条目（valueLimit = maxPerTx）
 */
export const KernelV3SessionDataBuilder: SessionModuleDataBuilder = {
  enableData(policy: SessionPolicy): Hex {
    const hasTokenLimits = policy.permissions.some((p) => (p.tokenLimits?.length ?? 0) > 0);
    const hasAnyTransfer = policy.permissions.some((p) => p.allowAnyTransfer !== undefined);
    if (!hasTokenLimits && !hasAnyTransfer) {
      // 原 5 参数编码（兼容 ZeroDev KernelSessionModule / 链上 5 参数重载，selector 0x7d993787）
      const calls = policy.permissions.flatMap((p) => p.targets.map((t) => toCallPermission(t, p)));
      return encodeFunctionData({
        abi: SessionModuleAbi,
        functionName: 'enableSession',
        args: [toBytes32(policy.sessionId), policy.signer, Number(policy.validUntil), Number(policy.validAfter), calls],
      });
    }
    // 增强 6 参数编码（KernelSessionWithTokenLimitModule，selector 0xc620957b）
    const tokenLimits: TokenLimit[] = policy.permissions.flatMap((p) => {
      const own = p.tokenLimits ?? [];
      const sentinel = p.allowAnyTransfer
        ? [{ token: ANY_TRANSFER_SENTINEL, maxPerTx: p.allowAnyTransfer.maxPerTx, maxDaily: p.allowAnyTransfer.maxDaily }]
        : [];
      return [...own, ...sentinel];
    });
    const calls = policy.permissions.flatMap((p) => {
      const base = p.targets.map((t) => toCallPermission(t, p));
      const sentinelCall = p.allowAnyTransfer
        ? [{
            target: ANY_TRANSFER_SENTINEL,
            selectors: [],
            valueLimit: p.allowAnyTransfer.maxPerTx,
            countLimit: 0n,
          } satisfies CallPermission]
        : [];
      return [...base, ...sentinelCall];
    });
    return encodeFunctionData({
      abi: EnhancedSessionModuleAbi,
      functionName: 'enableSession',
      args: [
        toBytes32(policy.sessionId),
        policy.signer,
        Number(policy.validUntil),
        Number(policy.validAfter),
        tokenLimits, // tuple[] 直接传对象数组，由 viem 编码
        calls,
      ],
    });
  },
  disableData(sessionId: string): Hex {
    return encodeFunctionData({
      abi: SessionModuleAbi,
      functionName: 'disableSession',
      args: [toBytes32(sessionId)],
    });
  },
};

function resolveSessionModule(chainConfig: ChainAAConfig): Address {
  if (!chainConfig.sessionModule) {
    throw new ConfigError(
      `[aa-sdk] missing sessionModule for chain ${chainConfig.chainId} (set AA_${chainConfig.chainId}_SESSION_MODULE)`,
    );
  }
  return chainConfig.sessionModule;
}

export interface EnableSessionCallParams {
  accountAddress: Address;
  policy: SessionPolicy;
  chainConfig: ChainAAConfig;
  dataBuilder?: SessionModuleDataBuilder;
}

/**
 * 编码安装 session validator 的 UserOp callData（Kernel execute → ERC-7579
 * installModule(VALIDATOR, sessionModule, enableData)）。调用方据此组装 UserOp 并签名。
 */
export function encodeEnableSessionCall(params: EnableSessionCallParams): Hex {
  const module = resolveSessionModule(params.chainConfig);
  const builder = params.dataBuilder ?? KernelV3SessionDataBuilder;
  const installCalldata = encodeFunctionData({
    abi: ERC7579ModuleManagerAbi,
    functionName: 'installModule',
    args: [MODULE_TYPE_VALIDATOR, module, builder.enableData(params.policy)],
  });
  return encodeExecute(params.accountAddress, 0n, installCalldata);
}

export interface DisableSessionCallParams {
  accountAddress: Address;
  sessionId: string;
  chainConfig: ChainAAConfig;
  dataBuilder?: SessionModuleDataBuilder;
}

/** 编码卸载 session validator 的 UserOp callData（uninstallModule → disableSession） */
export function encodeDisableSessionCall(params: DisableSessionCallParams): Hex {
  const module = resolveSessionModule(params.chainConfig);
  const builder = params.dataBuilder ?? KernelV3SessionDataBuilder;
  const uninstallCalldata = encodeFunctionData({
    abi: ERC7579ModuleManagerAbi,
    functionName: 'uninstallModule',
    args: [MODULE_TYPE_VALIDATOR, module, builder.disableData(params.sessionId)],
  });
  return encodeExecute(params.accountAddress, 0n, uninstallCalldata);
}

// --- 权限校验（纯函数，可单测） ----------------------------------------------

/** 一次待校验的调用（P0.12 扩展：amount/anyTransfer） */
export interface SessionCall {
  target: Address;
  selector: Hex;
  value: bigint;
  /** ERC-20 金额（§7.5）：标准 transfer/approve 的 amount（末位 uint256 参数） */
  amount?: bigint;
  /** 原生币任意转账（§7.6）：调用方声明 data 为空（纯转账）；目标非合约由链上强制 */
  anyTransfer?: boolean;
}

/**
 * 权限校验：校验一次调用是否被策略允许。
 * 规则（§7.3 + §7.5 + §7.6）：target 白名单 + selector 白名单 + 单笔限额 + 日限额
 * + 有效期 + ERC-20 金额级限额（tokenLimits）+ 任意地址转账（allowAnyTransfer）。
 * 白名单必须显式包含；空列表 = 全部禁止（安全默认）。
 */
export function validateSessionCall(
  policy: SessionPolicy,
  call: SessionCall,
  nowSec: bigint,
  todayUsed?: bigint,
  todayTokenUsed?: Record<string, bigint>,
): { ok: boolean; reason?: string } {
  if (nowSec < policy.validAfter || nowSec > policy.validUntil) {
    return { ok: false, reason: 'session expired' };
  }
  for (const p of policy.permissions) {
    // §7.6 任意地址转账：哨兵授权 + 调用方声明纯转账
    if (p.allowAnyTransfer && call.anyTransfer) {
      if (p.allowAnyTransfer.maxPerTx > 0n && call.value > p.allowAnyTransfer.maxPerTx) {
        return { ok: false, reason: 'transfer exceeds single-tx limit' };
      }
      if (p.allowAnyTransfer.maxDaily > 0n && todayUsed !== undefined && todayUsed + call.value > p.allowAnyTransfer.maxDaily) {
        return { ok: false, reason: 'transfer exceeds daily limit' };
      }
      return { ok: true };
    }
    if (p.targets.length === 0 || !p.targets.some((t) => t.toLowerCase() === call.target.toLowerCase())) {
      continue; // 不在本 permission 的目标白名单，尝试下一条
    }
    if (!p.selectors || p.selectors.length === 0 || !p.selectors.some((s) => s.toLowerCase() === call.selector.toLowerCase())) {
      continue;
    }
    if (p.valueLimit && p.valueLimit > 0n && call.value > p.valueLimit) {
      return { ok: false, reason: 'value exceeds single-tx limit' };
    }
    if (p.dailyLimit && p.dailyLimit > 0n && todayUsed !== undefined && todayUsed + call.value > p.dailyLimit) {
      return { ok: false, reason: 'exceeds daily limit' };
    }
    // §7.5 ERC-20 金额级限额：target 命中 tokenLimits 中某 token → 校验单笔/日累计
    const tl = (p.tokenLimits ?? []).find((t) => t.token.toLowerCase() === call.target.toLowerCase());
    if (tl) {
      if (call.amount === undefined) {
        return { ok: false, reason: 'token amount required for limited token' };
      }
      if (tl.maxPerTx > 0n && call.amount > tl.maxPerTx) {
        return { ok: false, reason: 'token amount exceeds single-tx limit' };
      }
      if (tl.maxDaily > 0n && todayTokenUsed !== undefined) {
        const used = todayTokenUsed[tl.token.toLowerCase()] ?? 0n;
        if (used + call.amount > tl.maxDaily) {
          return { ok: false, reason: 'token exceeds daily limit' };
        }
      }
    }
    return { ok: true };
  }
  return { ok: false, reason: 'no matching permission' };
}
