/**
 * @0xinfrax/mpc-sdk — 链上模块（E-5d，7 tools）
 *
 * balance / signMessage / signTypedData / sendTransaction / contractRead / contractWrite / gasEstimate
 * 端点：/api/v2/mpc/{balance,sign-message,sign-typed-data,send-transaction,contract-read,contract-write,gas-estimate}
 *
 * 对齐服务端 M3 契约：签名端点 Node 侧算摘要（EIP-191 / EIP-712）交 TSS 2-of-2 分片签名，
 * 交易类端点由服务端组装 tx/calldata 并广播，SDK 仅透传 JSON 安全类型（bigint → string）。
 */
import type { HttpClient } from './http';
import type {
  MpcApiResponse,
  MPCBalanceParams,
  MPCBalanceResult,
  MPCContractReadParams,
  MPCContractReadResult,
  MPCContractWriteParams,
  MPCContractWriteResult,
  MPCGasEstimateParams,
  MPCGasEstimateResult,
  MPCSendTransactionParams,
  MPCSendTransactionResult,
  MPCSignMessageParams,
  MPCSignResult,
  MPCSignTypedDataParams,
} from './types';

export class ChainModule {
  constructor(private http: HttpClient) {}

  /** 查询钱包余额：原生币；传入 tokenAddress 附带 ERC20 余额/symbol/decimals */
  async balance(params: MPCBalanceParams): Promise<MpcApiResponse<MPCBalanceResult>> {
    return this.http.post<MPCBalanceResult>('/api/v2/mpc/balance', params);
  }

  /** EIP-191 personal_sign 语义消息签名（服务端算摘要 + TSS 分片签名） */
  async signMessage(params: MPCSignMessageParams): Promise<MpcApiResponse<MPCSignResult>> {
    return this.http.post<MPCSignResult>('/api/v2/mpc/sign-message', params);
  }

  /** EIP-712 结构化数据签名（domain/types/value 原样透传，服务端 TypedDataEncoder.hash） */
  async signTypedData(params: MPCSignTypedDataParams): Promise<MpcApiResponse<MPCSignResult>> {
    return this.http.post<MPCSignResult>('/api/v2/mpc/sign-typed-data', params);
  }

  /** 发送交易：原生币转账；传入 tokenAddress = ERC20 transfer */
  async sendTransaction(params: MPCSendTransactionParams): Promise<MpcApiResponse<MPCSendTransactionResult>> {
    return this.http.post<MPCSendTransactionResult>('/api/v2/mpc/send-transaction', params);
  }

  /** 合约只读调用（eth_call，不产生交易） */
  async contractRead(params: MPCContractReadParams): Promise<MpcApiResponse<MPCContractReadResult>> {
    return this.http.post<MPCContractReadResult>('/api/v2/mpc/contract-read', params);
  }

  /** 合约写调用（staticCall 模拟通过后 TSS 签名广播） */
  async contractWrite(params: MPCContractWriteParams): Promise<MpcApiResponse<MPCContractWriteResult>> {
    return this.http.post<MPCContractWriteResult>('/api/v2/mpc/contract-write', params);
  }

  /** 估算交易 gas（gasLimit/gasPrice/estimatedCost） */
  async gasEstimate(params: MPCGasEstimateParams): Promise<MpcApiResponse<MPCGasEstimateResult>> {
    return this.http.post<MPCGasEstimateResult>('/api/v2/mpc/gas-estimate', params);
  }
}
