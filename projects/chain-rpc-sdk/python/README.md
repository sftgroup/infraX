# infra-chain-rpc-client

InfraX chain-rpc 网关官方 Python SDK（A-11.5）

## 安装

```bash
pip install infra-chain-rpc-client
```

## 使用

```python
from infra_chain_rpc_client import ChainRpcClient

client = ChainRpcClient(
    base_url="https://rpc-gw.0xainet.top",  # 公网入口（标准 JSON-RPC 兼容；内网可 http://127.0.0.1:9130）
    api_key="rx_...",            # 读 key：/v1/rpc/:chain、dex.quote
    broadcast_key="bx_...",      # 广播 key（订阅签发 bx_ / data 签发 cr_ scope=rpc_broadcast）：/v1/broadcast、dex.approve/dex.swap
)

# DEX 聚合报价（OKX DEX 首选 / 1inch 回退）
quote = client.dex_quote(
    chain="bsc",
    token_in="0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",   # 原生币
    token_out="0x55d398326f99059ff775485246999027b3197955",  # USDT
    amount_in="1000000000000000000",                          # 1 BNB（wei）
)

# 构建 approve 待签名交易（amount 空 → max uint256）
approve = client.dex_approve("bsc", token, spender)

# 构建 swap 待签名交易（不持有私钥，无 sign 端点）
swap = client.dex_swap(
    chain="bsc",
    token_in="0xEeee...",
    token_out="0x55d398...",
    amount_in="1000000000000000000",
    from_addr="0xYourWallet",
)

# 链上只读（读 key）
balance = client.rpc("bsc", "eth_getBalance", ["0x...", "latest"])
```

> rawTransaction 为**待签名**交易：由调用方（如 MPC 钱包）签名后经
> `/v1/broadcast/:chain` 广播。SDK 不提供 sign 端点（安全约束）。
