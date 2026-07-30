# 模块 3: MPC → TEE 钱包重构

> 关联: PRD §4、架构图 3 `prd/assets/03-tee-wallet-security.png`

---

## 1. 目标

重构 `mpc-index.ts` → `tee-index.ts`，底层签名从 Node.js 服务端内存→ TEE Enclave 硬件安全执行，同时新增 swap/approve 能力。

**接口层面**: 17 个 tool 全部保留功能逻辑，仅前缀 `mpc_` → `tee_`，参数不变。

---

## 2. 文件改动总览

| 改动 | 文件 | 说明 |
|------|------|------|
| 🆕 新建 | `projects/mpc/services/tee.ts` | TEE Enclave 客户端（attestation + 签名） |
| 🔧 修改 | `projects/mpc/server.ts` | 签名逻辑从 Node.js crypto → 转发 TEE |
| 🔧 重命名 | `mcp-server/src/mpc-index.ts` → `tee-index.ts` | tool 前缀改、+2 tools |
| 🆕 新建 | `deploy/systemd/infrax-tee-enclave.service` | TEE Enclave Docker |
| 🆕 新建 | `deploy/docker/tee-enclave/Dockerfile` | SGX/Nitro 容器 |

---

## 3. TEE 客户端设计

### 3.1 `projects/mpc/services/tee.ts` 🆕

**职责**: MPC API 与 TEE Enclave 之间的桥接层。

```typescript
// tee.ts 设计
export interface TEEConfig {
  enclaveUrl: string;      // TEE Enclave HTTP endpoint
  attestationUrl: string;  // Attestation 验证服务
  timeout: number;         // 请求超时 ms
}

export class TEEClient {
  constructor(private config: TEEConfig) {}

  /**
   * 验证 Enclave 完整性（远程证明）
   * 调用 Intel SGX DCAP 或 AWS Nitro Attestation
   */
  async verifyAttestation(): Promise<{ valid: boolean; quote: string }> {
    const resp = await fetch(`${this.config.attestationUrl}/verify`, {
      method: "POST",
      body: JSON.stringify({ quote: await this.getQuote() }),
      timeout: this.config.timeout,
    });
    return resp.json();
  }

  /**
   * 在 Enclave 内签名交易
   * @param tx 未签名的交易对象
   * @param keyId MPC key shard 标识
   * @returns 签名后的交易
   */
  async signTransaction(tx: UnsignedTx, keyId: string): Promise<SignedTx> {
    const resp = await fetch(`${this.config.enclaveUrl}/sign`, {
      method: "POST",
      body: JSON.stringify({ tx, keyId }),
      timeout: this.config.timeout,
    });
    return resp.json();
  }

  /**
   * EIP-191 personal_sign
   */
  async signMessage(message: string, keyId: string): Promise<{ signature: string }> {
    const resp = await fetch(`${this.config.enclaveUrl}/sign-message`, {
      method: "POST",
      body: JSON.stringify({ message, keyId, type: "eip191" }),
      timeout: this.config.timeout,
    });
    return resp.json();
  }

  /**
   * EIP-712 typed data sign
   */
  async signTypedData(domain: object, types: object, value: object, keyId: string): Promise<{ signature: string }> {
    const resp = await fetch(`${this.config.enclaveUrl}/sign-typed-data`, {
      method: "POST",
      body: JSON.stringify({ domain, types, value, keyId, type: "eip712" }),
      timeout: this.config.timeout,
    });
    return resp.json();
  }

  private async getQuote(): Promise<string> {
    const resp = await fetch(`${this.config.enclaveUrl}/attestation/quote`, {
      timeout: this.config.timeout,
    });
    const data = await resp.json();
    return data.quote;
  }
}

// 环境变量驱动（禁止硬编码）
const teeClient = new TEEClient({
  enclaveUrl: getEnv("TEE_ENCLAVE_URL"),
  attestationUrl: getEnv("TEE_ATTESTATION_URL"),
  timeout: parseInt(getEnv("TEE_TIMEOUT", "10000")),
});
```

---

## 4. MPC API 改动

### 4.1 `projects/mpc/server.ts` 修改

**核心改动**: 签名相关的 route handler 从调用原始 Node.js signer → 调用 TEE client。

```diff
- // 旧: Node.js 内存签名
- import { Wallet } from "ethers";
- const wallet = new Wallet(privateKey);
- const signature = await wallet.signTransaction(tx);
+ // 新: TEE Enclave 签名
+ import { teeClient } from "./services/tee";
+ const verified = await teeClient.verifyAttestation();
+ if (!verified.valid) throw new Error("TEE attestation failed");
+ const signedTx = await teeClient.signTransaction(tx, keyId);
```

**不改的部分**:
- Session token 生成/验证逻辑
- 限额检查逻辑（新增可配置化）
- Wallet 创建/注册/恢复（key shard 存储不变）
- API 端点路径（`/api/v2/mpc/*`）

---

## 5. MCP Server 重构

### 5.1 从 `mpc-index.ts` 到 `tee-index.ts`

**改动清单**:

1. **文件名**: `mpc-index.ts` → `tee-index.ts`
2. **tool 前缀**: `mpc_*` → `tee_*`
3. **导出**: 改为 `export const teeTools` 供 hub 消费
4. **新增 2 tools**: `tee_swap`、`tee_approve`

