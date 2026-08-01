"""
InfraX Doc MCP Server — Model Context Protocol STDIO transport.
Exposes Doc knowledge base operations as MCP tools for AI agents.

Uses mcp_server.tools for tool definitions (decoupled from transport).
All settings from config.py (zero os.getenv outside config).
"""
import sys
import json
import asyncio
import logging

from config import get_config
from mcp_server.tools import TOOLS, TOOL_HANDLERS

logger = logging.getLogger("doc.mcp")

# ── JSON-RPC Error codes ────────────────────────────────
ERR_TOOL_EXEC = -32000
ERR_METHOD_NOT_FOUND = -32601

# ── JSON-RPC Helpers ─────────────────────────────────────

def _read_message() -> dict | None:
    try:
        line = sys.stdin.readline()
        if not line:
            return None
        return json.loads(line)
    except json.JSONDecodeError:
        return None


def _write_message(msg: dict):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def _response(req_id, result):
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _error(req_id, code, message):
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


# ── Main Loop ────────────────────────────────────────────

def run_mcp_server():
    """Run the MCP server on STDIO (stdin/stdout)."""
    cfg = get_config().server
    logger.info("InfraX Doc MCP server starting on STDIO...")

    _write_message({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {}
    })

    tenant_id = cfg.mcp_tenant_id

    while True:
        msg = _read_message()
        if msg is None:
            break

        method = msg.get("method", "")
        req_id = msg.get("id")

        if method == "initialize":
            _write_message(_response(req_id, {
                "protocolVersion": cfg.mcp_protocol_version,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": cfg.mcp_server_name, "version": cfg.mcp_server_version}
            }))

        elif method == "tools/list":
            _write_message(_response(req_id, {"tools": TOOLS}))

        elif method == "tools/call":
            tool_name = msg.get("params", {}).get("name", "")
            tool_args = msg.get("params", {}).get("arguments", {})

            handler = TOOL_HANDLERS.get(tool_name)
            if handler:
                try:
                    from api.code_refactor import run_async as _run_async
                    result = _run_async(handler(tool_args, tenant_id))
                    _write_message(_response(req_id, result))
                except Exception as e:
                    logger.error(f"Tool error ({tool_name}): {e}")
                    _write_message(_error(req_id, ERR_TOOL_EXEC, str(e)))
            else:
                _write_message(_error(req_id, ERR_METHOD_NOT_FOUND, f"Unknown tool: {tool_name}"))

        elif method in ("notifications/initialized",):
            pass
        elif method.startswith("notifications/"):
            pass
        else:
            _write_message(_error(req_id, ERR_METHOD_NOT_FOUND, f"Unknown method: {method}"))
