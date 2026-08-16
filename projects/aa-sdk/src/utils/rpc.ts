// ============================================================================
// 共享 HTTP POST 模板（JSON body；收敛 paymaster.ts / mpc.ts / session-key.ts
// 三份 fetch + 错误处理拷贝）
// 设计取舍：
//   - 不吞业务语义：返回 { status, json }，由调用方按各自响应协议
//     （JSON-RPC result / REST code 字段 / HTTP 状态）解释成功与否。
//   - 超时仅显式传入才启用（MPC TSS 签名可能较慢，默认不设超时）。
// ============================================================================

export interface PostJsonOptions {
  /** 附加请求头（合并到 content-type: application/json 之后） */
  headers?: Record<string, string>;
  /** 超时（ms）；不传则无超时（不挂 AbortController） */
  timeoutMs?: number;
  /** 错误消息前缀（[aa-sdk] <label>: ...） */
  label?: string;
}

export interface PostJsonResult<T> {
  /** HTTP 状态码 */
  status: number;
  /** 响应体（非 JSON 响应时为 null） */
  json: T | null;
}

/** HTTP 2xx 判定（fetch Response.ok 等价） */
export function isHttpOk(status: number): boolean {
  return status >= 200 && status < 300;
}

export async function postJson<T>(
  url: string,
  body: unknown,
  options?: PostJsonOptions,
): Promise<PostJsonResult<T>> {
  const { headers, timeoutMs, label = 'request' } = options ?? {};

  const controller = timeoutMs ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const json = (await res.json().catch(() => null)) as T | null;
    return { status: res.status, json };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`[aa-sdk] ${label}: timeout after ${timeoutMs}ms`);
    }
    throw new Error(
      `[aa-sdk] ${label}: network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
