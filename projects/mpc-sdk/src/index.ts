/**
 * @0xinfrax/mpc-sdk
 *
 * InfraX MPC 独立轻量 SDK（MQ-10 补充 E-5）——三个模块：
 *   - 钱包模块 WalletModule（6 方法）：sendCode / register / recover / status / listWallets / createWallet
 *   - 会话模块 SessionModule（3 方法）：unlock / lock / status
 *   - 链上模块 ChainModule（7 方法，E-5d）：balance / signMessage / signTypedData / sendTransaction /
 *     contractRead / contractWrite / gasEstimate
 *
 * 不依赖 infrax-dk，仅面向 MPC 微服务契约（/api/v2/mpc/*），出站鉴权统一 X-API-Key。
 *
 * 用法：
 *   import { MpcClient } from '@0xinfrax/mpc-sdk';
 *   const mpc = new MpcClient({ baseUrl: 'http://127.0.0.1:9104', apiKey: process.env.MPC_API_KEY });
 *   await mpc.wallet.sendCode({ email: 'a@b.com' });
 *   await mpc.wallet.register({ email: 'a@b.com', code: '123456' });
 *   const s = await mpc.session.unlock({ email: 'a@b.com', code: '123456' });
 *   const token = s.data.token;
 *   await mpc.chain.signMessage({ token, message: 'hello' });
 *   await mpc.chain.sendTransaction({ token, to: '0x...', amount: '0.01', chain: 'sepolia' });
 *   await mpc.session.lock(token);
 */
import { HttpClient } from './http';
import { WalletModule } from './wallet';
import { SessionModule } from './session';
import { ChainModule } from './chain';
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
  MPCWalletsListParams,
  MPCWalletsListResult,
  MPCSessionUnlockParams,
  MPCSessionUnlockResult,
  MPCSessionLockResult,
  MPCSessionStatusParams,
  MPCSessionStatusResult,
  MPCChainBaseParams,
  MPCBalanceParams,
  MPCBalanceResult,
  MPCBalanceTokenResult,
  MPCSignMessageParams,
  MPCSignTypedDataParams,
  MPCSignResult,
  MPCSendTransactionParams,
  MPCSendTransactionResult,
  MPCContractReadParams,
  MPCContractReadResult,
  MPCContractWriteParams,
  MPCContractWriteResult,
  MPCGasEstimateParams,
  MPCGasEstimateResult,
} from './types';

export class MpcClient {
  /** 钱包模块（6 方法） */
  readonly wallet: WalletModule;
  /** 会话模块（3 方法） */
  readonly session: SessionModule;
  /** 链上模块（7 方法，E-5d） */
  readonly chain: ChainModule;
  private http: HttpClient;

  constructor(config: MpcClientConfig = {}) {
    this.http = new HttpClient(config);
    this.wallet = new WalletModule(this.http);
    this.session = new SessionModule(this.http);
    this.chain = new ChainModule(this.http);
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
