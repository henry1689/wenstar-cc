/**
 * 批15 · void 边一致性（A 补漏 + B 自愈）测试
 *
 * 背景（用户追问驱动）：批14 清理了 179 条遗留 void 边，但用户问
 * "系统维护类似问题不会继续产生吗？" —— 穷尽分析发现：
 *   · 3 条自动路径已删边 ✅
 *   · 2 处 setEntityStatus（手动）未删边 ⚠️
 *   · 且无任何"强制新路径删边"的机制 ⚠️
 *
 * 本批把删边收敛为单一咽喉 pruneVoidEdges()，并加每日自愈兜底。
 * 本文件验证：手动路径补漏 + 自愈可用 + 自愈幂等 + 不误伤正常边。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { copyRealDbForTest } from '../../../__tests__/helpers/safe-db-copy.js';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FG_PATH_MOD = '../FamilyGraph.js';
const REPO = join(HERE, '..', '..', '..', '..');
const FG_SRC = join(REPO, 'data', 'webui', 'knowledge', 'family_graph.db');

describe('批15 · void 边一致性（A 补漏 + B 自愈）', () => {
  let tmpDir = '';
  let fg: any = null;

  beforeAll(async () => {
    if (!existsSync(FG_SRC)) {
      throw new Error('[批15测试] 缺少真实 FG 库：' + FG_SRC);
    }
    // 🔴 批15 评审 P2-2: 改用受控复制（校验 SQLite 魔数 + 页对齐 + 重试 + fail-closed）。
    // 服务可能正在对该库做 sql.js 全量导出，裸 copyFileSync 会复制到半写文件（torn read）
    // ⇒ 夹具坏、测试红绿不定（candidate-zone.test.ts 已实证并改用同一 helper）。
    const copied = await copyRealDbForTest(FG_SRC, { prefix: 'v27b15-voidedge-' });
    tmpDir = copied.dir;
    const copy = copied.path;
    const { FamilyGraph } = await import(FG_PATH_MOD);
    fg = new FamilyGraph(copy);
    await fg.initialize();
  }, 90_000);

  afterAll(() => {
    try { fg?.close?.(); } catch { /* ignore */ }
    try { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const idOf = (name: string): string | null => {
    const r = fg.query("SELECT id FROM nodes WHERE type='person' AND name = ?", [name]);
    return r.length ? (r[0] as any).id : null;
  };
  const statusOf = (name: string): string | null => {
    const r = fg.query("SELECT id, status FROM nodes WHERE type='person' AND name = ?", [name]);
    return r.length ? (r[0] as any).status : null;
  };
  const edgeCountOf = (id: string): number =>
    (fg.query('SELECT COUNT(*) as c FROM edges WHERE source_id = ? OR target_id = ?', [id, id])[0] as any).c;
  const voidEdgeCount = (): number =>
    (fg.query(`SELECT COUNT(*) as c FROM edges e
      JOIN nodes s ON e.source_id = s.id JOIN nodes t ON e.target_id = t.id
      WHERE s.status='void' OR t.status='void'`)[0] as any).c as number;

  /** 给某节点造一条真实边（edges.created_at/updated_at 为 NOT NULL，必须走 addEdge） */
  const makeEdge = async (name: string, edgeId: string) => {
    const id = idOf(name)!;
    await fg.addEdge({
      id: edgeId,
      source_id: fg.userNodeId || 'me',
      target_id: id,
      relation: 'acquaintance_of',
    } as any);
    return id;
  };

  // ── A: 手动 setEntityStatus('void') 必须清边 ──
  it('🔴 A: setEntityStatus(name, void) 会同步清理该实体的关联边', async () => {
    if (!fg) return;
    await fg.addNode({ id: 'v27b15-a1', type: 'person', name: '批15甲' });
    const id = await makeEdge('批15甲', 'v27b15-edge-a1');
    expect(edgeCountOf(id), '造边成功').toBeGreaterThan(0);

    const r = fg.setEntityStatus('批15甲', 'void', '批15测试');
    expect(r.success).toBe(true);
    expect(statusOf('批15甲')).toBe('void');
    expect(edgeCountOf(id), '手动 void 后边必须为 0').toBe(0);
  });

  // ── A2: 手动恢复为 active 不应被误清 ──
  it('A: setEntityStatus(name, active) 不触发清边（仅 void 方向）', async () => {
    if (!fg) return;
    await fg.addNode({ id: 'v27b15-a2', type: 'person', name: '批15乙' });
    const id = await makeEdge('批15乙', 'v27b15-edge-a2');
    const before = edgeCountOf(id);
    expect(before).toBeGreaterThan(0);

    fg.setEntityStatus('批15乙', 'active', '批15测试');
    expect(edgeCountOf(id), 'active 方向不得清边').toBe(before);
  });

  // ── B: pruneVoidEdges 自愈 ──
  it('🔴 B: pruneVoidEdges() 清理人为制造的 void 边（模拟遗漏路径）', async () => {
    if (!fg) return;
    await fg.addNode({ id: 'v27b15-b1', type: 'person', name: '批15丙' });
    const id = await makeEdge('批15丙', 'v27b15-edge-b1');
    expect(edgeCountOf(id)).toBeGreaterThan(0);

    // 模拟「绕过删边的 status 变更」（未来新增路径 / 人工 SQL）
    fg.run("UPDATE nodes SET status='void' WHERE id = ?", [id]);
    expect(edgeCountOf(id), '此时存在 void 边（正是批14 的形态）').toBeGreaterThan(0);
    expect(voidEdgeCount()).toBeGreaterThan(0);

    const deleted = fg.pruneVoidEdges();
    expect(deleted).toBeGreaterThan(0);
    expect(edgeCountOf(id), '自愈后该边被清').toBe(0);
    expect(voidEdgeCount(), '库内 void 边归零').toBe(0);
  });

  // ── B2: 幂等 —— 无 void 边时返回 0、不报错 ──
  it('B: 无 void 边时 pruneVoidEdges() 返回 0（幂等、可重复调用）', () => {
    if (!fg) return;
    expect(voidEdgeCount()).toBe(0);
    expect(fg.pruneVoidEdges()).toBe(0);
    expect(fg.pruneVoidEdges()).toBe(0);   // 再调一次仍为 0
  });

  // ── B3: 不误伤正常边 ──
  it('🔴 B: 自愈不误伤 active 实体之间的正常边', async () => {
    if (!fg) return;
    await fg.addNode({ id: 'v27b15-c1', type: 'person', name: '批15丁' });
    const id = await makeEdge('批15丁', 'v27b15-edge-c1');
    const before = edgeCountOf(id);
    expect(before).toBeGreaterThan(0);

    const deleted = fg.pruneVoidEdges();       // 库内无 void 边 → 不应删任何东西
    expect(deleted).toBe(0);
    expect(edgeCountOf(id), 'active 实体的边必须完好').toBe(before);
  });

  // ── 端到端：Set→void→自愈链路 ──
  it('端到端：人为绕过删边 → 任意时机调用自愈即可修复（含未来遗漏路径）', async () => {
    if (!fg) return;
    await fg.addNode({ id: 'v27b15-d1', type: 'person', name: '批15戊' });
    const id = await makeEdge('批15戊', 'v27b15-edge-d1');
    // 直接改 status，模拟"某个未来新增的、忘记删边的路径"
    fg.run("UPDATE nodes SET status='void' WHERE id = ?", [id]);
    expect(voidEdgeCount()).toBeGreaterThan(0);
    // 每日维护会调用它（此处直接验证效果）
    fg.pruneVoidEdges();
    expect(voidEdgeCount()).toBe(0);
  });

  // ── P1-1（评审）：addEdge 源头守卫 ──
  it("🔴 P1-1: 不得为 void 实体建边（源头阻断）", async () => {
    if (!fg) return;
    await fg.addNode({ id: "v27b15-p11", type: "person", name: "批15己" });
    const id = idOf("批15己")!;
    // 置 void（绕过 setEntityStatus，模拟"某裸名字查询命中 void 节点"的场景）
    fg.run("UPDATE nodes SET status='void' WHERE id = ?", [id]);
    expect(statusOf("批15己")).toBe("void");

    // 尝试为该 void 节点建边 —— 应被 addEdge 守卫拒绝
    await fg.addEdge({
      id: "v27b15-edge-p11",
      source_id: fg.userNodeId || "me",
      target_id: id,
      relation: "acquaintance_of",
    } as any);

    expect(edgeCountOf(id), "void 实体不得获得新边").toBe(0);
    expect(voidEdgeCount(), "库内 void 边应始终为 0").toBe(0);
  });

  // ── 接线守卫（评审 P2-5）：确保新增接线不被静默移除 ──
  it("🔴 接线守卫：maintenance/server/CLI 保留了 void 边相关接线", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const repo = join(HERE, "..", "..", "..", "..");
    const mt = readFileSync(join(repo, "src", "webui", "maintenance.ts"), "utf8");
    const srv = readFileSync(join(repo, "src", "webui", "server.ts"), "utf8");
    const fgSrc = readFileSync(join(repo, "src", "m4", "household", "FamilyGraph.ts"), "utf8");

    expect(mt, "每日自愈 + 首轮自愈必须存在").toContain("pruneVoidEdges");
    expect(mt, "首轮自愈（P1-2）必须存在").toContain("void 边自愈首轮");
    expect(srv, "启动对账（P1-3）必须存在").toContain("pruneVoidEdges");
    expect(fgSrc, "addEdge 源头守卫（P1-1）必须存在").toContain("拒绝为 void 实体建边");
  });
});
