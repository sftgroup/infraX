// InfraX MCP 入站鉴权 — MQ-6
// 5 个 HTTP MCP（dc/wallet/mpc/sk/hub）统一入站校验：
//   Authorization: Bearer | X-API-Key | X-Service-Key 三选一
//   受信 key：MCP_API_KEY（逗号分隔白名单，回退 DATA_API_KEY bridge key）
//   签发 key：scope=mcp 的 mx_ key → 调 data /api-keys/verify 实时校验
//   /health 与 / 信息页豁免
import type { Request, Response, NextFunction } from 'express';

const MCP_API_KEYS = (process.env.MCP_API_KEY || process.env.DATA_API_KEY || "")
  .split(",")
  .map((s: string) => s.trim())
  .filter(Boolean);

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function extractInboundKey(req: any): string {
  const auth = (req.headers["authorization"] || "").trim();
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return (req.headers["x-api-key"] || req.headers["x-service-key"] || "").trim();
}

async function verifyInboundKey(key: string): Promise<boolean> {
  if (!key) return false;
  // 1) 受信白名单（MCP_API_KEY / bridge key）
  if (MCP_API_KEYS.some(k => k && timingSafeEqualStr(k, key))) return true;
  // 2) 签发的 MCP 专用 key（mx_，scope=mcp）→ data 服务实时校验
  const dataUrl = process.env.DATA_URL || process.env.DATA_API_URL;
  const dataKey = process.env.DATA_API_KEY;
  if (!dataUrl || !dataKey) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(`${dataUrl}/api-keys/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${dataKey}` },
      body: JSON.stringify({ api_key: key }),
      signal: ctrl.signal,
    });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Express 中间件：/mcp/* 入站鉴权，/health 与 / 豁免 */
export async function inboundAuth(req: Request, res: Response, next: NextFunction) {
  const p = req.path || "/";
  if (p === "/health" || p === "/") return next();
  try {
    if (!(await verifyInboundKey(extractInboundKey(req)))) {
      return res.status(401).json({ error: "unauthorized" });
    }
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}
