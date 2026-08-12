import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadConfig } from '../config.js';

export async function authPlugin(fastify: FastifyInstance) {
  const config = loadConfig();
  const validTokens = new Set(config.apiTokens.filter(Boolean));

  // A-15/A-18: 公开/Bearer 端点隔离——仅 /api/v1/health 与 /api/v1/nonce 公开；
  // /api/v1/sessions（含 POST 创建）、/api/v1/execute* 一律要求 Bearer API_TOKENS（sdk_ 前缀）。
  // 鉴权成功后把调用方 key 的掩码标记到 req.callerToken 供 execute 审计（不落 key 原文）。
  fastify.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url || '';
    if (url.startsWith('/api/v1/nonce')) return;
    if (url.startsWith('/api/v1/health')) return;

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ code: 401, message: 'Missing or invalid Bearer token' });
    }
    const token = authHeader.slice(7);
    if (!validTokens.has(token)) {
      return reply.code(403).send({ code: 403, message: 'Invalid API token' });
    }
    // A-18: 不落 key 原文，仅掩码前缀（如 sdk_ab12cd34…）
    (req as any).callerToken = token.length > 12 ? `${token.slice(0, 12)}…` : 'masked';
  });
}
