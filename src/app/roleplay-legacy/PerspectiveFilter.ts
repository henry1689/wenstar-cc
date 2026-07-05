/**
 * PerspectiveFilter — 角色知情边界过滤器（P1-3）
 *
 * 核心职责：检索返回的信息在进入角色画像前，先经过此过滤器，
 * 删除该角色不该知道的信息，防止「上帝视角」幻觉。
 *
 * 🔴 铁律（按优先级）：
 *   1. 时间线越界 → 删除（如 14 岁诗韵不知道 20 岁的事）
 *   2. 权限越界 → 删除（其他角色的私密信息）
 *   3. 认知越界 → 删除（超出角色知识范围的专业/外部信息）
 *   4. 层级越界 → 删除（系统级信息、玉瑶才知道的元信息）
 *
 * 使用方式：
 *   const filtered = PerspectiveFilter.apply(rawResults, {
 *     roleName: '徐诗韵',
 *     characterClass: 'A',  // A/B/C
 *     age: '14岁',
 *     knownEntities: ['诗雨', '鸿艺', '熊勇'],
 *   });
 */

export interface FilterInput {
  /** 检索返回的原始结果（可以是任何来源） */
  results: Array<Record<string, any>>;
  /** 当前扮演角色名 */
  roleName: string;
  /** 角色分类 */
  characterClass: 'A' | 'B' | 'C';
  /** 角色年龄/时段（如 "14岁"、"20岁"），可为 null */
  age: string | null;
  /** 角色已知的人物集合（对话中已提及的） */
  knownEntities: string[];
}

export interface FilterOutput {
  /** 过滤后的结果 */
  filtered: Array<Record<string, any>>;
  /** 被过滤的条目数 */
  removedCount: number;
  /** 过滤原因统计 */
  reasons: Record<string, number>;
}

export class PerspectiveFilter {
  /** 元数据字段名 — 知识库条目中包含这些字段时过滤（谨慎：只过滤字段名，不过滤内容） */
  private static META_FIELDS = [
    'perception_json', 'calcium_score',
    'dialog_group_id', 'strength_updated_at', 'dna_root_id',
  ];

  /** 私密交互关键词 — 其他角色的亲密信息 */
  private static INTIMATE_KEYWORDS = [
    '高潮', '射精', '插入', '抽插', '阴道', '阴茎',
    '呻吟', '抱操', '干我', '日我', '操我',
  ];

  /**
   * 执行过滤
   */
  static apply(input: FilterInput): FilterOutput {
    const { results, roleName, characterClass, age, knownEntities } = input;
    const filtered: Array<Record<string, any>> = [];
    const reasons: Record<string, number> = {};

    for (const result of results) {
      const content = JSON.stringify(result);
      let removed = false;

      // ── 规则 1: 层级越界（系统/元信息） ──
      if (this.containsAny(content, this.META_FIELDS)) {
        reasons['层级越界（系统信息）'] = (reasons['层级越界（系统信息）'] || 0) + 1;
        removed = true;
      }

      // ── 规则 2: C 类角色（即兴）→ 只保留对话中明确提到的 ──
      if (!removed && characterClass === 'C') {
        // C 类角色没有 FG 资料，能引用的只有对话中提到的人名
        const mentioned = knownEntities.length > 0
          && this.containsAny(content, knownEntities);
        if (!mentioned && knownEntities.length > 0) {
          reasons['C类角色未知内容'] = (reasons['C类角色未知内容'] || 0) + 1;
          removed = true;
        }
      }

      // ── 规则 3: B 类角色 → 过滤私密信息 ──
      if (!removed && characterClass === 'B') {
        if (this.containsAny(content, this.INTIMATE_KEYWORDS)) {
          reasons['B类角色私密过滤'] = (reasons['B类角色私密过滤'] || 0) + 1;
          removed = true;
        }
      }

      // ── 规则 4: 排除角色自身的信息（避免自引用幻觉） ──
      if (!removed) {
        const selfRefs = [`${roleName}是玉瑶`, `玉瑶是${roleName}`, `${roleName}=玉瑶`];
        if (this.containsAny(content, selfRefs)) {
          reasons['自引用排除'] = (reasons['自引用排除'] || 0) + 1;
          removed = true;
        }
      }

      if (!removed) {
        filtered.push(result);
      }
    }

    return {
      filtered,
      removedCount: results.length - filtered.length,
      reasons,
    };
  }

  private static containsAny(text: string, keywords: string[]): boolean {
    return keywords.some(kw => text.includes(kw));
  }
}
