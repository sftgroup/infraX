# lightrag-client

Python SDK for the **InfraX RAGservicer** — hybrid knowledge-base (vector + graph + keyword) retrieval over REST.

## Install

```bash
pip install lightrag-client
```

## Quick Start

```python
from lightrag_client import LightRAGClient

rs = LightRAGClient(base_url="http://localhost:9721", api_key="lr_xxx", tenant_id="market")

# Insert documents (async by default → returns {task_id, status, doc_id})
rs.insert("market", "BTC 走势受美联储利率政策影响", "doc-1")
rs.insert_batch("market", [
    {"text": "DeFi TVL 回升", "doc_id": "doc-2"},
    {"text": "链上巨鲸增持", "doc_id": "doc-3"},
])
# ⚠️ 写入为异步：后台完成「抽实体建图 + 向量化」后才可检索到。
# 写入后建议轮询 GET /api/v1/namespaces/<ns>/tasks/<task_id> 至 status=indexed
# （端到端样例见 examples/lightrag_store_and_query.py）

# Query (context retrieval, no LLM answer)
result = rs.query("market", "比特币走势")
print(result)

# Context-only retrieval with top_k
ctx = rs.retrieve("market", "利率", top_k=5)

# Documents
rs.list_documents("market", page=1, limit=20)
rs.delete("market", "doc-1")
```

## Admin

```python
# Tenants & API keys
rs.create_tenant("market", "Market Data", "default tenant")
rs.generate_api_key("market", "prod", expires_days=90)
rs.list_api_keys("market")

# Hot-reload LLM / Embedding config (no restart needed)
rs.update_config(llm={"api_key": "sk-new", "model": "deepseek-chat"})
```

All methods talk the standard InfraX envelope `{code, message, data}` and return the `data` payload on success; API failures raise `LightRAGClientError` with `.status` / `.code` / `.message`.

## Requirements

- Python >= 3.9
- `requests`

## License

MIT
