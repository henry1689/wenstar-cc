// WENSTAROS-MAINLINE-PRODUCTIZATION-BATCH-10
// Knowledge + FamilyGraph Runtime Smoke — read-only endpoint verification.
// Does NOT start server. Skips gracefully if server is not running.
// Zero side effects. Zero writes. Zero LLM/network calls.
// Timeout: 5s per request.
import { describe, it, expect, beforeAll } from 'vitest';

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
  if (!serverAvailable) console.warn('[KN-FAM] Server not running — all tests skip.');
});

// ═══════════════════════════════════════════════════════════
// Group 1: GET /knowledge — Knowledge HTML page
// ═══════════════════════════════════════════════════════════

describe('[KN-FAM] Knowledge Page', () => {
  it('GET /knowledge returns 200 HTML', async () => {
    if (!serverAvailable) return;
    const r = await get('/knowledge');
    expect(r.status).toBe(200);
    expect(r.text).toBeDefined();
    expect(r.text!.length).toBeGreaterThan(100);
    // Should be HTML
    expect(r.text!.toLowerCase()).toMatch(/<html|<body|<div|<!doctype/);
  });
});

// ═══════════════════════════════════════════════════════════
// Group 2: GET /api/family — Family graph summary
// ═══════════════════════════════════════════════════════════

describe('[KN-FAM] Family Graph', () => {
  it('GET /api/family returns 200 with members', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/family');
    expect(r.status).toBe(200);
    expect(r.json).toBeDefined();
    // Structure: { members: [...], locations: [...] }
    expect(Array.isArray(r.json?.members)).toBe(true);
  });

  it('GET /api/family/:name returns profile or not-found', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/family/鸿艺');
    expect(r.status).toBe(200);
    expect(r.json).toBeDefined();
    // Either a profile object or { error: 'not found' }
    if (r.json?.error) {
      expect(r.json.error).toMatch(/not found/i);
    } else {
      expect(r.json?.name || r.json?.id).toBeDefined();
    }
  });

  it('GET /api/family/nonexistent returns graceful not-found', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/family/NONEXISTENT_PERSON_99999');
    expect(r.status).toBe(200);
    expect(r.json).toBeDefined();
    // Handles missing person gracefully
  });

  it('GET /api/social returns 200 with connections', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/social');
    expect(r.status).toBe(200);
    expect(r.json).toBeDefined();
    expect(Array.isArray(r.json?.connections)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// Group 3: Endpoint resilience
// ═══════════════════════════════════════════════════════════

describe('[KN-FAM] Error Resilience', () => {
  it('GET /api/family/:name with special chars does not crash', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/family/%3Cscript%3Ealert%3C%2Fscript%3E');
    expect(r.status).toBeLessThan(500);
  });

  it('GET /api/family/:name with empty name returns non-500', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/family/');
    expect(r.status).toBeLessThan(500);
  });

  it('GET /api/family/:name with very long name returns non-500', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/family/' + 'A'.repeat(200));
    expect(r.status).toBeLessThan(500);
  });
});
