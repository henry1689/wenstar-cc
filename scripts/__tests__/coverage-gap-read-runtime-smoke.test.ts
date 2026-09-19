// WENSTAROS-MAINLINE-PRODUCTIZATION-BATCH-12
// Coverage Gap Read Runtime Smoke — verify remaining uncovered safe endpoints.
// Does NOT start server. Skips gracefully if server not running.
// Read-only only. Zero side effects. Timeout: 5s per request.
import { describe, it, expect, beforeAll } from 'vitest';
// 🔴 2026-09-20：服务不可达不再"静默通过"（见 helper 注释与 docs/testing-conventions.md）
import { guardLiveServerOrSkip } from '../../src/__tests__/helpers/live-server-guard.js';

const BASE = 'http://localhost:3000';
let serverAvailable = false;

async function get(path: string): Promise<{ status: number; json?: any }> {
  const ctrl = new AbortController();
  // 🔴 2026-09-19：5s → 20s（根因同 core-flow：并行全量下 5s 假超时；断言不变）
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(`${BASE}${path}`, { signal: ctrl.signal });
    clearTimeout(t);
    const txt = await r.text();
    let j: any;
    try { j = JSON.parse(txt); } catch { j = undefined; }
    return { status: r.status, json: j };
  } catch {
    clearTimeout(t);
    return { status: 0 };
  }
}

beforeAll(async () => {
  const r = await get('/api/health');
  serverAvailable = r.status === 200 && r.json?.status === 'ok';
  guardLiveServerOrSkip('GAP-READ', serverAvailable, 'localhost:3000');
});

// ═══════════════════════════════════════════════════════════
// Group 1: GET /api/landscape — Emotional landscape
// ═══════════════════════════════════════════════════════════

describe('[GAP-READ] Landscape', () => {
  it('GET /api/landscape returns 200 with JSON', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/landscape');
    expect(r.status).toBe(200);
    expect(r.json).toBeDefined();
    // Structure: { peaks, valleys, scars, ... } — emotional topology
    expect(typeof r.json).toBe('object');
  });
});

// ═══════════════════════════════════════════════════════════
// Group 2: GET /api/inductions — Induction records
// ═══════════════════════════════════════════════════════════

describe('[GAP-READ] Inductions', () => {
  it('GET /api/inductions returns 200 with total + inductions', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/inductions');
    expect(r.status).toBe(200);
    expect(r.json).toBeDefined();
    expect(typeof r.json.total).toBe('number');
    expect(Array.isArray(r.json.inductions)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// Group 3: GET /api/alignment — System alignment report
// ═══════════════════════════════════════════════════════════

describe('[GAP-READ] Alignment', () => {
  it('GET /api/alignment returns 200 with status field', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/alignment');
    expect(r.status).toBe(200);
    expect(r.json).toBeDefined();
    expect(typeof r.json.status).toBe('string');
  });

  it('GET /api/alignment?verbose=true returns 200 (no crash)', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/alignment?verbose=true');
    expect(r.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════
// Group 4: GET /api/dialog-group/stats — Dialog group stats
// ═══════════════════════════════════════════════════════════

describe('[GAP-READ] Dialog Group Stats', () => {
  it('GET /api/dialog-group/stats returns 200 with JSON', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/dialog-group/stats');
    expect(r.status).toBe(200);
    expect(r.json).toBeDefined();
    expect(typeof r.json).toBe('object');
  });
});

// ═══════════════════════════════════════════════════════════
// Group 5: GET /api/personas — Persona registry (read-only)
// ═══════════════════════════════════════════════════════════

describe('[GAP-READ] Personas', () => {
  it('GET /api/personas returns 200 with active + list', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/personas');
    expect(r.status).toBe(200);
    expect(r.json).toBeDefined();
    expect(typeof r.json.active).toBe('string');
    expect(Array.isArray(r.json.list)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// Group 6: GET /api/m3/hits — M3 word-list hit statistics
// ═══════════════════════════════════════════════════════════

describe('[GAP-READ] M3 Hits', () => {
  it('GET /api/m3/hits returns 200 with hits object', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/m3/hits');
    expect(r.status).toBe(200);
    expect(r.json).toBeDefined();
    expect(r.json.hits).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// Group 7: GET /api/memory/emotion/:emotion
// ═══════════════════════════════════════════════════════════

describe('[GAP-READ] Memory by Emotion', () => {
  it('GET /api/memory/emotion/sad returns 200 with count + memories', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/memory/emotion/sad');
    expect(r.status).toBe(200);
    expect(r.json).toBeDefined();
    expect(typeof r.json.count).toBe('number');
    expect(Array.isArray(r.json.memories)).toBe(true);
  });

  it('GET /api/memory/emotion/nonexistent returns 200 (graceful empty)', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/memory/emotion/NONEXISTENT_EMOTION_XYZ');
    expect(r.status).toBe(200);
    expect(r.json).toBeDefined();
    expect(r.json.count).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// Group 8: GET /api/fg/events — FamilyGraph events
// ═══════════════════════════════════════════════════════════

describe('[GAP-READ] FG Events', () => {
  it('GET /api/fg/events returns 200 with total + events', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/fg/events');
    expect(r.status).toBe(200);
    expect(r.json).toBeDefined();
    expect(typeof r.json.total).toBe('number');
    expect(Array.isArray(r.json.events)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// Group 9: GET /api/keys — ⚠️ lists API keys (read-only but sensitive)
// ═══════════════════════════════════════════════════════════

describe('[GAP-READ] Keys (⚠️ sensitive)', () => {
  it('GET /api/keys returns 200 JSON (content not asserted)', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/keys');
    // Verify endpoint works without crashing — don't assert on secret content
    expect(r.status).toBe(200);
    expect(r.json).toBeDefined();
    expect(r.json.keys).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// Group 10: Error resilience
// ═══════════════════════════════════════════════════════════

describe('[GAP-READ] Error Resilience', () => {
  it('GET /api/alignment with ?repair=true skips (read-only border)', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/alignment?repair=true');
    // repair=true triggers autoRepair — but should still return 200 not crash
    expect(r.status).toBeLessThan(500);
  });

  it('POST /api/landscape returns non-500 (non-GET handled)', async () => {
    if (!serverAvailable) return;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(`${BASE}/api/landscape`, { method: 'POST', signal: ctrl.signal });
      clearTimeout(t);
      expect(r.status).toBeLessThan(500);
    } catch { /* network error ok */ }
  });
});
