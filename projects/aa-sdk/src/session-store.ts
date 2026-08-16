import { toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { randomBytes } from 'node:crypto';
import type { Address, Hex } from 'viem';
import type { NetworkId, SessionPermission, SessionPolicy } from './types.js';

// ============================================================================
// Session 本地登记表 + 生命周期管理（对齐 §7.2-§7.3，角色 B 免确认交易核心）
// 安全边界：白名单 + 单笔/日限额 + 有效期；session key 无权改 owner。
// 生命周期：本地密钥生成 + 登记 → 一次 UserOp 安装 session validator（用户签 1 次）
//           → 有效期内免签名交易 → 撤销（本地即时失效 + 链上 disableSession）。
// 多网络（P0.4 扩展）：每网络独立授权，登记表按 network 维度隔离；
// 同一 sessionId/signer 密钥可跨网络复用，但授权记录各自生效。
// ============================================================================

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
