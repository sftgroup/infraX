/**
 * @0xinfrax/mpc-sdk — 钱包模块（E-5b，5 tools）
 *
 * sendCode / register / recover / status / createWallet
 * 端点：/api/v2/mpc/{send-code,register,recover,status}
 *
 * recover 为「邮箱验证码 → 服务端分片重建 → 地址校验」完整流程封装：
 *   1. 服务端校验验证码 + 重建私钥并核对钱包地址（key mismatch → 1008）
 *   2. 客户端若传入 expectedAddress，二次校验恢复地址一致性
 *      （不一致 → MpcApiError 409 / 40900，对应 E-5e 恢复失败分支语义）
 */
import { MpcApiError, MPC_SDK_ERR_CODE } from './errors';
import type { HttpClient } from './http';
import type {
  MpcApiResponse,
  MPCRecoverParams,
  MPCRecoverResult,
  MPCRegisterParams,
  MPCSendCodeParams,
  MPCSendCodeResult,
  MPCStatusParams,
  MPCStatusResult,
  MPCWalletResult,
} from './types';

export class WalletModule {
  constructor(private http: HttpClient) {}

  /** 下发 6 位验证码到邮箱（注册/恢复/解锁共用） */
  async sendCode(params: MPCSendCodeParams): Promise<MpcApiResponse<MPCSendCodeResult>> {
    return this.http.post<MPCSendCodeResult>('/api/v2/mpc/send-code', params);
  }

  /** 注册托管钱包：验证码 + 生成 EOA + 分片加密落库 */
  async register(params: MPCRegisterParams): Promise<MpcApiResponse<MPCWalletResult>> {
    return this.http.post<MPCWalletResult>('/api/v2/mpc/register', params);
  }

  /**
   * 邮箱恢复钱包：完整流程封装（E-5e）。
   * @param params.email 注册邮箱
   * @param params.code  邮箱验证码
   * @param params.expectedAddress 可选：期望地址，恢复成功后客户端校验
   * @throws MpcApiError — 验证码错误/过期（400/1001）、尝试超限（429）、
   *         未注册（404/1004）、分片解密失败（500/1007）、地址不一致（409/40900）
   */
  async recover(params: MPCRecoverParams): Promise<MpcApiResponse<MPCRecoverResult>> {
    const res = await this.http.post<MPCRecoverResult>('/api/v2/mpc/recover', {
      email: params.email,
      code: params.code,
    });
    if (params.expectedAddress) {
      const recovered = res.data.walletAddress;
      if (recovered.toLowerCase() !== params.expectedAddress.toLowerCase()) {
        throw new MpcApiError(
          409,
          MPC_SDK_ERR_CODE.RECOVER_ADDRESS_MISMATCH,
          `Recovered address ${recovered} does not match expectedAddress ${params.expectedAddress}`
        );
      }
    }
    return res;
  }

  /** 查询钱包状态：email 或 walletAddress 双查询键二选一 */
  async status(params: MPCStatusParams): Promise<MpcApiResponse<MPCStatusResult>> {
    return this.http.get<MPCStatusResult>('/api/v2/mpc/status', {
      email: params.email,
      walletAddress: params.walletAddress,
    });
  }

  /**
   * 创建钱包（组合入口）：先下发验证码，拿到 code 后调 register 完成注册。
   * 返回后由调用方用邮箱收到的 code 调 {@link WalletModule.register}。
   */
  async createWallet(params: MPCSendCodeParams): Promise<MpcApiResponse<MPCSendCodeResult>> {
    return this.sendCode(params);
  }
}
