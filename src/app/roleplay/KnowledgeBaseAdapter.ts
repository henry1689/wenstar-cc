/**
 * KnowledgeBaseAdapter — 知识库适配器
 *
 * 🔴 补充3项角色化适配（底层引擎不变）：
 *   1. roleplay_id + source=roleplay 双标记（复用tags字段，不改表结构）
 *   2. 多人物名+话题关键词联合召回
 *   3. 加权检索最低匹配分阈值过滤
 *
 * 使用方式：
 *   const kbAdapter = new KnowledgeBaseAdapter(knowledgeBase);
 *   const results = await kbAdapter.searchByRoleplay('徐诗韵', {roleplayId: 'rp_xxx'});
 *   // results 已按 >0.15 阈值过滤
 */
import type { KnowledgeItem } from '../knowledge/types.js';

/** 加权检索结果的扩展类型 */
export interface ScoredKnowledgeItem extends KnowledgeItem {
  matchScore: number;
  breakdown: {
    scene: number;
    emotion: number;
    text: number;
  };
}

/** 角色扮演检索选项 */
export interface RoleplaySearchOptions {
  /** 角色扮演会话ID（用于隔离检索） */
  roleplayId?: string;
  /** 角色名列表（联合召回） */
  personNames?: string[];
  /** 话题关键词（附加） */
  topic?: string;
  /** 返回上限 */
  limit?: number;
  /** 最低匹配分（默认0.15） */
  minScore?: number;
  /** 场景标签 */
  sceneTags?: string[];
  /** 情感上下文 */
  emotionalContext?: { pleasure: number; arousal: number; intimacy: number };
}

/** 标记常量 */
const TAG_SOURCE = 'source=roleplay';
const TAG_PREFIX = 'rp_';

export class KnowledgeBaseAdapter {
  private kb: any;

  constructor(knowledgeBase: any) {
    this.kb = knowledgeBase;
  }

  // ─── 适配点1：角色标记 + 过滤 ───

  /**
   * 获取角色过滤用的 tag 模式
   * 匹配规则：tags 中包含 rp_{roleplayId} 标记
   */
  static makeRoleTag(roleplayId: string): string {
    return TAG_PREFIX + roleplayId;
  }

  /**
   * 判断条目是否属于指定角色
   * 不依赖表结构，仅检查 tags 数组
   */
  static isMatchRole(item: KnowledgeItem, roleplayId: string): boolean {
    const tag = TAG_PREFIX + roleplayId;
    return item.tags?.includes(tag) ?? false;
  }

  // ─── 适配点2：多人物名+话题关键词联合召回 ───

  /**
   * 角色扮演场景的知识检索
   *
   * 联合召回逻辑：
   *   1. 对每个角色名+话题关键词做加权检索
   *   2. 结果按 matchScore 统一排序去重
   *   3. 低于 minScore 的丢弃
   *   4. 如果指定 roleplayId，仅返回带标记的条目
   */
  async searchByRoleplay(
    characterName: string,
    options: RoleplaySearchOptions = {},
  ): Promise<ScoredKnowledgeItem[]> {
    const {
      roleplayId,
      personNames = [],
      topic = '',
      limit = 5,
      minScore = 0.15,
      sceneTags = [],
      emotionalContext,
    } = options;

    // 构建检索关键词列表：角色名 + 亲属名 + 话题
    const keywords = [characterName, ...personNames];
    if (topic && !keywords.includes(topic)) {
      keywords.push(topic);
    }

    // 对每个关键词做加权检索
    const allResults: ScoredKnowledgeItem[] = [];
    const seen = new Set<string>();

    for (const kw of keywords) {
      if (!kw || kw.length < 2) continue;
      try {
        const hits: ScoredKnowledgeItem[] = await this.kb.weightedSearch(
          kw,
          sceneTags,
          emotionalContext,
          limit * 2, // 放宽获取再合并过滤
        );
        if (!hits || hits.length === 0) continue;

        for (const h of hits) {
          // 去重
          if (seen.has(h.id)) continue;
          seen.add(h.id);

          // 适配点1：角色隔离过滤
          if (roleplayId && !KnowledgeBaseAdapter.isMatchRole(h, roleplayId)) {
            // 如果是纯角色扮演场景，跳过非标记条目
            if (h.tags?.includes(TAG_SOURCE)) continue;
          }

          // 适配点3：最低匹配分阈值
          if (h.matchScore < minScore) continue;

          allResults.push(h);
        }
      } catch { /* 单关键词失败不影响其他 */ }
    }

    // 按 matchScore 降序排列
    allResults.sort((a, b) => b.matchScore - a.matchScore);

    return allResults.slice(0, limit);
  }

  // ─── 适配点3：阈值过滤包装 ───

  /**
   * 带阈值过滤的加权检索
   * 直接包装原有 weightedSearch，增加 minScore 丢弃逻辑
   */
  async weightedSearchFiltered(
    keyword: string,
    sceneTags: string[],
    perception?: { pleasure: number; arousal: number; intimacy: number },
    limit = 5,
    minScore = 0.15,
  ): Promise<ScoredKnowledgeItem[]> {
    try {
      const results: ScoredKnowledgeItem[] = await this.kb.weightedSearch(
        keyword, sceneTags, perception, limit * 2,
      );
      if (!results) return [];

      return results
        .filter(r => r.matchScore >= minScore)
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  /**
   * 带阈值过滤的基础关键词检索
   */
  async searchFiltered(
    keyword: string,
    limit = 5,
    minScore = 0.15,
  ): Promise<ScoredKnowledgeItem[]> {
    try {
      const results = await this.kb.search(keyword, limit * 2);
      if (!results) return [];

      // search() 返回普通 KnowledgeItem，给默认分
      return (results as ScoredKnowledgeItem[])
        .filter(r => (r.matchScore ?? 0.5) >= minScore)
        .slice(0, limit);
    } catch {
      return [];
    }
  }
}
