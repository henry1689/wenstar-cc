/**
 * EntityTopologyManager — 全局实体关系拓扑管理器
 *
 * v3.0 核心能力：
 *   1. 双向持久化：录入关系时自动写入正反两条记录
 *   2. 标准化关系枚举：一套字典覆盖亲属/社交/商业
 *   3. 多级递归检索：顺藤摸瓜跨实体查询
 *   4. 存量迁移：一次性补全历史数据
 */
import type { SQLiteAdapter } from '../m2/SQLiteAdapter.js';

// ─── 标准化关系枚举 ───

export type TopologyRelationType =
  // 直系亲属
  | 'mother' | 'father' | 'daughter' | 'son'
  | 'elder_sister' | 'elder_brother' | 'younger_sister' | 'younger_brother'
  // 配偶
  | 'wife' | 'husband'
  // 旁系
  | 'aunt' | 'uncle' | 'cousin' | 'niece' | 'nephew'
  // 隔代
  | 'grandmother' | 'grandfather' | 'granddaughter' | 'grandson'
  // 社交
  | 'colleague' | 'friend' | 'partner' | 'client' | 'boss' | 'subordinate' | 'acquaintance'
  // 商业
  | 'employer' | 'employee' | 'investor' | 'supplier';

/** 关系 → 反向关系 映射 */
const REVERSE_MAP: Record<string, string> = {
  mother: 'daughter', father: 'son',
  daughter: 'mother', son: 'father',
  elder_sister: 'younger_sister', younger_sister: 'elder_sister',
  elder_brother: 'younger_brother', younger_brother: 'elder_brother',
  sister: 'sister', brother: 'brother',
  wife: 'husband', husband: 'wife',
  aunt: 'niece', uncle: 'nephew', niece: 'aunt', nephew: 'uncle',
  cousin: 'cousin',
  grandmother: 'granddaughter', grandfather: 'grandson',
  granddaughter: 'grandmother', grandson: 'grandfather',
  colleague: 'colleague', friend: 'friend', partner: 'partner',
  client: 'server', server: 'client',
  boss: 'subordinate', subordinate: 'boss',
  acquaintance: 'acquaintance',
  employer: 'employee', employee: 'employer',
  investor: 'investor', supplier: 'supplier',
};

/** 关系 → 拓扑层级 映射 */
const LEVEL_MAP: Record<string, number> = {
  mother: 1, father: 1, daughter: 1, son: 1,
  elder_sister: 1, younger_sister: 1, elder_brother: 1, younger_brother: 1,
  sister: 1, brother: 1,
  wife: 1, husband: 1,
  aunt: 2, uncle: 2, niece: 2, nephew: 2, cousin: 2,
  grandmother: 2, grandfather: 2, granddaughter: 2, grandson: 2,
  colleague: 2, friend: 2, partner: 2,
  client: 3, server: 3, boss: 3, subordinate: 3,
  acquaintance: 3,
  employer: 2, employee: 2, investor: 3, supplier: 3,
};

// ─── 拓扑记录接口 ───

export interface TopologyRecord {
  id: string;
  root_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  reverse_relation: string;
  topology_level: number;
  namespace: string;
  dna_root_id?: string;
  created_at: string;
  updated_at: string;
}

// ─── 管理器 ───

export class EntityTopologyManager {
  private sqlite: SQLiteAdapter;
  private uid: () => string;

