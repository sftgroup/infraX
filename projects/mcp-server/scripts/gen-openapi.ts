// ============================================================================
// Phase 3.2 — 从 hub-index.ts 自动生成 OpenAPI 3.1 spec（发布物）
// 用法：cd projects/mcp-server && npm run gen:openapi
// 产物：ai-skills/openapi.json（与 GET /openapi.json 同源）
// ============================================================================
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseToolsFromSource, buildOpenApiSpec } from "../src/openapi-spec.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const hubSrc = readFileSync(resolve(__dirname, "../src/hub-index.ts"), "utf8");
const tools = parseToolsFromSource(hubSrc);
const spec = buildOpenApiSpec(tools, process.env.HUB_BASE_URL || "https://mcp.0xainet.top");
const out = resolve(__dirname, "../../../ai-skills/openapi.json");
writeFileSync(out, JSON.stringify(spec, null, 2) + "\n");
console.log(`OpenAPI 3.1 spec written to ${out}`);
console.log(`tools: ${tools.length}`);
for (const t of tools) {
  const req = t.params.filter((p) => !p.optional).map((p) => p.key).join(",");
  console.log(`  - ${t.name}${req ? ` (required: ${req})` : ""}`);
}
