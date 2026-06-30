// M4Orchestrator — M4 知识融合层主控制器
// Ref: M4-design-v1.md §5

import type { M3Decision } from '../m3/types/perception.js';
import type { M4Context, MemorySummary } from './types/index.js';
import type { DNA } from "../m1/types/dna.js";
import type { ScoredMemory } from '../m2/types/index.js';
import type { FusionStorageAdapter } from '../m2/FusionStorageAdapter.js';
import { MemoryRetriever } from './MemoryRetriever.js';
import { FamilyGraph } from './FamilyGraph.js';

export class M4Orchestrator {
  private memoryRetriever: MemoryRetriever;
  private familyGraph: FamilyGraph;
  /** 🎭 角色扮演 FG 分支覆盖（不为 null 时，所有 FG 操作走分支而非主 FG） */
  private _familyGraphOverride: any = null;

  constructor(storage: FusionStorageAdapter, familyGraph?: FamilyGraph, knowledgeBase?: any) {
    this.memoryRetriever = new MemoryRetriever(storage, knowledgeBase);
    this.familyGraph = familyGraph ?? new FamilyGraph();
  }

  async initialize(): Promise<void> {
    await this.familyGraph.initialize();
  }

  /** 🎭 设置/清除 FG 分支覆盖 — 角色扮演时调用，退出时清除 */
  setFamilyGraphOverride(override: any): void {
    this._familyGraphOverride = override;
    console.log(`[M4] ${override ? '🎭 启用FG分支覆盖' : '✅ 清除FG分支覆盖'}`);
  }

  /**
   * 获取当前生效的 FamilyGraph
   * 角色扮演时返回分支 FG，否则返回主 FG
   */
  getFamilyGraph(): any {
    return this._familyGraphOverride || this.familyGraph;
  }

  /**
   * 对 M3 决策执行完整的 M4 知识融合流程
   * @param emotionalSummaries 可选：情感检索结果，注入到 timeline 头部
   */
  async orchestrate(decision: M3Decision, emotionalSummaries?: ScoredMemory[]): Promise<M4Context> {
    const entities = decision.enhanced.entity_genes.map((g) => ({
      name: g.name,
      type: g.type,
    }));
    const locusPath = decision.enhanced.locus_path;

    // 1. 记忆检索 + 上下文压缩（含情感相似度跨场景关联）
    const memories = await this.memoryRetriever.retrieveMemories(locusPath, entities, {
      perception: decision.enhanced.perception,
    });
    const memorySummary = this.memoryRetriever.compressMemories(memories);

    // 2. 家族知识图谱自动推断：角色扮演时自动走分支 FG（通过 getFamilyGraph() 路由）
    const activeFG = this.getFamilyGraph();
    await activeFG.integrateFromEntity(
      decision.enhanced.entity_genes,
      decision.enhanced.raw_input
    );

    // 3. 获取家族知识摘要 + 社交关系摘要
    const familySummary = await activeFG.getFamilySummary();
    const socialSummary = await activeFG.getSocialSummary();

    // 4. 构建家族上下文 + 社交上下文（含完整人物档案）
    const enrichProfile = (name: string) => {
      const profile = activeFG.getPersonProfile(name);
      return {
        appearance: profile?.appearance,
        body_features: profile?.body_features,
        traits: profile?.traits,
        occupation: profile?.occupation,
        description: profile?.description,
        style: (profile as any)?.style,
        personality: profile?.personality,
        interests: profile?.interests,
      };
    };

    const familyContext = familySummary.members.map((m: { name: string; relation_to_user: string; aliases: string[] }) => ({
      entity: m.name,
      relation: m.relation_to_user,
      related_entity: '我',
      ...enrichProfile(m.name),
    }));
    const socialContext = socialSummary.connections.map((c: { name: string; relation_to_user: string; note?: string }) => ({
      entity: c.name,
      relation: c.relation_to_user,
      related_entity: '我',
      ...enrichProfile(c.name),
    }));

    // 5. 注入情感检索结果（按时间排序后合并到 timeline 头部）
    if (emotionalSummaries && emotionalSummaries.length > 0) {
      const emotionalEntries = emotionalSummaries
        .map(em => ({
          time: em.record.created_at,
          summary: em.record.raw_input.substring(0, 60),
          calcium_level: em.record.calcium_level,
        }))
        .sort((a, b) => a.time.localeCompare(b.time));
      memorySummary.timeline = [...emotionalEntries, ...memorySummary.timeline];
    }

    // 6. 输出 M4Context（含检索质量）
    return {
      decision,
      memory_summary: memorySummary,
      family_context: familyContext.length > 0 ? familyContext : undefined,
      social_context: socialContext.length > 0 ? socialContext : [],
      current_time: new Date().toISOString(),
      meta: {
        has_history: memories.length > 0,
        has_family_context: familySummary.members.length > 0,
        calcium_level: decision.enhanced.calcium_level,
        dominant_action: decision.actions[0] ?? 'memorize',
      },
      retrieval_quality: {
        total_candidates: memories.length,
        avg_match_score: memories.length > 0
          ? Math.round(memories.reduce((s: number, m: DNA) => Math.max(s, m.calcium_score ?? 0), 0) / memories.length * 100) / 100
          : 0,
        strategies_used: ["locus", "keyword", "emotion"].filter(s => s !== ""),
      },
    };
  }

}
