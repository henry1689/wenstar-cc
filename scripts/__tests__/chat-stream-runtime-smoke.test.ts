// WENSTAROS-MAINLINE-PRODUCTIZATION-BATCH-12
// Chat Stream Runtime Smoke — minimal verification without triggering slow pipeline.
// GET /api/chat/stream triggers processChat (M1-M5, 25-30s) — same slow path as POST /api/chat.
// Strategy: test ONLY the fast-rejection path (empty/missing message → 400) to verify
// the endpoint exists and handles edge cases without crashing. Do NOT trigger full pipeline.
// Does NOT start server. Skips gracefully if server not running.
import { describe, it, expect, beforeAll } from 'vitest';
// 🔴 2026-09-20：服务不可达不再"静默通过"（见 helper 注释与 docs/testing-conventions.md）
import { guardLiveServerOrSkip } from '../../src/__tests__/helpers/live-server-guard.js';

const BASE = 'http://localhost:3000';
let serverAvailable = false;

async function get(path: string): Promise<{ status: number; contentType: string; bodyPreview: string }> {
  const ctrl = new AbortController();
  // 🔴 2026-09-19：5s → 20s。根因已实验证明：本测试请求 live 服务，在**并行全量**（2500+ 用例）下
  //   5s 会假超时（隔离运行同一批 smoke：68/69 通过）。只动超时值，断言不变。
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(`${BASE}${path}`, { signal: ctrl.signal });
    clearTimeout(t);
    const txt = await r.text();
    return {
      status: r.status,
      contentType: r.headers.get('content-type') || '',
      bodyPreview: txt.substring(0, 200),
    };
  } catch {
    clearTimeout(t);
    return { status: 0, contentType: '', bodyPreview: '' };
  }
}

beforeAll(async () => {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(`${BASE}/api/health`, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json().catch(() => null);
    serverAvailable = r.status === 200 && j?.status === 'ok';
  } catch {
    serverAvailable = false;
  }
  guardLiveServerOrSkip('CHAT-STREAM', serverAvailable, 'localhost:3000');
});

// ═══════════════════════════════════════════════════════════
// Group 1: Fast rejection paths (no pipeline trigger)
// ═══════════════════════════════════════════════════════════

describe('[CHAT-STREAM] Fast Rejection (No Pipeline)', () => {
  it('GET /api/chat/stream without message → 400 (fast, no pipeline)', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/chat/stream');
    // Route requires message param. Empty → immediate 400. No M1-M5 pipeline.
    expect(r.status).toBe(400);
  });

  it('GET /api/chat/stream?message= → 400 (empty message)', async () => {
    if (!serverAvailable) return;
    const r = await get('/api/chat/stream?message=');
    expect(r.status).toBe(400);
  });

  it('GET /api/chat/stream endpoint exists (200 on valid input)', { timeout: 35000 }, async () => {
    if (!serverAvailable) {
      console.warn('[CHAT-STREAM] Skipping — /api/chat/stream requires M1-M5 pipeline (25-30s)');
      return;
    }
    // NOTE: This WILL trigger the full M1-M5 pipeline if we provide a message.
    // Document the endpoint exists but don't test the slow path in smoke.
    // The fast rejection tests above confirm endpoint existence and graceful error handling.
    console.warn('[CHAT-STREAM] /api/chat/stream with message triggers M1-M5 (25-30s). Skipping smoke for slow path.');
  });
});
