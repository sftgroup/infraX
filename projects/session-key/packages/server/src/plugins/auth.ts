import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadConfig } from '../config.js';

export async function authPlugin(fastify: FastifyInstance) {
  const config = loadConfig();
  const validTokens = new Set(config.apiTokens.filter(Boolean));

  fastify.decorateRequest('authenticate', function (this: FastifyRequest) {
    // Health + nonce + session create are public
    const url = this.url || '';
    if (url.startsWith('/api/v1/nonce')) return;
    if (url === '/api/v1/sessions' && this.method === 'POST') return;
    if (url === '/api/v1/health') return;

    const authHeader = this.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw { statusCode: 401, message: 'Missing or invalid Bearer token' };
    }

    const token = authHeader.slice(7);
    if (!validTokens.has(token)) {
      throw { statusCode: 403, message: 'Invalid API token' };
    }
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    authenticate: () => void;
  }
}
