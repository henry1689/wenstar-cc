// WENSTAROS-MAINLINE-PRODUCTIZATION-BATCH-09
// SSE Connectivity Runtime Smoke — verify event stream endpoint can connect and close cleanly.
// Does NOT start server. Skips gracefully if server is not running.
// Does NOT require long-lived connection — reads initial event then disconnects.
// Zero LLM API calls. Zero credential inspection.
import { describe, it, expect, beforeAll } from 'vitest';
// 🔴 2026-09-20：服务不可达不再"静默通过"（见 helper 注释与 docs/testing-conventions.md）
import { guardLiveServerOrSkip } from '../../src/__tests__/helpers/live-server-guard.js';

const BASE = 'http://localhost:3000';
const SSE_PATH = '/events';
let serverAvailable = false;

beforeAll(async () => {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const r = await fetch(`${BASE}/api/health`, { signal: controller.signal });
    clearTimeout(t);
    const j = await r.json().catch(() => null);
    serverAvailable = r.status === 200 && j?.status === 'ok';
  } catch {
    serverAvailable = false;
  }
  guardLiveServerOrSkip('SSE-CONN', serverAvailable, 'localhost:3000');
});

// ═══════════════════════════════════════════════════════════
// Group 1: SSE Connection — Basic connectivity
// ═══════════════════════════════════════════════════════════

describe('[SSE-CONN] Basic Connectivity', () => {
  it('GET /events returns 200 with text/event-stream', async () => {
    if (!serverAvailable) return;

    const controller = new AbortController();
    // 🔴 2026-09-19：5s → 20s（根因同 core-flow：并行全量下 5s 假超时；断言不变）
    const t = setTimeout(() => controller.abort(), 20000);

    let status = 0;
    let contentType = '';
    let bodyChunks: string[] = [];

    try {
      const r = await fetch(`${BASE}${SSE_PATH}`, { signal: controller.signal });
      status = r.status;
      contentType = r.headers.get('content-type') || '';

      // Read a few chunks to verify stream, then abort
      const reader = r.body?.getReader();
      if (reader) {
        let bytesRead = 0;
        const maxBytes = 4096; // Enough for initial connected event
        while (bytesRead < maxBytes) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            bytesRead += value.length;
            bodyChunks.push(new TextDecoder().decode(value));
          }
        }
        reader.releaseLock();
      }

      // Clean abort — must close connection, don't leave dangling
      controller.abort();
    } catch (e: any) {
      // Expected: AbortError after we abort or timeout
      // Only fail if we got a non-abort network error
      if (e.name !== 'AbortError' && !String(e.message).includes('abort')) {
        // Store the error type for diagnosis
        bodyChunks.push(`ERROR:${e.name}:${e.message}`);
      }
      status = status || 0;
    } finally {
      clearTimeout(t);
    }

    expect(status).toBe(200);
    expect(contentType).toContain('text/event-stream');
  });

  it('GET /events initial data includes "connected" event', async () => {
    if (!serverAvailable) return;

    const controller = new AbortController();
    // 🔴 2026-09-19：5s → 20s（根因同 core-flow：并行全量下 5s 假超时；断言不变）
    const t = setTimeout(() => controller.abort(), 20000);

    let fullText = '';

    try {
      const r = await fetch(`${BASE}${SSE_PATH}`, { signal: controller.signal });
      const reader = r.body?.getReader();
      if (reader) {
        let total = 0;
        while (total < 4096) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) { total += value.length; fullText += new TextDecoder().decode(value); }
        }
        reader.releaseLock();
      }
      controller.abort();
    } catch {
      // AbortError is expected — we read what we needed
    } finally {
      clearTimeout(t);
    }

    // The SSE endpoint sends: event: connected\ndata: {"status":"ok"}\n\n
    expect(fullText).toMatch(/connected/);
    expect(fullText).toContain('"status"');
  });
});

// ═══════════════════════════════════════════════════════════
// Group 2: SSE Connection — Client disconnect
// ═══════════════════════════════════════════════════════════

describe('[SSE-CONN] Client Disconnect', () => {
  it('Aborting connection releases client slot', async () => {
    // Indirect test: connect and abort multiple times — second should succeed.
    // If server leaks client slots, second connect would fail (MAX_SSE_CLIENTS=100).
    // We test with 3 rapid connects — should all get 200.
    if (!serverAvailable) return;

    const successes: number[] = [];

    for (let i = 0; i < 3; i++) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 4000);
      try {
        const r = await fetch(`${BASE}${SSE_PATH}`, { signal: controller.signal });
        successes.push(r.status);
        // Read just enough to confirm stream opened
        const reader = r.body?.getReader();
        if (reader) {
          const { value } = await reader.read();
          if (value) { /* consume one chunk */ }
          reader.releaseLock();
        }
      } catch {
        // AbortError ok
      } finally {
        clearTimeout(t);
        controller.abort();
      }
      // Small delay between connects
      await new Promise(r => setTimeout(r, 500));
    }

    // All connects should be 200
    expect(successes.length).toBeGreaterThanOrEqual(2);
    for (const s of successes) {
      expect(s).toBe(200);
    }
  }, { timeout: 20000 });

  it('SSE /events rejects non-GET with safe response', async () => {
    if (!serverAvailable) return;

    // POST to SSE endpoint should not crash server
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    let status = 0;
    try {
      const r = await fetch(`${BASE}${SSE_PATH}`, {
        method: 'POST',
        body: 'test',
        signal: controller.signal,
      });
      status = r.status;
    } catch {
      // Network error ok
    } finally {
      clearTimeout(t);
    }
    // Any non-500 is fine (may return 404 or fall through to HTML)
    if (status > 0) expect(status).toBeLessThan(500);
  });
});
