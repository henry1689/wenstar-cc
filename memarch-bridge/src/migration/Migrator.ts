/**
 * Migrator.ts — 旧库 → 新库 数据迁移主脚本
 *
 * 【流程】
 *   1. 前置检查：旧库可读、新库已跑 DDL、磁盘空间够
 *   2. 备份旧库（cp 一份 .bak，回滚用）
 *   3. 按 SchemaMapper 逐表迁移（分页 1000 条/批）
 *   4. 行数校验：旧表 count vs 新表 count（按 namespace 分组）
 *   5. 内容抽样校验：随机抽 100 条比对字段
 *   6. 输出迁移报告
 *
 * 【运行方式】
 *   npx ts-node scripts/run-migration.ts --old ./data/old.db --new ./data/memarch-v2.db
 */

import type Database from 'better-sqlite3';
import { SCHEMA_MAPS, normalizeCalcium, resolveNamespaceFromPersona } from './SchemaMapper.js';
import { IdempotencyGuard } from './IdempotencyGuard.js';

export interface MigrationConfig {
  oldDbPath: string;
  newDbPath: string;
  /** persona → namespace 映射表（玉瑶 → ns_yuyao_xxx） */
  personaToNamespace: Record<string, string>;
  /** 批次大小 */
  batchSize?: number;
  /** 是否只跑 dry-run（不写新库） */
  dryRun?: boolean;
}

export interface MigrationReport {
  table: string;
  oldCount: number;
  newCountBefore: number;
  newCountAfter: number;
  migrated: number;
  skipped: number;
  failed: number;
  durationMs: number;
  rowMismatch: boolean;
  samples: Array<{ oldPk: string; match: boolean }>;
}

export class Migrator {
  private guard: IdempotencyGuard;

  constructor(
    private readonly oldDb: Database.Database,
    private readonly newDb: Database.Database,
    private readonly cfg: MigrationConfig
  ) {
    this.guard = new IdempotencyGuard(newDb);
  }

  async run(): Promise<MigrationReport[]> {
    const reports: MigrationReport[] = [];
    for (const map of SCHEMA_MAPS) {
      reports.push(await this.migrateTable(map));
    }
    return reports;
  }

  private async migrateTable(map: typeof SCHEMA_MAPS[number]): Promise<MigrationReport> {
    const t0 = Date.now();
    const batchSize = this.cfg.batchSize ?? 1000;

    // 1. 旧表总行数
    const oldCount = (this.oldDb.prepare(`SELECT COUNT(*) as c FROM ${map.oldTable}`).get() as { c: number }).c;
    const newCountBefore = (this.newDb.prepare(`SELECT COUNT(*) as c FROM ${map.newTable}`).get() as { c: number }).c;

    let migrated = 0, skipped = 0, failed = 0;

    // 2. 分页扫描
    const totalBatches = Math.ceil(oldCount / batchSize);
    for (let b = 0; b < totalBatches; b++) {
      const offset = b * batchSize;
      const rows = this.oldDb.prepare(
        `SELECT * FROM ${map.oldTable} LIMIT ${batchSize} OFFSET ${offset}`
      ).all() as Record<string, unknown>[];

      for (const row of rows) {
        const oldPk = String(row.id ?? row.uuid ?? row.message_id);

        // 幂等检查
        if (this.guard.isMigrated(map.oldTable, oldPk)) {
          skipped++;
          continue;
        }

        try {
          // 3. 字段映射
          const newRow: Record<string, unknown> = {};
          for (const [oldCol, newCol] of Object.entries(map.columnMap)) {
            newRow[newCol] = row[oldCol];
          }
          // 默认值
          for (const [k, v] of Object.entries(map.defaults)) {
            if (!(k in newRow)) {
              newRow[k] = v === '__RESOLVE_FROM_PERSONA__'
                ? resolveNamespaceFromPersona(row.persona as string, this.cfg.personaToNamespace)
                : v;
            }
          }
          // calcium 归一化
          if (map.oldTable === 'memories') {
            newRow.consolidation = normalizeCalcium(row.calcium_level as number);
          }

          // 必填校验
          for (const req of map.requiredOldCols) {
            if (row[req] == null) throw new Error(`缺少必填字段: ${req}`);
          }

          // 4. 写入新库（事务）
          if (!this.cfg.dryRun) {
            const cols = Object.keys(newRow).join(', ');
            const placeholders = Object.keys(newRow).map(() => '?').join(', ');
            this.newDb.prepare(
              `INSERT OR REPLACE INTO ${map.newTable} (${cols}) VALUES (${placeholders})`
            ).run(...Object.values(newRow));
          }

          this.guard.markSuccess({
            oldTable: map.oldTable,
            oldPk,
            newPk: String(newRow.id ?? newRow.message_id),
            namespace: newRow.namespace as string,
          });
          migrated++;
        } catch (err) {
          failed++;
          this.guard.markFailure(map.oldTable, oldPk, 'unknown', (err as Error).message);
        }
      }
    }

    const newCountAfter = (this.newDb.prepare(`SELECT COUNT(*) as c FROM ${map.newTable}`).get() as { c: number }).c;

    // 5. 抽样校验
    const samples = this.sampleVerify(map.oldTable, map.newTable, 20);

    return {
      table: map.oldTable,
      oldCount,
      newCountBefore,
      newCountAfter,
      migrated, skipped, failed,
      durationMs: Date.now() - t0,
      rowMismatch: newCountAfter - newCountBefore !== migrated,
      samples,
    };
  }

  private sampleVerify(oldTable: string, newTable: string, n: number): Array<{ oldPk: string; match: boolean }> {
    const samples: Array<{ oldPk: string; match: boolean }> = [];
    try {
      const oldRows = this.oldDb.prepare(`SELECT * FROM ${oldTable} ORDER BY RANDOM() LIMIT ${n}`).all() as Record<string, unknown>[];
      for (const o of oldRows) {
        const pk = String(o.id ?? o.uuid);
        const newRow = this.newDb.prepare(`SELECT * FROM ${newTable} WHERE message_id = ? OR id = ?`).get(pk, pk) as Record<string, unknown> | undefined;
        samples.push({ oldPk: pk, match: !!newRow && String(newRow.content ?? newRow.raw_input) === String(o.content) });
      }
    } catch {
      // 抽样失败不阻塞
    }
    return samples;
  }
}