### 5.2 新增 tool: `tee_swap`

```typescript
const teeSwap = {
  name: "tee_swap",
  description: "在 DEX 上执行代币兑换。仅支持白名单路由（Uniswap/PancakeSwap）。需有效的 session token。",
  schema: {
    token: z.string().describe("Session token"),
    tokenIn: z.string().describe("输入代币地址（或 'ETH' 为原生代币）"),
    tokenOut: z.string().describe("输出代币地址"),
    amountIn: z.string().describe("输入金额（代币最小单位）"),
    slippage: z.string().optional().describe("滑点容忍度 %，默认 0.5"),
    chain: z.string().optional().describe("链名称"),
  },
  handler: async (args) => {
    // 1. 验证 session token
    // 2. 检查限额
    // 3. 调用 TEE 签名 swap 交易
    // 4. 广播
    return formatContent(await mpc("/api/v2/mpc/swap", { method: "POST", body: args }));
  },
};
```

### 5.3 新增 tool: `tee_approve`

```typescript
const teeApprove = {
  name: "tee_approve",
  description: "授权 ERC20 代币给指定 spender（通常是 DEX Router）。需有效的 session token。",
  schema: {
    token: z.string().describe("Session token"),
    tokenAddress: z.string().describe("代币合约地址"),
    spender: z.string().describe("授权对象地址"),
    amount: z.string().optional().describe("授权金额（wei），不填则最大授权"),
    chain: z.string().optional().describe("链名称"),
  },
  handler: async (args) => {
    return formatContent(await mpc("/api/v2/mpc/approve", { method: "POST", body: args }));
  },
};
```

### 5.4 完整 17 tools 列表（改名后）

| # | tool 名 | 需要 session | 说明 |
|:---:|------|:---:|------|
| 1 | `tee_send_code` | ❌ | 发验证码 |
| 2 | `tee_register` | ❌ | 注册钱包 |
| 3 | `tee_recover` | ❌ | 恢复钱包 |
| 4 | `tee_status` | ❌ | 查钱包状态 |
| 5 | `tee_create_wallet` | ❌ | 一键创建 |
| 6 | `tee_session_unlock` | ❌ | 解锁会话 |
| 7 | `tee_session_lock` | ✅ | 锁定会话 |
| 8 | `tee_session_status` | ✅ | 查会话状态 |
| 9 | `tee_balance` | ✅ | 查余额 |
| 10 | `tee_sign_message` | ✅ | EIP-191 签名 |
| 11 | `tee_sign_typed_data` | ✅ | EIP-712 签名 |
| 12 | `tee_send_transaction` | ✅ | 转账 |
| 13 | `tee_contract_read` | ❌ | 合约只读 |
| 14 | `tee_contract_write` | ✅ | 合约写 |
| 15 | `tee_gas_estimate` | ❌ | Gas 估算 |
| 16 | `tee_swap` 🆕 | ✅ | DEX 兑换 |
| 17 | `tee_approve` 🆕 | ✅ | ERC20 授权 |

---

## 6. TEE Enclave 部署

### 6.1 Dockerfile

**文件**: `deploy/docker/tee-enclave/Dockerfile`

```dockerfile
FROM gramineproject/gramine:latest

WORKDIR /app
COPY enclave.manifest.template .
COPY signer.py .

RUN gramine-manifest enclave.manifest.template enclave.manifest
RUN gramine-sgx-sign --manifest enclave.manifest --output enclave.sig

EXPOSE 9550
CMD ["gramine-sgx", "./signer.py"]
```

### 6.2 systemd Unit

```ini
[Unit]
Description=InfraX TEE Enclave
After=docker.service

[Service]
Type=simple
ExecStartPre=/usr/bin/docker pull infrax/tee-enclave:latest
ExecStart=/usr/bin/docker run --rm --name infrax-tee \
  --device /dev/sgx_enclave \
  --device /dev/sgx_provision \
  -p 9550:9550 \
  infrax/tee-enclave:latest
ExecStop=/usr/bin/docker stop infrax-tee
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### 6.3 模拟模式（开发环境）

如果当前服务器不支持 SGX/Nitro：

```bash
# 使用软件模拟 TEE
export TEE_MODE=mock
export TEE_ENCLAVE_URL=http://localhost:9550
```

Mock TEE 用 Node.js 实现相同的 HTTP 接口，签名仍用 crypto（但加 mock attestation）。

---

## 7. 向后兼容策略

```
Week 1-2:  tee-index.ts 部署 → 同时保留 mpc-index.ts
Week 3:    文档、Skill 更新为 tee_* tool 名
Week 4:    mpc-index.ts 加 deprecation notice
Week 5:    监控 mpc_* 调用量 → 0 后移除
```

---

## 8. 测试要点

1. TEE attestation 验证通过后才能签名
2. attestation 失败时所有签名操作拒绝
3. session token 过期后签名操作返回 Unauthorized
4. tee_swap 只能调用白名单 DEX 路由
5. 单笔限额生效（默认 0.1 ETH，超出拒绝）
6. Mock 模式下功能与真机一致
