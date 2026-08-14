import type { FastifyInstance } from 'fastify';
import { DEFAULTS } from '@0xinfrax/session-key-core';
import type { NonceService } from '../services/nonce-service.js';
import type { SessionService } from '../services/session-service.js';
import type { ExecutionService } from '../services/execution-service.js';

export interface Services {
  nonceService: NonceService;
  sessionService: SessionService;
  executionService: ExecutionService;
}

export function registerRoutes(app: FastifyInstance, svc: Services) {
  // ── Nonce ──────────────────────────────────────────────────────────
  app.get('/api/v1/nonce', async (req, res) => {
    const { user } = req.query as { user?: string };
    if (!user) return res.status(400).send({ code: 400, message: 'user address required' });
    const data = svc.nonceService.get(user);
    return res.send({ code: 200, data, message: 'ok' });
  });

  // ── Health ─────────────────────────────────────────────────────────
  app.get('/api/v1/health', async (_req, res) => {
    return res.send({ status: 'ok', service: 'session-key-engine' });
  });

  // ── Create Session ─────────────────────────────────────────────────
  app.post('/api/v1/sessions', async (req, res) => {
    const { signature, chain, permissions, validDays, maxPerTx, maxTotal, userAddress, nonce, sessionPublicKey, sessionPrivateKey, validUntil } = req.body as any;
    if (!signature || !chain || !permissions?.contracts || !userAddress || !nonce || !sessionPublicKey || !sessionPrivateKey) {
      return res.status(400).send({ code: 400, message: 'Missing required fields' });
    }
    try {
      svc.nonceService.consume(userAddress, nonce);
      const result = await svc.sessionService.create({
        signature, chain, permissions,
        validDays: validDays || DEFAULTS.DEFAULT_VALID_DAYS,
        maxPerTx: maxPerTx || DEFAULTS.MAX_PER_TX_USDC,
        maxTotal: maxTotal || DEFAULTS.MAX_TOTAL_USDC,
        userAddress, nonce,
        sessionPublicKey, sessionPrivateKey,
        validUntil,
      });
      return res.status(201).send({ code: 201, data: result, message: 'Session created' });
    } catch (err: any) {
      const status = err.statusCode || 500;
      return res.status(status).send({ code: status, message: err.message, errorCode: err.errorCode });
    }
  });

  // ── List Sessions ──────────────────────────────────────────────────
  app.get('/api/v1/sessions', async (req, res) => {
    const { user, chain, status } = req.query as any;
    if (!user) return res.status(400).send({ code: 400, message: 'user address required' });
    const sessions = await svc.sessionService.list(user, chain, status);
    return res.send({ code: 200, data: { sessions }, message: 'ok' });
  });

  // ── Get Session ────────────────────────────────────────────────────
  app.get('/api/v1/sessions/:id', async (req, res) => {
    const { id } = req.params as any;
    try {
      const session = await svc.sessionService.get(id);
      return res.send({ code: 200, data: session, message: 'ok' });
    } catch (err: any) {
      return res.status(err.statusCode || 500).send({ code: err.statusCode || 500, message: err.message });
    }
  });

  // ── Revoke Session ─────────────────────────────────────────────────
  app.delete('/api/v1/sessions/:id', async (req, res) => {
    const { id } = req.params as any;
    try {
      const result = await svc.sessionService.revoke(id);
      return res.send({ code: 200, data: result, message: 'ok' });
    } catch (err: any) {
      return res.status(err.statusCode || 500).send({ code: err.statusCode || 500, message: err.message });
    }
  });

  // ── Execute ────────────────────────────────────────────────────────
  app.post('/api/v1/execute', async (req, res) => {
    const { sessionId, chain, to, data, value, gasLimit } = req.body as any;
    if (!sessionId || !chain || !to || !data) {
      return res.status(400).send({ code: 400, message: 'sessionId, chain, to, data required' });
    }
    try {
      const result = await svc.executionService.execute({
        sessionId, chain, to, data, value, gasLimit,
        caller: (req as any).callerToken, // A-18: 审计调用方（auth hook 掩码，不落 key 原文）
      });
      return res.send({ code: 200, data: result, message: result.status === 'success' ? 'Transaction sent' : 'Transaction failed' });
    } catch (err: any) {
      const status = err.statusCode || 500;
      return res.status(status).send({ code: status, message: err.message, errorCode: err.errorCode });
    }
  });

  // ── A-17: Execute 明细 ─────────────────────────────────────────────
  app.get('/api/v1/execute/:id', async (req, res) => {
    const { id } = req.params as any;
    const record = await svc.executionService.findById(id);
    if (!record) return res.status(404).send({ code: 404, message: 'Execution not found' });
    return res.send({ code: 200, data: record, message: 'ok' });
  });
}
