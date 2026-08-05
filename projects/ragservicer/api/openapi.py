"""OpenAPI 3.0 spec for InfraX RAGservicer (G-9).

Served at GET /api/v1/openapi.json (no auth decorator → public).
Hand-written spec covering the public surface: documents, query, retrieve,
tenants / API keys, admin config. Auth model:
- Business endpoints: Bearer / X-API-Key / X-Service-Key（app_auth 统一契约，
  可绑定 tenant 或 bridge key 默认 tenant）
- Admin endpoints: Bearer ADMIN_API_KEY
Responses follow the standard envelope {code, message, data}.
"""
from __future__ import annotations


def build_openapi() -> dict:
    return {
        "openapi": "3.0.3",
        "info": {
            "title": "InfraX RAGservicer API",
            "version": "2.0.0",
            "description": "知识库（RAG）服务：文档写入/查询/检索、租户与 API key 管理、"
            "LLM/Embedding 运行时可配。统一响应信封 `{code, message, data}`；"
            "业务端点鉴权 Bearer / X-API-Key / X-Service-Key 任一，admin 端点仅 Bearer ADMIN_API_KEY。",
        },
        "servers": [{"url": "http://localhost:9721"}],
        "security": [{"APIKey": []}],
        "tags": [
            {"name": "documents", "description": "文档写入与管理"},
            {"name": "query", "description": "查询与检索"},
            {"name": "tenants", "description": "租户管理（admin）"},
            {"name": "admin", "description": "运行时配置（admin）"},
        ],
        "paths": {
            "/api/v1/health": {
                "get": {
                    "tags": ["query"],
                    "summary": "健康检查（鉴权豁免）",
                    "security": [],
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                }
            },
            "/api/v1/openapi.json": {
                "get": {
                    "tags": ["query"],
                    "summary": "OpenAPI 文档（鉴权豁免）",
                    "security": [],
                    "responses": {"200": {"description": "ok"}},
                }
            },
            "/api/v1/namespaces/{namespace}/documents": {
                "post": {
                    "tags": ["documents"],
                    "summary": "写入单篇文档（幂等 upsert）",
                    "parameters": [{"name": "namespace", "in": "path", "required": True, "schema": {"type": "string"}}],
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "required": ["text", "doc_id"],
                                    "properties": {
                                        "text": {"type": "string"},
                                        "doc_id": {"type": "string"},
                                        "metadata": {"type": "object", "additionalProperties": True},
                                    },
                                }
                            }
                        }
                    },
                    "responses": {"202": {"description": "accepted (异步写入)", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                },
                "get": {
                    "tags": ["documents"],
                    "summary": "列出命名空间文档（分页）",
                    "parameters": [
                        {"name": "namespace", "in": "path", "required": True, "schema": {"type": "string"}},
                        {"name": "page", "in": "query", "schema": {"type": "integer", "default": 1}},
                        {"name": "limit", "in": "query", "schema": {"type": "integer", "default": 20, "maximum": 100}},
                    ],
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                },
            },
            "/api/v1/namespaces/{namespace}/documents/batch": {
                "post": {
                    "tags": ["documents"],
                    "summary": "批量写入文档（每项 {text, doc_id}）",
                    "parameters": [{"name": "namespace", "in": "path", "required": True, "schema": {"type": "string"}}],
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "required": ["documents"],
                                    "properties": {
                                        "documents": {
                                            "type": "array",
                                            "items": {"type": "object", "required": ["text", "doc_id"]},
                                        }
                                    },
                                }
                            }
                        }
                    },
                    "responses": {"202": {"description": "accepted", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                }
            },
            "/api/v1/namespaces/{namespace}/documents/{doc_id}": {
                "delete": {
                    "tags": ["documents"],
                    "summary": "删除文档",
                    "parameters": [
                        {"name": "namespace", "in": "path", "required": True, "schema": {"type": "string"}},
                        {"name": "doc_id", "in": "path", "required": True, "schema": {"type": "string"}},
                    ],
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                }
            },
            "/api/v1/namespaces/{namespace}/query": {
                "post": {
                    "tags": ["query"],
                    "summary": "知识库查询（vector + graph + keyword 混合检索）",
                    "parameters": [{"name": "namespace", "in": "path", "required": True, "schema": {"type": "string"}}],
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "required": ["query"],
                                    "properties": {
                                        "query": {"type": "string"},
                                        "mode": {"type": "string", "enum": ["mix", "local", "global", "hybrid", "naive"], "default": "mix"},
                                    },
                                }
                            }
                        }
                    },
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                }
            },
            "/api/v1/namespaces/{namespace}/retrieve": {
                "post": {
                    "tags": ["query"],
                    "summary": "纯检索（不生成 LLM 答案），可配 top_k",
                    "parameters": [{"name": "namespace", "in": "path", "required": True, "schema": {"type": "string"}}],
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "required": ["query"],
                                    "properties": {
                                        "query": {"type": "string"},
                                        "mode": {"type": "string", "default": "mix"},
                                        "top_k": {"type": "integer", "default": 5},
                                    },
                                }
                            }
                        }
                    },
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                }
            },
            "/api/v1/namespaces/{namespace}/tasks/{task_id}": {
                "get": {
                    "tags": ["documents"],
                    "summary": "查询异步写任务状态",
                    "parameters": [
                        {"name": "namespace", "in": "path", "required": True, "schema": {"type": "string"}},
                        {"name": "task_id", "in": "path", "required": True, "schema": {"type": "string"}},
                    ],
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                }
            },
            "/api/v1/tenants": {
                "post": {
                    "tags": ["tenants"],
                    "summary": "创建租户",
                    "security": [{"AdminKey": []}],
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "required": ["tenant_id"],
                                    "properties": {
                                        "tenant_id": {"type": "string"},
                                        "name": {"type": "string"},
                                        "description": {"type": "string"},
                                    },
                                }
                            }
                        }
                    },
                    "responses": {"201": {"description": "created", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                },
                "get": {
                    "tags": ["tenants"],
                    "summary": "租户列表",
                    "security": [{"AdminKey": []}],
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                },
            },
            "/api/v1/tenants/{tenant_id}": {
                "delete": {
                    "tags": ["tenants"],
                    "summary": "删除租户",
                    "security": [{"AdminKey": []}],
                    "parameters": [{"name": "tenant_id", "in": "path", "required": True, "schema": {"type": "string"}}],
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                }
            },
            "/api/v1/tenants/{tenant_id}/keys": {
                "post": {
                    "tags": ["tenants"],
                    "summary": "生成租户 API key",
                    "security": [{"AdminKey": []}],
                    "parameters": [{"name": "tenant_id", "in": "path", "required": True, "schema": {"type": "string"}}],
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "name": {"type": "string", "default": "default"},
                                        "expires_days": {"type": "integer", "default": 0},
                                    },
                                }
                            }
                        }
                    },
                    "responses": {"201": {"description": "created", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                },
                "get": {
                    "tags": ["tenants"],
                    "summary": "租户 key 列表",
                    "security": [{"AdminKey": []}],
                    "parameters": [{"name": "tenant_id", "in": "path", "required": True, "schema": {"type": "string"}}],
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                },
            },
            "/api/v1/keys/{key_id}/revoke": {
                "post": {
                    "tags": ["tenants"],
                    "summary": "吊销 API key",
                    "security": [{"AdminKey": []}],
                    "parameters": [{"name": "key_id", "in": "path", "required": True, "schema": {"type": "string"}}],
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                }
            },
            "/api/v1/admin/config": {
                "get": {
                    "tags": ["admin"],
                    "summary": "当前 LLM/Embedding 配置（密钥掩码）",
                    "security": [{"AdminKey": []}],
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                },
                "put": {
                    "tags": ["admin"],
                    "summary": "热更新 LLM/Embedding 配置（写 .env + reload，免重启）",
                    "security": [{"AdminKey": []}],
                    "requestBody": {
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "llm": {
                                            "type": "object",
                                            "properties": {
                                                "api_key": {"type": "string"},
                                                "model": {"type": "string"},
                                                "base_url": {"type": "string"},
                                            },
                                        },
                                        "embedding": {
                                            "type": "object",
                                            "properties": {
                                                "api_key": {"type": "string"},
                                                "model_name": {"type": "string"},
                                                "backend": {"type": "string"},
                                                "dims": {"type": "integer"},
                                                "base_url": {"type": "string"},
                                            },
                                        },
                                    },
                                }
                            }
                        }
                    },
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                },
            },
            "/api/v1/instances": {
                "get": {
                    "tags": ["admin"],
                    "summary": "RAG 实例列表",
                    "security": [{"AdminKey": []}],
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                }
            },
            "/api/v1/admin/tasks": {
                "get": {
                    "tags": ["admin"],
                    "summary": "写任务统计与列表",
                    "security": [{"AdminKey": []}],
                    "parameters": [{"name": "limit", "in": "query", "schema": {"type": "integer", "default": 20, "maximum": 200}}],
                    "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Envelope"}}}}},
                }
            },
        },
        "components": {
            "securitySchemes": {
                "APIKey": {"type": "apiKey", "in": "header", "name": "X-API-Key", "description": "也可用 Bearer 或 X-Service-Key（app_auth 统一契约）；tenant key 绑定租户，bridge key 默认 tenant"},
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
            },
        },
    }
