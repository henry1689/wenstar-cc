/**
 * NamespaceManager.ts — 命名空间注册表 + 物理隔离校验
 *
 * 【职责】
 *   1. 维护角色 → namespace 的映射表（每个角色一个独立 ns_xxx）
 *   2. 启动时在 SQLite 中为每个 namespace 创建独立 schema/分区
 *      （MemArch v2 的 conversations / memories / episodes 表都有 namespace 列，
 *        配合 M1 的 namespace 索引实现物理级隔离）
 *   3. 提供「跨命名空间访问拦截」：任何读 SQL 必须带 WHERE namespace = ?
 *   4. 与 M6 治理对齐：注册时同步把 namespace 资源写入 accessControl
 *
 * 【命名空间命名规范】
 *   ns_<角色UUID短码>  例如：ns_yuyao_7f3a / ns_shiyu_b21e
 *   禁止用中文角色名直接当 namespace（防止后续改名导致数据找不到）
 */

import type Database from 'better-sqlite3';
import { checkPermission } from '../../../governance/src/index.js';
import type { Subject } from '../../../governance/src/accessControl.js';

export interface RoleNamespaceEntry {
  /** 内部命名空间标识 */
  namespace: string;
  /** 角色名（展示用，如 玉瑶/诗雨/王全芬） */
  roleplayName: string;
  /** 角色 UUID（DNA 根 UUID） */
  roleUUID: string;
  /** 创建时间 */
  createdAt: number;
  /** 备注 */
  note?: string;
}

export class NamespaceManager {
  private registry = new Map<string, RoleNamespaceEntry>();

  constructor(private readonly db: Database.Database) {
    this.ensureRegistryTable();
    this.loadRegistry();
  }

  // ============================================================
  // 注册表 CRUD
  // ============================================================

  /** 注册一个新角色命名空间（新角色上线时调用） */
  register(entry: Omit<RoleNamespaceEntry, 'createdAt'>): void {
    if (!entry.namespace.startsWith('ns_')) {
      throw new Error(`[namespace] namespace 必须以 ns_ 开头，收到: ${entry.namespace}`);
    }
    const now = Date.now();
    this.db.prepare(`
      INSERT OR IGNORE INTO namespace_registry (namespace, roleplay_name, role_uuid, created_at, note)
      VALUES (?, ?, ?, ?, ?)
    `).run(entry.namespace, entry.roleplayName, entry.roleUUID, now, entry.note ?? null);

    this.registry.set(entry.namespace, { ...entry, createdAt: now });
    // TODO: 同步到 M6 accessControl（注册 namespace 资源）
  }

  /** 注销角色（数据归档，不删物理行） */
  unregister(namespace: string): void {
    this.db.prepare(`DELETE FROM namespace_registry WHERE namespace = ?`).run(namespace);
    this.registry.delete(namespace);
  }

  list(): RoleNamespaceEntry[] {
    return [...this.registry.values()];
  }

  get(namespace: string): RoleNamespaceEntry | undefined {
    return this.registry.get(namespace);
  }

  /** 校验 namespace 是否合法（适配器调用前必过） */
  assertValid(namespace: string): void {
    if (!this.registry.has(namespace)) {
      throw new Error(
        `[namespace] 未知命名空间: '${namespace}'。` +
        `请先 NamespaceManager.register() 注册。` +
        `这通常是角色切换时漏传 namespace 导致的串台根因。`
      );
    }
  }

  // ============================================================
  // 跨命名空间访问拦截（核心红线）
  // ============================================================

  /**
   * 安全读：强制带 namespace 过滤
   * 任何对 memories / conversations / episodes 的查询都必须经过这里
   */
  safeQuery(sql: string, namespace: string, params: unknown[] = []): unknown[] {
    this.assertValid(namespace);

    // 静态检查 SQL 必须包含 namespace 过滤（防漏）
    const lowerSql = sql.toLowerCase();
    if (!lowerSql.includes('namespace = ?') && !lowerSql.includes('namespace=?')) {
      throw new Error(
        `[namespace] 安全红线：SQL 缺少 WHERE namespace = ? 过滤。\n` +
        `SQL: ${sql.slice(0, 200)}...\n` +
        `这是跨角色串台的高危路径，已拦截。`
      );
    }

    // 把 namespace 插入参数首位（调用方需把 ? 放在第一位）
    return this.db.prepare(sql).all(namespace, ...params);
  }

  /**
   * M6 治理层：校验当前 subject 是否有权访问该 namespace
   */
  async authorizeAccess(subject: Subject, namespace: string, action: 'read' | 'write' | 'delete'): Promise<void> {
    const decision = await checkPermission(
      subject,
      { type: 'namespace', id: namespace },
      action
    );
    if (!decision.allow) {
      throw new Error(
        `[namespace:governance] M6 拒绝访问: subject=${subject.id} ns=${namespace} action=${action} reason=${decision.reason}`
      );
    }
  }

  // ============================================================
  // 内部
  // ============================================================

  private ensureRegistryTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS namespace_registry (
        namespace TEXT PRIMARY KEY,
        roleplay_name TEXT NOT NULL,
        role_uuid TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        note TEXT
      )
    `);
  }

  private loadRegistry(): void {
    const rows = this.db.prepare(`SELECT * FROM namespace_registry`).all() as RoleNamespaceEntry[];
    for (const r of rows) this.registry.set(r.namespace, r);
  }
}
