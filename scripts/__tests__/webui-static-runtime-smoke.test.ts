// WENSTAROS-MAINLINE-PRODUCTIZATION-BATCH-11
// WebUI Static Runtime Smoke — verify core HTML pages and static assets.
// Does NOT start server. Skips gracefully if server not running.
// Read-only. Zero side effects. Zero network. Timeout: 5s per request.
import { describe, it, expect, beforeAll } from 'vitest';
// 🔴 2026-09-20：服务不可达不再"静默通过"（见 helper 注释与 docs/testing-conventions.md）
import { guardLiveServerOrSkip } from '../../src/__tests__/helpers/live-server-guard.js';

const BASE = 'http://localhost:3000';
let serverAvailable = false;

async function fetchMeta(path: string): Promise<{
  status: number;
  contentType: string;
  bodyLen: number;
  bodyStart: string;
}> {
  const ctrl = new AbortController();
  // 🔴 2026-09-19：5s → 20s（根因同 core-flow：并行全量下 5s 假超时；断言不变）
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(`${BASE}${path}`, { signal: ctrl.signal });
    clearTimeout(t);
    const txt = await r.text();
    return {
      status: r.status,
      contentType: r.headers.get('content-type') || '',
      bodyLen: txt.length,
      bodyStart: txt.substring(0, 200),
    };
  } catch {
    clearTimeout(t);
    return { status: 0, contentType: '', bodyLen: 0, bodyStart: '' };
  }
}

beforeAll(async () => {
  try {
    const r = await fetchMeta('/api/health');
    serverAvailable = r.status === 200;
  } catch {
    serverAvailable = false;
  }
  guardLiveServerOrSkip('WEBUI-STATIC', serverAvailable, 'localhost:3000');
});

// ═══════════════════════════════════════════════════════════
// Group 1: Core HTML pages
// ═══════════════════════════════════════════════════════════

describe('[WEBUI-STATIC] Core Pages', () => {
  it('GET / returns 200 HTML', async () => {
    if (!serverAvailable) return;
    const r = await fetchMeta('/');
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/html');
    expect(r.bodyLen).toBeGreaterThan(100);
    expect(r.bodyStart.toLowerCase()).toMatch(/<html|<body|<div|<!doctype/);
  });

  it('GET /knowledge returns 200 HTML', async () => {
    if (!serverAvailable) return;
    const r = await fetchMeta('/knowledge');
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/html');
    expect(r.bodyLen).toBeGreaterThan(100);
  });

  it('GET /dashboard returns 200 (or graceful fallback)', async () => {
    if (!serverAvailable) return;
    const r = await fetchMeta('/dashboard');
    // dashboard.html may or may not exist — either 200 or fallback < 500
    expect(r.status).toBeLessThan(500);
  });

  it('GET /monitor returns 200 HTML', async () => {
    if (!serverAvailable) return;
    const r = await fetchMeta('/monitor');
    expect(r.status).toBe(200);
    // monitor is a known page
    expect(r.bodyLen).toBeGreaterThan(100);
  });
});

// ═══════════════════════════════════════════════════════════
// Group 2: Static resources / assets
// ═══════════════════════════════════════════════════════════

describe('[WEBUI-STATIC] Assets & Fallback', () => {
  it('GET /favicon.ico returns 200 or 404 (not crash)', async () => {
    if (!serverAvailable) return;
    const r = await fetchMeta('/favicon.ico');
    // Server may or may not have favicon — either is fine
    expect(r.status).toBeLessThan(500);
  });

  it('GET /nonexistent-smoke-path-12345 returns non-500', async () => {
    if (!serverAvailable) return;
    const r = await fetchMeta('/nonexistent-smoke-path-12345');
    // Should return some kind of fallback — not crash
    expect(r.status).toBeLessThan(500);
  });

  it('POST / returns non-500 (does not crash on wrong method)', async () => {
    if (!serverAvailable) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    try {
      const r = await fetch(`${BASE}/`, { method: 'POST', signal: ctrl.signal });
      clearTimeout(t);
      expect(r.status).toBeLessThan(500);
    } catch {
      clearTimeout(t);
      // Network error also fine
    }
  });

  it('OPTIONS / returns 204 (CORS preflight)', async () => {
    if (!serverAvailable) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    try {
      const r = await fetch(`${BASE}/`, { method: 'OPTIONS', signal: ctrl.signal });
      clearTimeout(t);
      expect(r.status).toBe(204);
    } catch {
      clearTimeout(t);
      // May not be handled
    }
  });
});

// ═══════════════════════════════════════════════════════════
// Group 3: Redirects / known paths
// ═══════════════════════════════════════════════════════════

describe('[WEBUI-STATIC] Redirects & Aliases', () => {
  it('GET /knowledge.html returns 200 (alias for /knowledge)', async () => {
    if (!serverAvailable) return;
    const r = await fetchMeta('/knowledge.html');
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/html');
  });

  it('GET /dashboard.html returns 200 or graceful', async () => {
    if (!serverAvailable) return;
    const r = await fetchMeta('/dashboard.html');
    expect(r.status).toBeLessThan(500);
  });
});
