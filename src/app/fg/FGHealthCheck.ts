/**
 * FGHealthCheck — FG 关系图健康检查（方案C）
 *
 * 监控 FG 健康指标，定期运行清理任务。
 * 通过 FamilyGraph 私有 query/run 访问底层 SQL（sql.js 实例无 query 方法）。
 * 清理后必须显式 markDirty(true) 触发落盘，否则重启后还原。
 */
import type { FamilyGraph } from '../../m4/household/FamilyGraph.js';

export interface FGHealthReport {
  totalNodes: number;
  totalEdges: number;
  garbageNodes: number;
  autoFixEdges: number;
  inferredEdges: number;
  noneEdges: number;
  /** 幽灵边：source/target 指向不存在的节点（清理遗留/半写入残留） */
  ghostEdges: number;
  duplicateEdges: number;
  isHealthy: boolean;
}

export class FGHealthCheck {
  private fg: FamilyGraph;

  constructor(fg: FamilyGraph) {
    this.fg = fg;
  }

  /** 私有 query 透传（FamilyGraph.query 是 private，返回 getAsObject 数组） */
  private q(sql: string, params?: unknown[]): any[] {
    return (this.fg as any).query(sql, params);
  }

  /** 私有 run 透传 */
  private r(sql: string, params?: unknown[]): void {
    (this.fg as any).run(sql, params);
  }

  /** 清理后强制立即落盘（FamilyGraph 私有 run 不经过 markDirty） */
  private flushDirty(): void {
    (this.fg as any).markDirty(true);
  }

  check(): FGHealthReport {
    const totalNodes = this.countNodes();
    const totalEdges = this.countEdges();
    const garbageNodes = this.countGarbageNodes();
    const autoFixEdges = this.countAutoFixEdges();
    const inferredEdges = this.countInferredEdges();
    const noneEdges = this.countNoneEdges();
    const ghostEdges = this.countGhostEdges();
    const duplicateEdges = this.countDuplicateEdges();

    const isHealthy =
      garbageNodes === 0 &&
      autoFixEdges === 0 &&
      inferredEdges === 0 &&
      noneEdges === 0 &&
      ghostEdges === 0 &&
      duplicateEdges === 0;

    return {
      totalNodes,
      totalEdges,
      garbageNodes,
      autoFixEdges,
      inferredEdges,
      noneEdges,
      ghostEdges,
      duplicateEdges,
      isHealthy,
    };
  }

  /** 执行清理并落盘，返回各项清理数 */
  runCleanup(): { cleaned: number; details: Record<string, number> } {
    const details: Record<string, number> = {
      autoFixAcquaintance: this.deleteAutoFixAcquaintanceEdges(),
      inferred: this.deleteInferredEdges(),
      noneEdges: this.deleteNoneEdges(),
      ghost: this.deleteGhostEdges(),
      duplicates: this.cleanupDuplicates(),
    };
    const cleaned = Object.values(details).reduce((a, b) => a + b, 0);
    if (cleaned > 0) this.flushDirty();
    return { cleaned, details };
  }

  private countNodes(): number {
    const result = this.q('SELECT COUNT(*) as cnt FROM nodes');
    return result[0]?.cnt || 0;
  }

  private countEdges(): number {
    const result = this.q('SELECT COUNT(*) as cnt FROM edges');
    return result[0]?.cnt || 0;
  }

  private countGarbageNodes(): number {
    // SQLite GLOB 不支持 Unicode 字符集范围（[一-鿿] 无效会误匹配全部中文名），故用 JS 正则判断
    const nodes = this.q("SELECT name FROM nodes WHERE type = 'person'");
    return nodes.filter((n: any) => {
      const name = String(n.name);
      if (name === '我') return false; // 用户本人节点，合法
      if (name.length < 2 || name.length > 6) return true;
      return !/^[\u4e00-\u9fff]+$/.test(name); // 含非中文字符 = 语音识别乱码/垃圾
    }).length;
  }

