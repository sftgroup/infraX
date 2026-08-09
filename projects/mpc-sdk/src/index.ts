/**
 * @0xinfrax/mpc-sdk
 *
 * InfraX MPC 独立轻量 SDK（MQ-10 补充 E-5）——首期实现两个模块：
 *   - 钱包模块 WalletModule（5 方法）：sendCode / register / recover / status / createWallet
 *   - 会话模块 SessionModule（3 方法）：unlock / lock / status
 *
 * 不依赖 infrax-dk，仅面向 MPC 微服务契约（/api/v2/mpc/*），出站鉴权统一 X-API-Key。
 *
 * 用法：
 *   import { MpcClient } from '@0xinfrax/mpc-sdk';
 *   const mpc = new MpcClient({ baseUrl: 'http://127.0.0.1:9104', apiKey: process.env.MPC_API_KEY });
 *   await mpc.wallet.sendCode({ email: 'a@b.com' });
 *   await mpc.wallet.register({ email: 'a@b.com', code: '123456' });
 *   const s = await mpc.session.unlock({ email: 'a@b.com', code: '123456' });
 *   const st = await mpc.session.status({ token: s.data.token });
 *   await mpc.session.lock(s.data.token);
 */
import { HttpClient } from './http';
import { WalletModule } from './wallet';
import { SessionModule } from './session';
import type { MpcClientConfig } from './types';

export { MpcApiError, MpcNetworkError, classifyError, MPC_ERR_CODE, MPC_SDK_ERR_CODE } from './errors';
export type { MpcErrorKind } from './errors';
export type {
  MpcApiResponse,
  MpcClientConfig,
  MPCSendCodeParams,
  MPCSendCodeResult,
  MPCRegisterParams,
  MPCWalletResult,
  MPCRecoverParams,
  MPCRecoverResult,
  MPCStatusParams,
  MPCStatusResult,
  MPCSessionUnlockParams,
  MPCSessionUnlockResult,
  MPCSessionLockResult,
  MPCSessionStatusParams,
  MPCSessionStatusResult,
} from './types';

export class MpcClient {
  /** 钱包模块（5 方法） */
  readonly wallet: WalletModule;
  /** 会话模块（3 方法） */
  readonly session: SessionModule;
  private http: HttpClient;

  constructor(config: MpcClientConfig = {}) {
    this.http = new HttpClient(config);
    this.wallet = new WalletModule(this.http);
    this.session = new SessionModule(this.http);
  }

  /** 运行时切换鉴权 key */
  setApiKey(key: string): void {
    this.http.setApiKey(key);
  }

  get baseUrl(): string {
    return this.http.base;
  }
}

export default MpcClient;
