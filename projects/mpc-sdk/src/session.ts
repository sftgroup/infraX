/**
 * @0xinfrax/mpc-sdk — 会话模块（E-5c，3 tools）
 *
 * unlockSession / lockSession / sessionStatus
 * 端点：/api/v2/mpc/session/{unlock,lock,status}
 *
 * 会话令牌（token）为后续链上操作（balance/signMessage/…）的凭证；
 * 过期时间由服务端控制（生产 SESSION_TTL_MS=30min）。
 */
import type { HttpClient } from './http';
import type {
  MpcApiResponse,
  MPCSessionLockResult,
  MPCSessionStatusParams,
  MPCSessionStatusResult,
  MPCSessionUnlockParams,
  MPCSessionUnlockResult,
} from './types';

export class SessionModule {
  constructor(private http: HttpClient) {}

  /** 解锁会话：验证码二次验证邮箱所有权 → 返回 mpc_ 前缀令牌 */
  async unlock(params: MPCSessionUnlockParams): Promise<MpcApiResponse<MPCSessionUnlockResult>> {
    return this.http.post<MPCSessionUnlockResult>('/api/v2/mpc/session/unlock', params);
  }

  /** 锁定会话：立即使令牌失效 */
  async lock(token: string): Promise<MpcApiResponse<MPCSessionLockResult>> {
    return this.http.post<MPCSessionLockResult>('/api/v2/mpc/session/lock', { token });
  }

  /** 会话状态查询（含剩余秒数） */
  async status(params: MPCSessionStatusParams): Promise<MpcApiResponse<MPCSessionStatusResult>> {
    return this.http.get<MPCSessionStatusResult>('/api/v2/mpc/session/status', { token: params.token });
  }
}
