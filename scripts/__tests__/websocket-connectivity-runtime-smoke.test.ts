// WENSTAROS-MAINLINE-PRODUCTIZATION-BATCH-11
// WebSocket Connectivity Runtime Smoke — verify WS endpoint can connect and close cleanly.
// Does NOT start server. Skips gracefully if server is not running.
// Uses Node 22 native WebSocket (no `ws` dependency).
// Timeout: 5s for connect. Must close/terminate after test.
import { describe, it, expect, beforeAll } from 'vitest';

const WS_URL = 'ws://localhost:3000/api/ws/events';
let serverAvailable = false;

beforeAll(async () => {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch('http://localhost:3000/api/health', { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json().catch(() => null);
    serverAvailable = r.status === 200 && j?.status === 'ok';
  } catch {
    serverAvailable = false;
  }
  if (!serverAvailable) {
    console.warn('[WS-SMOKE] Server not running on localhost:3000 — all tests skip.');
  }
});

// ── Helper: create WebSocket with timeout ──

// 🔴 2026-09-19：默认连接超时 5s → 20s（根因同 core-flow：并行全量下 5s 假超时）
//   注：调用方显式传入的 5000 与 `elapsed < 5000` 断言本次不动（它们测的是真实耗时）。
function connectWS(url: string, timeoutMs = 20000): Promise<{
  status: 'open' | 'error' | 'timeout' | 'closed';
  messages: string[];
  error?: string;
  closeCode?: number;
}> {
  return new Promise((resolve) => {
    const messages: string[] = [];
    let settled = false;

    const ws = new WebSocket(url);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { ws.close(); } catch {}
        resolve({ status: 'timeout', messages });
      }
    }, timeoutMs);

    ws.onopen = () => {
      // Connected — wait a brief moment for any initial server message
      setTimeout(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try { ws.close(1000, 'test done'); } catch {}
          resolve({ status: 'open', messages });
        }
      }, 500);
    };

    ws.onmessage = (ev) => {
      messages.push(typeof ev.data === 'string' ? ev.data : '(binary)');
    };

    ws.onerror = (ev) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve({ status: 'error', messages, error: 'WebSocket error event' });
      }
    };

    ws.onclose = (ev) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ status: 'closed', messages, closeCode: ev.code });
      }
    };
  });
}

// ═══════════════════════════════════════════════════════════
// Group 1: Basic WebSocket connectivity
// ═══════════════════════════════════════════════════════════

describe('[WS-SMOKE] Basic Connectivity', () => {
  it('WebSocket can connect to /api/ws/events', async () => {
    if (!serverAvailable) return;

    const result = await connectWS(WS_URL, 5000);
    // open or closed (server may close immediately) are both valid
    expect(['open', 'closed']).toContain(result.status);
    if (result.status === 'closed') {
      // Normal closure — server accepted the connection
      expect(result.closeCode).toBeGreaterThanOrEqual(1000);
    }
  });

  it('WebSocket connection does not hang (completes < 5s)', async () => {
    if (!serverAvailable) return;

    const start = Date.now();
    const result = await connectWS(WS_URL, 5000);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000);
    // Either open or normally closed
    expect(result.status).not.toBe('timeout');
  });

  it('Second WebSocket connect also succeeds (no slot leak)', async () => {
    if (!serverAvailable) return;

    // Connect twice in sequence — both should work
    const r1 = await connectWS(WS_URL, 5000);
    expect(r1.status).not.toBe('timeout');

    const r2 = await connectWS(WS_URL, 5000);
    expect(r2.status).not.toBe('timeout');
  });
});

// ═══════════════════════════════════════════════════════════
// Group 2: Edge cases
// ═══════════════════════════════════════════════════════════

describe('[WS-SMOKE] Edge Cases', () => {
  it('WebSocket to wrong path fails gracefully', async () => {
    if (!serverAvailable) return;

    const result = await connectWS('ws://localhost:3000/api/ws/nonexistent-path', 5000);
    // Should fail (error or closed with error) — but test must complete, not hang
    expect(result.status).not.toBe('timeout');
  });

  it('Client close with code 1000 is clean', async () => {
    if (!serverAvailable) return;

    // Open a connection, explicitly close it, verify it closed
    const result = await connectWS(WS_URL, 5000);
    // Connection completed (either open then closed by us, or server closed normally)
    expect(['open', 'closed']).toContain(result.status);
  });
});
