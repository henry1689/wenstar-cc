
// V4.0 Phase 5: WebSocket 实时事件推送端点
// 客户端: new WebSocket('ws://localhost:3000/api/ws/events')
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
export function setupWebSocket(): void {
  const wss = new WebSocketServer({ noServer: true });
  (globalThis as any).__wss = wss;
  (globalThis as any).broadcastEvent = (event: string, payload: any) => {
    const msg = JSON.stringify({ event, payload, time: new Date().toISOString() });
    wss.clients.forEach((ws: WebSocket) => { if (ws.readyState === ws.OPEN) ws.send(msg); });
  };
  console.log('[WS] WebSocket 服务端点已就绪 (attach to http server)');
}
