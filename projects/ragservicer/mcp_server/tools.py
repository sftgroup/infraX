"""
MCP tool definitions and handlers for InfraX RAGservicer.
Separated from the STDIO transport loop for testability.
"""
import json
import logging

logger = logging.getLogger("ragservicer.mcp")

# ── Tool Definitions ──────────────────────────────────────

TOOLS = [
    {
        "name": "ragservicer_insert_document",
        "description": "Insert a document into the RAGservicer knowledge base for a given namespace. Text will be chunked, embedded, and indexed for later retrieval.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "namespace": {"type": "string", "description": "Namespace/collection identifier (e.g., project name)"},
                "text": {"type": "string", "description": "Document text content to index"},
                "ragservicer_id": {"type": "string", "description": "Unique document identifier (e.g., filename)"},
            },
            "required": ["namespace", "text", "ragservicer_id"]
        }
    },
    {
        "name": "ragservicer_query",
        "description": "Query the RAGservicer knowledge base using hybrid search (vector + graph + keyword). Returns relevant context from indexed documents.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "namespace": {"type": "string", "description": "Namespace/collection to query"},
                "query": {"type": "string", "description": "Natural language query"},
                "mode": {"type": "string", "enum": ["mix", "local", "global", "hybrid", "naive"], "description": "Search mode (default: mix)"},
            },
            "required": ["namespace", "query"]
        }
    },
    {
        "name": "ragservicer_delete_document",
        "description": "Delete a document from the RAGservicer knowledge base by its doc_id.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "namespace": {"type": "string", "description": "Namespace/collection"},
                "ragservicer_id": {"type": "string", "description": "Document ID to delete"},
            },
            "required": ["namespace", "ragservicer_id"]
        }
    },
    {
        "name": "ragservicer_list_instances",
        "description": "List all active Doc instances and their namespaces.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    {
        "name": "ragservicer_retrieve",
        "description": "Retrieve relevant document chunks and knowledge graph context WITHOUT generating an LLM answer. Returns raw context that the caller can use with their own LLM. This does NOT consume the RAGservicer's LLM quota.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "namespace": {"type": "string", "description": "Namespace/collection to query"},
                "query": {"type": "string", "description": "Natural language query"},
                "mode": {"type": "string", "enum": ["mix", "local", "global", "hybrid", "naive"], "description": "Search mode (default: mix)"},
                "top_k": {"type": "integer", "description": "Number of chunks to return"},
            },
            "required": ["namespace", "query"]
        }
    },
]

# ── Tool Handlers ─────────────────────────────────────────

async def handle_insert(args: dict, tenant_id: str) -> dict:
    from api.engine import insert_document
    ns = args.get("namespace", "default")
    text = args.get("text", "")
    doc_id = args.get("ragservicer_id", "document.txt")
    result = insert_document(tenant_id, ns, text, doc_id)
    return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}]}


async def handle_query(args: dict, tenant_id: str) -> dict:
    from api.engine import query as rag_query
    ns = args.get("namespace", "default")
    q = args.get("query", "")
    mode = args.get("mode", "mix")
    result = rag_query(tenant_id, ns, q, mode)
    return {"content": [{"type": "text", "text": result["context"]}]}


async def handle_delete(args: dict, tenant_id: str) -> dict:
    from api.engine import delete_document
    ns = args.get("namespace", "default")
    doc_id = args.get("ragservicer_id", "")
    result = delete_document(tenant_id, ns, doc_id)
    return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}]}


async def handle_list(args: dict, tenant_id: str) -> dict:
    from api.engine import list_instances
    instances = list_instances()
    return {"content": [{"type": "text", "text": json.dumps(instances, ensure_ascii=False, indent=2)}]}


async def handle_retrieve(args: dict, tenant_id: str) -> dict:
    from api.engine import retrieve
    ns = args.get("namespace", "default")
    q = args.get("query", "")
    mode = args.get("mode", "mix")
    top_k = args.get("top_k")
    result = retrieve(tenant_id, ns, q, mode, top_k)
    return {"content": [{"type": "text", "text": result["context"]}]}


TOOL_HANDLERS = {
    "ragservicer_insert_document": handle_insert,
    "ragservicer_query": handle_query,
    "ragservicer_delete_document": handle_delete,
    "ragservicer_list_instances": handle_list,
    "ragservicer_retrieve": handle_retrieve,
}
