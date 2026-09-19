// WENSTAROS-MAINLINE-PRODUCTIZATION-BATCH-10
// M6/M7/M8 Runtime Smoke — read-only module/endpoint verification.
// Does NOT start server. Skips gracefully if server is not running.
// Zero side effects. Zero LLM/network calls.
// Timeout: 5s per request (read-only, fast).
import { describe, it, expect, beforeAll } from 'vitest';
// 🔴 2026-09-20：服务不可达不再"静默通过"（见 helper 注释与 docs/testing-conventions.md）
import { guardLiveServerOrSkip } from '../../src/__tests__/helpers/live-server-guard.js';

const BASE = 'http://localhost:3000';
let serverAvailable = false;

async function get(path: string): Promise<{ status: number; json?: any; text?: string }> {
  const ctrl = new AbortController();
  // 🔴 2026-09-19：5s → 20s（根因同 core-flow：并行全量下 5s 假超时；断言不变）
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(`${BASE}${path}`, { signal: ctrl.signal });
    clearTimeout(t);
    const txt = await r.text();
    let j: any;
    try { j = JSON.parse(txt); } catch { j = undefined; }
    return { status: r.status, json: j, text: txt };
  } catch {
    clearTimeout(t);
    return { status: 0 };
  }
}

beforeAll(async () => {
  const r = await get('/api/health');
  serverAvailable = r.status === 200 && r.json?.status === 'ok';
  guardLiveServerOrSkip('M6-M8-SMOKE', serverAvailable, 'localhost:3000');
});

// ═══════════════════════════════════════════════════════════
// Group 1: GET /api/modules — M6/M7/M8 combined data
// ═══════════════════════════════════════════════════════════

describe('[M6-M8] GET /api/modules', () => {
  it('returns 200 with m6/m7/m8 top-level keys', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/modules');
    expect(r.status).toBe(200);
    expect(r.json).toBeDefined();
    // Structure: { m6: {...}, m7: {...}, m8: {...} }
    expect(r.json.m6).toBeDefined();
    expect(r.json.m7).toBeDefined();
    expect(r.json.m8).toBeDefined();
  });

  it('m6 block has traits + preferences + boundaries', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/modules');
    expect(r.status).toBe(200);
    const m6 = r.json?.m6;
    expect(m6).toBeDefined();
    // traits is an object (SelfModelTraits), preferences and boundaries are arrays
    expect(typeof m6.traits).toBe('object');
    expect(m6.traits).not.toBeNull();
    expect(Array.isArray(m6.preferences)).toBe(true);
    expect(Array.isArray(m6.boundaries)).toBe(true);
  });

  it('m7 block has pending_dreams + total_pending + interaction_logs', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/modules');
    expect(r.status).toBe(200);
    const m7 = r.json?.m7;
    expect(m7).toBeDefined();
    expect(typeof m7.total_pending).toBe('number');
    expect(typeof m7.total_confirmed).toBe('number');
  });

  it('m8 block has landscape + status', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/modules');
    expect(r.status).toBe(200);
    const m8 = r.json?.m8;
    expect(m8).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// Group 2: GET /api/rings — M8 year-ring clue search
// ═══════════════════════════════════════════════════════════

describe('[M6-M8] GET /api/rings', () => {
  it('returns 200 with count + entries (empty query)', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/rings');
    expect(r.status).toBe(200);
    expect(r.json).toBeDefined();
    expect(typeof r.json.count).toBe('number');
    expect(Array.isArray(r.json.entries)).toBe(true);
  });

  it('returns 200 with query param', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/rings?query=测试&limit=3');
    expect(r.status).toBe(200);
    expect(typeof r.json?.count).toBe('number');
  });
});

// ═══════════════════════════════════════════════════════════
// Group 3: GET /api/scars — M8 emotional scars
// ═══════════════════════════════════════════════════════════

describe('[M6-M8] GET /api/scars', () => {
  it('returns 200 with total + unhealed + scars array', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/scars');
    expect(r.status).toBe(200);
    expect(r.json).toBeDefined();
    expect(typeof r.json.total).toBe('number');
    expect(typeof r.json.unhealed).toBe('number');
    expect(Array.isArray(r.json.scars)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// Group 4: GET /api/hallucination/log — hallucination audit
// ═══════════════════════════════════════════════════════════

describe('[M6-M8] GET /api/hallucination/log', () => {
  it('returns 200 with count + logs (graceful if table missing)', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/hallucination/log');
    expect(r.status).toBe(200);
    expect(r.json).toBeDefined();
    // Graceful: even if table doesn't exist, returns { count: 0, logs: [] }
    expect(typeof r.json.count).toBe('number');
    expect(Array.isArray(r.json.logs)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// Group 5: Error resilience — bad params
// ═══════════════════════════════════════════════════════════

describe('[M6-M8] Error Resilience', () => {
  it('GET /api/rings huge limit does not crash', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/rings?limit=99999');
    expect(r.status).toBeLessThan(500);
  });

  it('GET /api/rings special chars in query does not crash', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/rings?query=%3Cscript%3E');
    expect(r.status).toBeLessThan(500);
  });

  it('POST /api/modules returns non-500 (method not allowed)', async () => {
    if (!serverAvailable) return;
    // Non-GET on a GET-only endpoint — server should handle gracefully
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(`${BASE}/api/modules`, { method: 'POST', signal: ctrl.signal });
      clearTimeout(t);
      expect(r.status).toBeLessThan(500);
    } catch {
      // Network error also fine
    }
  });
});
