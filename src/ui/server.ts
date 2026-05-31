import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { eventBus, UIEvent } from './event-bus.js';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function startUIServer(port: number): void {
  const app = express();
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });

  app.use(express.static(join(__dirname, 'public')));

  // Ring buffer: last 500 events for replay on new connections
  const history: UIEvent[] = [];
  const MAX_HISTORY = 500;

  const clients = new Set<WebSocket>();

  eventBus.on('ui_event', (event: UIEvent) => {
    history.push(event);
    if (history.length > MAX_HISTORY) history.shift();

    const payload = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    for (const event of history) {
      ws.send(JSON.stringify(event));
    }
    ws.on('close', () => clients.delete(ws));
  });

  httpServer.listen(port, '0.0.0.0', () => {
    logger.info(`UI Dashboard: http://0.0.0.0:${port}`);
  });
}
