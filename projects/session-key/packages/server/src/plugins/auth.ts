import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadConfig } from '../config.js';

export async function authPlugin(fastify: FastifyInstance) {
  const config = loadConfig();
  const validTokens = new Set(config.apiTokens.filter(Boolean));

  // 统一鉴权：/api/v1/health、/api/v1/nonce、POST /api/v1/sessions（创建）公开，
  // 其余端点需 Bearer API_TOKENS。使用 addHook 全局拦截（decorateRequest 在
  // Fastify 5 中传函数的赋值/getter 语义有歧义，改为 hook 更可靠；
  // routes 不再调用 req.authenticate，鉴权完全由本 hook 负责）。
  fastify.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url || '';
    if (url.startsWith('/api/v1/nonce')) return;
    if (url === '/api/v1/sessions' && req.method === 'POST') return;
    if (url === '/api/v1/health') return;

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ code: 401, message: 'Missing or invalid Bearer token' });
    }
    const token = authHeader.slice(7);
    if (!validTokens.has(token)) {
      return reply.code(403).send({ code: 403, message: 'Invalid API token' });
    }
  });
}
