/**
 * SchemaMapper.ts — 新旧 schema 映射
 *
 * 【旧库 → 新库字段映射表】
 *
 * 旧库（src/m2/schema.sql + src/m4/entity-topology-schema.sql）:
 *   - conversations(id, role, content, ts, persona, calcium_level, ...)
 *   - memories(uuid, content, summary, salience, calcium, ...)
 *   - episodes / family_graph / entity_topology ...
 *
 * 新库（memarch-v2/storage/ddl/01_schema_init.sql）:
 *   - conversations(message_id, namespace, roleplay_char, role, content, ts_utc,
 *                    episode_id, lifecycle_state, sensitivity, ...)
 *   - memories(id, namespace, raw_input, summary, episode_id, salience, arousal,
 *              self_relevance, consolidation, lifecycle_state, created_at, ...)
 *   - episodes(id, namespace, started_at, status, consolidation, lifecycle_state, ...)
 *
 * 【关键映射】
 *   旧 conversations.id  → 新 conversations.message_id（保留原 ID 做幂等）
 *   旧 persona 字段      → 新 roleplay_char + namespace（拆成两个字段）
 *   旧 calcium_level     → 新 memories.consolidation（归一化到 [0,1]）
 *   旧 memories.uuid     → 新 memories.id
 *   旧 namespace 缺失   → 按 persona 反查 namespace_registry 补填
 */

export interface SchemaMap {
  oldTable: string;
  newTable: string;
  /** 字段映射：oldCol -> newCol */
  columnMap: Record<string, string>;
  /** 必填字段校验（缺失则该行迁移失败） */
  requiredOldCols: string[];
  /** 默认值填充（新字段旧库没有时） */
  defaults: Record<string, unknown>;
}

export const SCHEMA_MAPS: SchemaMap[] = [
  {
    oldTable: 'conversations',
    newTable: 'conversations',
    columnMap: {
      id: 'message_id',
      role: 'role',
      content: 'content',
      ts: 'ts_utc',
      persona: 'roleplay_char',
    },
    requiredOldCols: ['id', 'role', 'content', 'ts'],
    defaults: {
      namespace: '__RESOLVE_FROM_PERSONA__',  // 特殊标记：迁移时按 persona 反查
      episode_id: null,
      lifecycle_state: 'archived',  // 历史数据标记为已归档，不参与活跃召回
      sensitivity: 0,
    },
  },
  {
    oldTable: 'memories',
    newTable: 'memories',
    columnMap: {
      uuid: 'id',
      content: 'raw_input',
      summary: 'summary',
      salience: 'salience',
      calcium_level: 'consolidation',  // 旧 0-5 归一化到新 0-1
    },
    requiredOldCols: ['uuid', 'content'],
    defaults: {
      namespace: '__RESOLVE_FROM_PERSONA__',
      episode_id: null,
      arousal: 0.3,
      self_relevance: 0.5,
      lifecycle_state: 'calcium',  // 历史记忆默认钙化
      created_at: 0,
    },
  },
];

/**
 * 把旧钙化解值（0-5）归一化到新巩固度（0-1）
 */
export function normalizeCalcium(oldLevel: number | null | undefined): number {
  if (oldLevel == null) return 0.3;
  return Math.max(0, Math.min(1, oldLevel / 5));
}

/**
 * 按 persona 反查 namespace
 * 旧库 persona 字段是中文角色名（玉瑶/诗雨/...），
 * 新系统需要 ns_xxx 格式的命名空间。
 */
export function resolveNamespaceFromPersona(
  persona: string | null | undefined,
  personaToNamespace: Record<string, string>
): string {
  if (!persona) return 'ns_unknown';
  const ns = personaToNamespace[persona];
  if (!ns) {
    // 未注册的角色 → 隔离区 namespace，防止污染正式角色
    return `ns_unregistered_${Buffer.from(persona).toString('hex').slice(0, 8)}`;
  }
  return ns;
}
