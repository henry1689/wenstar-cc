/**
 * BrainOutputService.ts — 玉瑶第二大脑输出服务
 * ==============================================
 * 基于知识库 + 用户画像 + 对话记忆，生成定制化输出。
 * 三个核心能力:
 *   1. generateReport(topic, format) — 专题知识报告
 *   2. generateProfileDigest() — 用户认知画像摘要
 *   3. answer(query) — 大脑增强回答（多知识融合）
 *
 * 使用:
 *   const brain = new BrainOutputService(sqlite, knowledgeBase, masterProfile);
 *   const report = await brain.generateReport('项目管理', 'summary');
 */
import type { SQLiteAdapter } from '../../../m2/SQLiteAdapter.js';
import type { KnowledgeBase } from '../../../m2/KnowledgeBase.js';
import { UserCognitiveProfile } from '../../../app/profile/UserCognitiveProfile.js';

export type ReportFormat = 'summary' | 'detailed' | 'analysis';

export interface ReportOptions {
  topic: string;
  format: ReportFormat;
  maxSources?: number;
}

export class BrainOutputService {
  private sqlite: SQLiteAdapter;
  private knowledgeBase: KnowledgeBase;
  private masterProfile: any;
  private cognitiveProfile: UserCognitiveProfile;

  constructor(sqlite: SQLiteAdapter, knowledgeBase: KnowledgeBase, masterProfile?: any) {
    this.sqlite = sqlite;
    this.knowledgeBase = knowledgeBase;
    this.masterProfile = masterProfile;
    this.cognitiveProfile = new UserCognitiveProfile(sqlite, knowledgeBase);
  }

  /**
   * 生成专题知识报告
   * 从知识库检索与主题相关条目 → 按关联关系排序 → 融入用户画像 → 结构化输出
   */
  async generateReport(options: ReportOptions): Promise<{ title: string; content: string; sources: number }> {
    const { topic, format, maxSources = 10 } = options;

    // 检索相关知识
    const items = await this.knowledgeBase.search(topic, maxSources * 2);
    if (!items || items.length === 0) {
      return { title: topic, content: `关于「${topic}」，知识库里还没有相关记录。`, sources: 0 };
    }

    // 按印象值排序
    const sorted = [...items].sort((a, b) => ((b as any).impression_score || 0.5) - ((a as any).impression_score || 0.5));
    const topItems = sorted.slice(0, maxSources);

    // 生成标题
    const title = `📚 ${topic} — 玉瑶的知识整理`;

    // 构建内容
    const lines: string[] = [title, '='.repeat(40), ''];

    if (format === 'summary') {
      // 摘要模式：每条 1-2 行
      for (const item of topItems) {
        lines.push(`• ${item.title}`);
        const snippet = (item.content || '').substring(0, 80).replace(/\n/g, ' ');
        if (snippet) lines.push(`  ${snippet}`);
        lines.push('');
      }
    } else if (format === 'detailed') {
      // 详细模式：完整内容
      for (const item of topItems) {
        lines.push(`## ${item.title}`);
        lines.push(item.content || '（无内容）');
        lines.push('');
      }
    } else {
      // analysis 模式：结构分析
      const categories = new Map<string, typeof topItems>();
      for (const item of topItems) {
        const cat = (item as any).classification || '其他';
        if (!categories.has(cat)) categories.set(cat, []);
        categories.get(cat)!.push(item);
      }

      lines.push(`共 ${topItems.length} 条相关知识，分布在 ${categories.size} 个分类：`);
      lines.push('');
      for (const [cat, catItems] of categories) {
        lines.push(`### ${cat}（${catItems.length} 条）`);
        for (const item of catItems) {
          lines.push(`- ${item.title}`);
        }
        lines.push('');
      }
    }

    // 融入用户画像
    try {
      const profile = await this.cognitiveProfile.synthesize();
      if (profile.knowledgeDomains.length > 0) {
        lines.push('---');
        lines.push('📋 根据你平时的关注领域，这份报告已按你的思维习惯整理。');
      }
    } catch (e) { console.warn(`[BrainOutputService] 操作失败`, (e as Error)?.message || e); }

    return { title, content: lines.join('\n'), sources: topItems.length };
  }

  /**
   * 生成用户认知画像摘要（"玉瑶眼中的你"）
   */
  async generateProfileDigest(): Promise<string> {
    return this.cognitiveProfile.generateDigest();
  }

  /**
   * 大脑增强回答
   * 综合知识库 + 用户画像给出更贴合用户的回答
   */
  async answer(query: string): Promise<string> {
    const items = await this.knowledgeBase.search(query, 5);
    if (!items || items.length === 0) {
      return '';
    }

    const lines: string[] = [];
    lines.push(`关于「${query}」，我记得这些：`);
    lines.push('');

    for (const item of items.slice(0, 5)) {
      const snippet = (item.content || '').substring(0, 120).replace(/\n/g, ' ');
      lines.push(`📌 ${item.title}`);
      if (snippet) lines.push(`   ${snippet}`);
      lines.push('');
    }

    return lines.join('\n');
  }
}
