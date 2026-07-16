import WebSocket from 'ws';
import { Request } from 'express';

/**
 * EventBus — WebSocket connection management + broadcast.
 *
 * Extracted from dataRoutes.ts so services can import it
 * without depending on the routes layer.
 */

const wsClients = new Set<WebSocket>();

/**
 * Broadcast a new event to all connected WebSocket clients
 * that match the event's chain filter.
 */
export function broadcastEvent(event: any): void {
  const msg = JSON.stringify({ type: 'event', data: event });
  for (const client of wsClients) {
    try {
      if (client.readyState === WebSocket.OPEN) {
        const filter = (client as any)._eventFilter;
        if (!filter || filter.chains?.includes(event.chain)) {
          client.send(msg);
        }
      }
    } catch {}
  }
}

/**
 * Upgrade HTTP connection to WebSocket on /api/v2/data/ws.
 * Called from http.createServer on 'upgrade' event.
 */
export function handleWsUpgrade(req: Request, socket: any, head: any): void {
  if (!req.url?.startsWith('/api/v2/data/ws')) return;

  const url = new URL(req.url, 'http://localhost');
  const chains = url.searchParams.get('chains')?.split(',').filter(Boolean) || [];

  const wss = new WebSocket.Server({ noServer: true });
  wss.handleUpgrade(req, socket, head, (ws: any) => {
    (ws as any)._eventFilter = { chains };
    wsClients.add(ws);
    ws.send(JSON.stringify({ type: 'connected', message: 'Subscribed to event stream', chains }));

    ws.on('close', () => { wsClients.delete(ws); });
    ws.on('error', () => { wsClients.delete(ws); });
  });
}
