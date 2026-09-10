/**
 * 实体名读路径端到端回归（C1 验证，2026-09-11）
 * ===============================================
 * 为什么需要「端到端」而不是只查真实库：
 *   `memories.fg_entity_names` 的**写入侧**刚在 2026-09-11 才修好（D3），
 *   真实库该列仍基本为空 —— 直接查真实库只会得到 0，**无法区分「没数据」与「SQL 仍坏」**。
 *   故本测试在**数据库副本**上用**真实写入路径**造数，再走三个引擎的**真实读路径**：
 *       writeMemory(entityGenes) → fg_entity_names 落库 → 引擎按实体名检索命中
 *   这同时验证了写入侧(D3)与读路径(C1)两侧。
 *
 * 事故背景（若不修会怎样）：
 *   三处 SQL 在 memories 上查 `entity_names`（该表只有 `fg_entity_names`）→ 运行时必抛
 *   `no such column`，均被 try/catch 吞掉 → **静默降级**：
 *     ProspectiveSimulator 前瞻匹配恒 0 / NoveltyDetector 恒走 fallback /
 *     KnowledgeAccessFacade 检索恒空。本测试即是这条修复的永久回归防线。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// 本文件位于 <repo>/src/engine/tianquan/temporal/__tests__/ → 回到仓库根需上溯 5 层
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const SRC_DB = join(REPO, 'data', 'webui', 'fusion_memory.db');

// 唯一化的合成实体名，避免与真实数据撞车
const STAMP = Date.now().toString(36);
const ENTITY_A = `ZZ联调甲_${STAMP}`;
const ENTITY_B = `ZZ联调乙_${STAMP}`;

describe('[C1] 实体名读路径端到端：写侧落库 → 三引擎可检索', () => {
  let tmpDir = '';
  let copyPath = '';
  let adapter: any = null;

  beforeAll(async () => {
    if (!existsSync(SRC_DB)) return; // 无真实库则整体跳过（下方断言会跳过）
    tmpDir = mkdtempSync(join(tmpdir(), 'entity-read-e2e-'));
    copyPath = join(tmpDir, 'fusion_memory.db');
    copyFileSync(SRC_DB, copyPath);

    const { SQLiteAdapter } = await import('../../../../m2/SQLiteAdapter.js');
    adapter = new SQLiteAdapter(copyPath);
    await adapter.initialize();

    // 用**真实写入路径**造 3 条含实体名的记忆（NoveltyDetector 需 >=3 条才走非 fallback 分支）
    for (let i = 0; i < 3; i++) {
      adapter.writeMemory({
        id: `mem_e2e_${STAMP}_${i}`,
        seqPos: 990000 + i,
        createdAt: new Date(Date.now() - i * 60_000).toISOString(),
        perceptionJson: JSON.stringify({ pleasure: 0.6, arousal: 0.4, intimacy: 0.7 }),
        calciumScore: 0.6,
        calciumLevel: 3,
        locusPath: 'e2e.entity.read',
        leafZone: 'user',
        rawInput: `端到端验证用合成记忆 ${i}，涉及 ${ENTITY_A} 与 ${ENTITY_B}`,
        primaryEmotion: '平静',
        memoryType: 'dialog',
        entityGenes: [
          { name: ENTITY_A, type: 'person', allele: ENTITY_A, phenotype: 'neutral', knowledge_type: 'private' },
          { name: ENTITY_B, type: 'person', allele: ENTITY_B, phenotype: 'neutral', knowledge_type: 'private' },
          { name: '我', type: 'self', allele: '我', phenotype: 'neutral', knowledge_type: 'private' },
        ],
        dnaRootId: `E2E_DNA_${STAMP}`,
        globalUid: `MME2E${STAMP.toUpperCase()}00000000`.slice(0, 23),
        belongEntityUuid: 'TXS-000000011',
      });
    }
    adapter.flushNow?.();
    await new Promise((r) => setTimeout(r, 200));
  }, 60_000);

  afterAll(() => {
    try { adapter?.close?.(); } catch { /* ignore */ }
    try { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('前置：真实库存在（否则本测试无意义）', () => {
    expect(existsSync(SRC_DB), `未找到 ${SRC_DB}`).toBe(true);
  });

  it('写入侧(D3)：writeMemory 把 fg_entity_names 落库（且过滤 self）', () => {
    const rows = adapter.queryAll(
      "SELECT fg_entity_names FROM memories WHERE id LIKE ? ORDER BY id",
      [`mem_e2e_${STAMP}_%`],
    );
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(String(r.fg_entity_names || '')).toContain(ENTITY_A);
      expect(String(r.fg_entity_names || '')).toContain(ENTITY_B);
      // '我' 属 self，按派生规则应被过滤
      expect(String(r.fg_entity_names || '').split(',')).not.toContain('我');
    }
  });

  it('ProspectiveSimulator：按实体名匹配不再恒 0（原 entity_names 列漂移）', async () => {
    const { ProspectiveSimulator } = await import('../ProspectiveSimulator.js');
    const sim = new ProspectiveSimulator(adapter);
    const result = sim.simulate(
      { topic: '', entities: [ENTITY_A], emotion: '平静' },
      '继续聊',
    );
    expect(
      result.matchedScenes,
      'matchedScenes 为 0 —— 说明 SQL 又查了不存在的列（memories 只有 fg_entity_names）',
    ).toBeGreaterThan(0);
  });

  it('NoveltyDetector：命中同名实体走非 fallback 分支（原 entity_names 列漂移）', async () => {
    const { NoveltyDetector } = await import('../NoveltyDetector.js');
    const det = new NoveltyDetector(adapter);
    const dna: any = { entity_genes: [{ name: ENTITY_A, type: 'person' }] };
    const res = det.assess(dna);
    expect(
      res.method,
      'method=fallback 说明短查/长查 SQL 抛错被吞（memories 无 entity_names 列）',
    ).not.toBe('fallback');
  });

  it('KnowledgeAccessFacade：按实体名召回不再恒空（原 entity_names 列漂移）', async () => {
    const { KnowledgeAccessFacade } = await import('../KnowledgeAccessFacade.js');
    // 知识库侧路径与本用例无关（其失败会被内部 try/catch 隔离），传最小桩即可
    const facade: any = new KnowledgeAccessFacade({} as any, adapter);
    const res = await facade.queryByContext({
      message: `聊聊 ${ENTITY_A}`,
      entities: [ENTITY_A],
      topK: 5,
    });
    expect(
      Array.isArray(res.memoryItems) && res.memoryItems.length,
      'memoryItems 为空 —— 说明按实体名检索的 SQL 抛错被吞（memories 无 entity_names 列）',
    ).toBeGreaterThan(0);
  });
});