  constructor(sqlite: SQLiteAdapter, uidFn?: () => string) {
    this.sqlite = sqlite;
    this.uid = uidFn || (() => Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8));
  }

  // ─── 初始化 ───

  async initialize(): Promise<void> {
    this.sqlite.writeRaw(`CREATE TABLE IF NOT EXISTS entity_topology (
      id TEXT PRIMARY KEY,
      root_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      reverse_relation TEXT NOT NULL,
      topology_level INTEGER DEFAULT 1,
      namespace TEXT DEFAULT 'default',
      dna_root_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    try { this.sqlite.writeRaw('CREATE INDEX IF NOT EXISTS idx_topology_root ON entity_topology(root_entity_id, topology_level)'); } catch (e) { console.warn(`[EntityTopology] 操作失败`, (e as Error)?.message || e); }
    try { this.sqlite.writeRaw('CREATE INDEX IF NOT EXISTS idx_topology_target ON entity_topology(target_entity_id, topology_level)'); } catch (e) { console.warn(`[EntityTopology] 操作失败`, (e as Error)?.message || e); }
    try { this.sqlite.writeRaw('CREATE INDEX IF NOT EXISTS idx_topology_type ON entity_topology(relation_type)'); } catch (e) { console.warn(`[EntityTopology] 操作失败`, (e as Error)?.message || e); }
    try { this.sqlite.writeRaw('CREATE INDEX IF NOT EXISTS idx_topology_ns ON entity_topology(namespace)'); } catch (e) { console.warn(`[EntityTopology] 操作失败`, (e as Error)?.message || e); }
  }

  // ─── 双向写入 ───

  /**
   * 写入双向关系拓扑
   * 自动写入正反两条记录：徐诗雨——elder_sister→徐诗韵 + 徐诗韵——younger_sister→徐诗雨
   * （诗雨18岁是姐姐，诗韵14岁是妹妹）
   */
  addRelation(
    entityA: string,
    relation: string,
    entityB: string,
    namespace = 'default',
    dnaRootId?: string,
  ): void {
    const now = new Date().toISOString();
    const reverse = REVERSE_MAP[relation] || 'acquaintance';
    const level = LEVEL_MAP[relation] ?? 2;
    const revLevel = LEVEL_MAP[reverse] ?? 2;
    const isoTime = now;

    // R2: 用确定性 id（非随机）使 INSERT OR REPLACE 对同关系去重，避免重复插入。
    // id = root_id : target_id : relation : namespace 的拼接，保证同一关系对永远只有一个行。
    const id = `${entityA}:${entityB}:${relation}:${namespace}`;

    // 正向: A → B
    this.sqlite.writeRaw(
      `INSERT OR REPLACE INTO entity_topology (id, root_entity_id, target_entity_id, relation_type, reverse_relation, topology_level, namespace, dna_root_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, entityA, entityB, relation, reverse, level, namespace, dnaRootId || null, isoTime, isoTime],
    );

    // 反向: B → A（自动计算反向关系）
    this.sqlite.writeRaw(
      `INSERT OR REPLACE INTO entity_topology (id, root_entity_id, target_entity_id, relation_type, reverse_relation, topology_level, namespace, dna_root_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id + '_rev', entityB, entityA, reverse, relation, revLevel, namespace, dnaRootId || null, isoTime, isoTime],
    );
  }

  // ─── 多级递归检索（顺藤摸瓜） ───

  /**
   * 从根实体出发，递归查询关联实体
   * @param rootEntity 根实体名
   * @param maxLevel 最大递归深度（默认3层）
   * @param targetRelation 可选：筛选目标关系类型
   * @param namespace 命名空间
   */
  queryRelatives(
    rootEntity: string,
    maxLevel = 3,
    targetRelation?: string,
    namespace = 'default',
  ): TopologyRecord[] {
    const results: TopologyRecord[] = [];
    const visited = new Set<string>();
    const queue: Array<{ entity: string; currentLevel: number }> = [
      { entity: rootEntity, currentLevel: 1 },
    ];
    visited.add(rootEntity);

    while (queue.length > 0) {
      const { entity, currentLevel } = queue.shift()!;
      if (currentLevel > maxLevel) continue;

      // 查该实体为root的所有出边
      const rows = this.sqlite.queryAll(
        `SELECT * FROM entity_topology WHERE root_entity_id = ? AND topology_level <= ? AND namespace = ? ORDER BY topology_level`,
        [entity, maxLevel - currentLevel + 1, namespace],
      ) as any[];

      for (const row of rows) {
        const record = this.rowToRecord(row);
        if (!visited.has(record.target_entity_id)) {
          // 如果筛选了关系类型
          if (targetRelation && record.relation_type !== targetRelation) continue;
          results.push(record);
          visited.add(record.target_entity_id);
          queue.push({ entity: record.target_entity_id, currentLevel: currentLevel + 1 });
        }
      }
    }

    return results;
  }

  /**
   * 从根实体出发，查找指定关系的目标实体
   * 示例：queryRelation('徐诗韵', 'mother') → [{target_entity_id:'阿苏', relation_type:'mother'}]
   */
  queryRelation(rootEntity: string, targetRelation: string, namespace = 'default'): TopologyRecord[] {
    // 不限制层级，找所有匹配的关系
    const all = this.queryRelatives(rootEntity, 3, undefined, namespace);
    return all.filter(r => r.relation_type === targetRelation || r.reverse_relation === targetRelation);
  }

  /**
   * 获取实体的完整关系链路描述（供LLM提示词使用）
   * 返回如 ["我的妈妈是阿苏", "我的姐姐是徐诗雨"] 的数组
   */
  getRelationDescriptions(rootEntity: string, namespace = 'default'): string[] {
    const rels = this.queryRelatives(rootEntity, 2, undefined, namespace);
    const labelMap: Record<string, string> = {
      mother: '妈妈', father: '爸爸',
      elder_sister: '姐姐', elder_brother: '哥哥',
      younger_sister: '妹妹', younger_brother: '弟弟',
      sister: '姐妹', brother: '兄弟',
      wife: '老婆', husband: '老公',
      daughter: '女儿', son: '儿子',
      aunt: '姑姑/阿姨', uncle: '叔叔/舅舅',
      cousin: '表亲', niece: '侄女/外甥女', nephew: '侄子/外甥',
      grandmother: '奶奶/外婆', grandfather: '爷爷/外公',
      colleague: '同事', friend: '朋友', partner: '合伙人',
      boss: '上级', subordinate: '下属', client: '客户',
      acquaintance: '认识的人',
    };

    return rels.map(r => {
      const label = labelMap[r.relation_type] || r.relation_type;
      return `我的${label}是${r.target_entity_id}`;
    });
  }

  // ─── 存量迁移 ───

  /**
   * 从 FamilyGraph 存量数据批量补全拓扑
   * 遍历 nodes + edges 生成双向拓扑记录
   */
  migrateFromFamilyGraph(fg: any, namespace = 'default'): number {
    let count = 0;
    const relMap: Record<string, string> = {
      mother_of: 'mother', father_of: 'father',
      child_of: 'daughter', parent_of: 'daughter',
      sibling_of: 'sibling',
      elder_sister_of: 'elder_sister',
      younger_sister_of: 'younger_sister',
      sister_of: 'sister',
      brother_of: 'brother',
      elder_brother_of: 'elder_brother',
      younger_brother_of: 'younger_brother',
      spouse_of: 'wife',
      aunt_of: 'aunt', uncle_of: 'uncle',
      niece_of: 'niece', nephew_of: 'nephew',
      cousin_of: 'cousin',
      friend_of: 'friend', colleague_of: 'colleague',
      partner_of: 'partner', client_of: 'client',
      boss_of: 'boss', subordinate_of: 'subordinate',
      acquaintance_of: 'acquaintance',
    };

    try {
      const names = fg.getAllPersonNames();
      for (const name of names || []) {
        if (!name) continue;
        const related = fg.getRelatedPersons(name);
        if (!related || related.length === 0) continue;
        for (const r of related) {
          const rel = relMap[r.relation];
          if (!rel || !r.name || r.name === name) continue;
          try { this.addRelation(name, rel, r.name, namespace); count++; }
          catch (_e) { console.log('[EntityTopology] skip: ' + name + '->' + r.name + ' rel=' + r.relation + ' err=' + _e); }
        }
      }
    } catch (err) {
      try {
        // Fallback: traverse nodes directly via searchPersonWithMemories
        const persons = fg.getAllPersonNames();
        for (const name of persons || []) {
          if (!name) continue;
          const result = fg.searchPersonWithMemories(name);
          if (!result || !result.relations) continue;
          for (const r of result.relations) {
            const rel = relMap[r.relation];
            if (!rel || !r.name || r.name === name) continue;
            try { this.addRelation(name, rel, r.name, namespace); count++; }
            catch (_e) { console.log('[EntityTopology] skip2: ' + name + '->' + r.name + ' rel=' + r.relation + ' err=' + _e); }
          }
        }
      } catch (err2) {
        console.warn('[EntityTopology] 存量迁移失败:', err2);
      }
    }
    return count;
  }

  // ─── 工具 ───

  private rowToRecord(row: any): TopologyRecord {
    return {
      id: row.id,
      root_entity_id: row.root_entity_id,
      target_entity_id: row.target_entity_id,
      relation_type: row.relation_type,
      reverse_relation: row.reverse_relation,
      topology_level: row.topology_level ?? 1,
      namespace: row.namespace || 'default',
      dna_root_id: row.dna_root_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