  private countAutoFixEdges(): number {
    // 🔴 2026-08-24: 仅统计 acquaintance_of 的 _auto_fix（真垃圾）。
    //    ⑬⑯ 补全的合法反向边（colleague/spouse/boss 等）也带 _auto_fix 标记，属设计内完整性修复，不算垃圾。
    const result = this.q(`
      SELECT COUNT(*) as cnt FROM edges
      WHERE properties LIKE '%_auto_fix%' AND relation = 'acquaintance_of'
    `);
    return result[0]?.cnt || 0;
  }

  private countInferredEdges(): number {
    const result = this.q(`
      SELECT COUNT(*) as cnt FROM edges
      WHERE properties LIKE '%_inferred%'
    `);
    return result[0]?.cnt || 0;
  }

  private countNoneEdges(): number {
    const result = this.q(`
      SELECT COUNT(*) as cnt FROM edges
      WHERE source_id LIKE 'None%' OR target_id LIKE 'None%'
    `);
    return result[0]?.cnt || 0;
  }

  private countDuplicateEdges(): number {
    const result = this.q(`
      SELECT COUNT(*) as cnt FROM (
        SELECT source_id, target_id, relation, COUNT(*) as cnt
        FROM edges
        GROUP BY source_id, target_id, relation
        HAVING cnt > 1
      )
    `);
    return result[0]?.cnt || 0;
  }

  private deleteAutoFixAcquaintanceEdges(): number {
    const before = this.countEdges();
    this.r(`DELETE FROM edges WHERE properties LIKE '%_auto_fix%' AND relation = 'acquaintance_of'`);
    return before - this.countEdges();
  }

  private deleteInferredEdges(): number {
    const before = this.countEdges();
    this.r(`DELETE FROM edges WHERE properties LIKE '%_inferred%'`);
    return before - this.countEdges();
  }

  private deleteNoneEdges(): number {
    const before = this.countEdges();
    this.r(`DELETE FROM edges WHERE source_id LIKE 'None%' OR target_id LIKE 'None%'`);
    return before - this.countEdges();
  }

  /** 幽灵边计数：任一端节点不存在（最大垃圾源，2026-08-24 清理实证 922 条） */
  private countGhostEdges(): number {
    const result = this.q(`
      SELECT COUNT(*) as cnt FROM edges
      WHERE source_id NOT IN (SELECT id FROM nodes) OR target_id NOT IN (SELECT id FROM nodes)
    `);
    return result[0]?.cnt || 0;
  }

  private deleteGhostEdges(): number {
    const before = this.countEdges();
    this.r('DELETE FROM edges WHERE source_id NOT IN (SELECT id FROM nodes) OR target_id NOT IN (SELECT id FROM nodes)');
    return before - this.countEdges();
  }

  private cleanupDuplicates(): number {
    // 🔴 2026-08-24 V2修复: 用「有序三元组 (source_id,target_id,relation)」分组——只删完全重复（同方向同关系）。
    //    曾误用「无序对」分组，把有向互反关系（colleague_of/spouse_of 的 A→B 与 B→A 同 relation 同无序对）
    //    当重复删一半，致 78 条 colleague + 3 条 spouse 反向被误删（2026-08-24 review 实证）。
    //    保留 created_at 最早一条（MIN(id) 是随机 UUID 最小，非最早创建）。
    const before = this.countEdges();
    this.r(`
      DELETE FROM edges
      WHERE id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY source_id, target_id, relation
            ORDER BY created_at ASC, id ASC
          ) AS rn
          FROM edges
        ) WHERE rn = 1
      )
    `);
    return before - this.countEdges();
  }

  // 🔴 批4（2026-11-08，ADR-022）：滑窗垃圾自检（detectSlidingWindowJunk + 前缀集辅助）
  //   随滑窗产生端一并删除。其判据前提（无档案 + 非名尾字 + 单句低证 = 滑窗片段）在
  //   当前显式介绍准入下不再成立，反而会误报「刚被介绍、档案未回填」的合法新实体。
}
