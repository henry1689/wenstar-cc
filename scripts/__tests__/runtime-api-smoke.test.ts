// WENSTAROS-MAINLINE-PRODUCTIZATION-BATCH-06
// Runtime API Smoke Test — requires WenstarOS server on localhost:3000.
// Does NOT start server. Skips gracefully if server is not running.
// Zero LLM API calls. Zero credential inspection.
import { describe, it, expect, beforeAll } from 'vitest';
// 🔴 2026-09-20：服务不可达不再"静默通过"（见 helper 注释与 docs/testing-conventions.md）
import { guardLiveServerOrSkip } from '../../src/__tests__/helpers/live-server-guard.js';

const BASE = 'http://localhost:3000';
let serverAvailable = false;

async function apiGet(path: string) {
  const url = `${BASE}${path}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 3000);
  try {
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    const text = await r.text();
    return { status: r.status, text };
  } catch (e: any) {
    clearTimeout(t);
    return { status: 0, text: e.message || 'fetch failed' };
  }
}

beforeAll(async () => {
  const r = await apiGet('/api/health');
  serverAvailable = r.status === 200;
  guardLiveServerOrSkip('API-SMOKE', serverAvailable, 'localhost:3000');
});

describe('[API-SMOKE] Core endpoints', () => {
  // Test 1: Health endpoint
  it('GET /api/health returns 200 with status ok', async () => {
    if (!serverAvailable) {
      console.warn('[API-SMOKE] Server not running — skipping health test');
      return;
    }
    const r = await apiGet('/api/health');
    expect(r.status).toBe(200);
    expect(r.text).toContain('"status"');
    expect(r.text).toMatch(/"ok"/);
  });

  // Test 2: Home page
  it('GET / returns HTML (200)', async () => {
    if (!serverAvailable) return;
    const r = await apiGet('/');
    expect(r.status).toBe(200);
    expect(r.text.length).toBeGreaterThan(100);
  });

  // Test 3: Knowledge page
  it('GET /knowledge returns 200', async () => {
    if (!serverAvailable) return;
    const r = await apiGet('/knowledge');
    expect(r.status).toBe(200);
  });

  // Test 4: Memory endpoint (GET)
  it('GET /api/memory returns 200 or 400 (valid query)', async () => {
    if (!serverAvailable) return;
    const r = await apiGet('/api/memory?entity_uuid=TXS-000000001');
    // May be 200 (matches found) or 400 (missing param) — both mean server is alive
    expect([200, 400, 404]).toContain(r.status);
  });

  // Test 5: Mirror endpoint
  it('GET /api/mirror returns 200', async () => {
    if (!serverAvailable) return;
    const r = await apiGet('/api/mirror');
    expect(r.status).toBe(200);
  });

  // Test 6: Relations endpoint
  it('GET /api/relations returns 200', async () => {
    if (!serverAvailable) return;
    const r = await apiGet('/api/relations');
    expect(r.status).toBe(200);
  });

  // Test 7: Memory stats
  it('GET /api/memory/stats returns 200', async () => {
    if (!serverAvailable) return;
    const r = await apiGet('/api/memory/stats');
    expect(r.status).toBe(200);
  });
});
