"""OpenAPI 3.0 spec for InfraX Knowledge Injector (G-9).

Served at GET /openapi.json (auth-exempt, same as /health).
Hand-written spec covering the public surface: inject, query, status, stats,
and admin config. Security mirrors app_auth: business endpoints accept
X-API-Key / Bearer / X-Service-Key (unified contract); /admin/* uses Bearer
ADMIN_API_KEY. Responses follow the standard envelope {code, message, data}.
"""
from __future__ import annotations


def build_openapi() -> dict:
    return {
        "openapi": "3.0.3",
        "info": {
            "title": "InfraX Knowledge Injector API",
            "version": "1.0.0",
            "description": "知识注入器：抓取多源数据（macro/sentiment/crypto/onchain/defi/news...）写入 RAG 知识图谱。"
            "统一鉴权：`X-API-Key` / `Bearer` / `X-Service-Key` 任一（admin 端点仅 `Bearer ADMIN_API_KEY`）；"
            "统一响应信封 `{code, message, data}`。",
        },
        "servers": [{"url": "http://localhost:9113"}],
        "security": [{"APIKey": []}],
        "tags": [
            {"name": "inject", "description": "注入触发"},
            {"name": "query", "description": "知识库查询"},
            {"name": "status", "description": "状态与统计"},
            {"name": "admin", "description": "数据源密钥管理"},
        ],
        "paths": {
            "/health": {
                "get": {
                    "tags": ["status"],
                    "summary": "健康检查（鉴权豁免）",
                    "security": [],
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                }
            },
            "/status": {
                "get": {
                    "tags": ["status"],
                    "summary": "服务状态与可用注入器列表",
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                }
            },
            "/injectors": {
                "get": {
                    "tags": ["status"],
                    "summary": "列出所有注入器",
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                }
            },
            "/stats": {
                "get": {
                    "tags": ["status"],
                    "summary": "注入统计汇总",
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                }
            },
            "/stats/recent": {
                "get": {
                    "tags": ["status"],
                    "summary": "最近注入记录",
                    "parameters": [{"name": "limit", "in": "query", "schema": {"type": "integer", "default": 20, "maximum": 100}}],
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                }
            },
            "/inject/{source}": {
                "post": {
                    "tags": ["inject"],
                    "summary": "手动触发指定类型注入",
                    "parameters": [{"name": "source", "in": "path", "required": True, "schema": {"type": "string"}}],
                    "responses": {
                        "200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}},
                        "400": {"description": "unknown source", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}},
                    },
                }
            },
            "/inject/all": {
                "post": {
                    "tags": ["inject"],
                    "summary": "触发全量注入",
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                }
            },
            "/inject/parsed": {
                "post": {
                    "tags": ["inject"],
                    "summary": "按 YAML 规则拉取并解析注入（infrax_dc / infrax_collector）",
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "source": {"type": "string", "enum": ["infrax_dc", "infrax_collector"]},
                                        "limit": {"type": "integer", "default": 100},
                                        "dry_run": {"type": "boolean", "default": False},
                                    },
                                }
                            }
                        }
                    },
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                }
            },
            "/query": {
                "post": {
                    "tags": ["query"],
                    "summary": "查询知识图谱（namespace 可选，默认 market）",
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "required": ["query"],
                                    "properties": {
                                        "query": {"type": "string"},
                                        "top_k": {"type": "integer", "default": 5},
                                        "namespace": {"type": "string", "description": "可选，默认 SETTINGS.default_namespace（market）"},
                                    },
                                }
                            }
                        }
                    },
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                }
            },
            "/admin/config": {
                "get": {
                    "tags": ["admin"],
                    "summary": "数据源密钥状态（掩码展示）",
                    "security": [{"AdminKey": []}],
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                },
                "put": {
                    "tags": ["admin"],
                    "summary": "热更新数据源密钥（写 .env + 重置 key 池，免重启）",
                    "security": [{"AdminKey": []}],
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "keys": {
                                            "type": "object",
                                            "description": "FRED_API_KEY / ETHERSCAN_API_KEY / FINNHUB_API_KEY / TUSHARE_API_KEY / NEWSAPI_KEY",
                                            "additionalProperties": {"type": ["string", "array", "null"]},
                                        }
                                    },
                                }
                            }
                        }
                    },
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                },
            },
        },
        "components": {
            "securitySchemes": {
                "APIKey": {"type": "apiKey", "in": "header", "name": "X-API-Key", "description": "也可用 Bearer 或 X-Service-Key（app_auth 统一契约）"},
                "AdminKey": {"type": "http", "scheme": "bearer", "description": "ADMIN_API_KEY"},
            },
            "schemas": {
                "Envelope": {
                    "type": "object",
                    "properties": {
                        "code": {"type": "integer", "description": "0 = success，非 0 = error"},
                        "message": {"type": "string"},
                        "data": {"description": "业务数据（类型随端点而异）"},
                    },
                },
                "Error": {
                    "type": "object",
                    "properties": {
                        "code": {"type": "integer"},
                        "message": {"type": "string"},
                        "data": {"nullable": True},
                    },
                },
            },
        },
    }
