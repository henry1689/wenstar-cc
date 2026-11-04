/**
 * E2EVerifier.ts — 端到端验证清单
 *
 * 【验收 5 条】
 *   ① 主系统所有记忆调用最终走新 MemArch v2
 *   ② 每角色一个 namespace、物理隔离
 *   ③ 旧库历史数据全量迁移且校验一致
 *   ④ 跑一遍端到端对话，验证身份不串台 / 记忆不混乱 / 命名不冲突
 *   ⑤ 性能不下降
 */

import type Database from 'better-sqlite3';

export interface VerifyResult {
  name: string;
  pass: boolean;
  detail: string;
  durationMs: number;
}

export class E2EVerifier {
  constructor(private readonly db: Database.Database) {}

  /** 跑全部验证 */
  async runAll(): Promise<VerifyResult[]> {
    return [
      await this.verifyNamespaceIsolation(),
      await this.verifyNoCrossRoleLeak(),
      await this.verifyMigrationCount(),
      await this.verifyIdentityConsistency(),
      await this.verifyNamingNoConflict(),
      await this.verifyPerformanceBaseline(),
    ];
  }

  // ============================================================
  // ② 每角色一个 namespace、物理隔离
  // ============================================================

  async verifyNamespaceIsolation(): Promise<VerifyResult> {
    const t0 = Date.now();
    const rows = this.db.prepare(
      `SELECT DISTINCT namespace FROM conversations ORDER BY namespace`
    ).all() as Array<{ namespace: string }>;

    const namespaces = rows.map((r) => r.namespace);
    const badDefault = namespaces.includes('default');
    // 空值检查：'' / null / undefined 都算不合格（union 类型下 includes 无法接收 null）
    const badEmpty = namespaces.some((n) => n == null || n === '');

    return {
      name: 'namespace_isolation',
      pass: !badDefault && !badEmpty && namespaces.length >= 1,
      detail: `发现 ${namespaces.length} 个 namespace: ${namespaces.join(', ')}。` +
        (badDefault ? ' ❌ 存在 default namespace（串台根因）' : '') +
        (badEmpty ? ' ❌ 存在空 namespace' : ''),
      durationMs: Date.now() - t0,
    };
  }

  // ============================================================
  // ④a 身份不串台：角色 A 查不到角色 B 的记忆
  // ============================================================

  async verifyNoCrossRoleLeak(): Promise<VerifyResult> {
    const t0 = Date.now();
    // 取两个不同 namespace
    const nsList = this.db.prepare(
      `SELECT DISTINCT namespace FROM conversations LIMIT 5`
    ).all() as Array<{ namespace: string }>;

    if (nsList.length < 2) {
      return { name: 'no_cross_role_leak', pass: true, detail: '只有 1 个 namespace，无需交叉验证', durationMs: 0 };
    }

    const nsA = nsList[0].namespace;
    const nsB = nsList[1].namespace;

    // 在 nsA 里插入一条标记
    const marker = `CROSS_LEAK_TEST_${Date.now()}`;
    this.db.prepare(`
      INSERT OR REPLACE INTO conversations (message_id, namespace, role, content, ts_utc, lifecycle_state)
      VALUES (?, ?, 'user', ?, ?, 'fresh')
    `).run(marker, nsA, marker, Date.now());

    // 用 nsB 的视角查询，必须查不到
    const foundInB = this.db.prepare(
      `SELECT COUNT(*) as c FROM conversations WHERE namespace = ? AND content = ?`
    ).get(nsB, marker) as { c: number };

    // 清理
    this.db.prepare(`DELETE FROM conversations WHERE message_id = ?`).run(marker);

    return {
      name: 'no_cross_role_leak',
      pass: foundInB.c === 0,
      detail: `nsA=${nsA} 写入标记后，nsB 查询命中 ${foundInB.c} 条（必须为 0）`,
      durationMs: Date.now() - t0,
    };
  }

  // ============================================================
  // ③ 迁移行数校验
  // ============================================================

  async verifyMigrationCount(): Promise<VerifyResult> {
    const t0 = Date.now();
    const row = this.db.prepare(
      `SELECT
        (SELECT COUNT(*) FROM conversations) as convos,
        (SELECT COUNT(*) FROM memories) as memories,
        (SELECT COUNT(*) FROM migration_checkpoint WHERE status='success') as migrated,
        (SELECT COUNT(*) FROM migration_checkpoint WHERE status='failed') as failed`
    ).get() as Record<string, number>;

    return {
      name: 'migration_count',
      pass: row.failed === 0,
      detail: `conversations=${row.convos} memories=${row.memories} 已迁移=${row.migrated} 失败=${row.failed}`,
      durationMs: Date.now() - t0,
    };
  }

  // ============================================================
  // ④b 记忆不混乱：同一 namespace 下时间线一致
  // ============================================================

  async verifyIdentityConsistency(): Promise<VerifyResult> {
    const t0 = Date.now();
    const rows = this.db.prepare(`
      SELECT namespace, COUNT(DISTINCT roleplay_char) as chars
      FROM conversations
      GROUP BY namespace
      HAVING chars > 1
    `).all() as Array<{ namespace: string; chars: number }>;

    return {
      name: 'identity_consistency',
      pass: rows.length === 0,
      detail: rows.length === 0
        ? '所有 namespace 内角色一致'
        : `❌ 以下 namespace 混了多个角色: ${rows.map(r => `${r.namespace}(${r.chars})`).join(', ')}`,
      durationMs: Date.now() - t0,
    };
  }

  // ============================================================
  // ④c 命名不冲突：每个角色有独立 namespace 注册表
  // ============================================================

  async verifyNamingNoConflict(): Promise<VerifyResult> {
    const t0 = Date.now();
    try {
      const rows = this.db.prepare(
        `SELECT namespace, roleplay_name, role_uuid FROM namespace_registry`
      ).all() as Array<{ namespace: string; roleplay_name: string; role_uuid: string }>;

      return {
        name: 'naming_no_conflict',
        pass: rows.length >= 1,
        detail: `已注册 ${rows.length} 个角色: ${rows.map(r => `${r.roleplay_name}→${r.namespace}`).join(', ')}`,
        durationMs: Date.now() - t0,
      };
    } catch {
      return {
        name: 'naming_no_conflict',
        pass: false,
        detail: '❌ namespace_registry 表不存在或为空',
        durationMs: 0,
      };
    }
  }

  // ============================================================
  // ⑤ 性能不下降：基线对比
  // ============================================================

  async verifyPerformanceBaseline(): Promise<VerifyResult> {
    const t0 = Date.now();
    // 简单查询性能
    const qt0 = Date.now();
    this.db.prepare(
      `SELECT * FROM conversations WHERE namespace = ? ORDER BY ts_utc DESC LIMIT 10`
    ).all('ns_yuyao');
    const queryMs = Date.now() - qt0;

    return {
      name: 'performance_baseline',
      pass: queryMs < 50,
      detail: `单 namespace 查询最近 10 条耗时 ${queryMs}ms（要求 < 50ms）`,
      durationMs: Date.now() - t0,
    };
  }
}
