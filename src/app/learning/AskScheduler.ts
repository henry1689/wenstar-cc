/**
 * AskScheduler.ts — 玉瑶反问智能调度器
 * =======================================
 * 决定"什么时候反问用户知识分类最合适"。
 *
 * 门控条件:
 *   1. M3 感知: 用户情绪好 (pleasure > -0.2, arousal < 0.6, intimacy < 0.5)
 *   2. 距离上次反问 > 2 小时
 *   3. 有待分类知识 (classification_pending = 1)
 *   4. 不是工作/事务对话场景
 *
 * 分类建议: 从标题/内容关键词自动推断 3 个候选分类。
 *
 * 使用:
 *   const scheduler = new AskScheduler(storage);
 *   const should = await scheduler.shouldAsk(perception);
 *   const suggestions = scheduler.suggestClassifications(title);
 */
import type { FusionStorageAdapter } from '../../m2/FusionStorageAdapter.js';
import type { PerceptionState24 } from '../../m3/types/perception.js';

export interface AskDecision {
  shouldAsk: boolean;
  reason: string;
  pendingCount: number;
  suggestions: string[];
}

const ASK_INTERVAL_MS = 2 * 3600_000; // 2 小时

// 标题关键词 → 分类建议映射
const CLASSIFICATION_KEYWORDS: Record<string, string[]> = {
  '吃|喝|饮食|菜|饭|餐|食': ['饮食偏好', '生活记录'],
  '工作|项目|客户|方案|报告|公司|上班|同事|老板|开会': ['工作记录', '用户资料'],
  '喜欢|爱|讨厌|不喜欢|不爱|很爽|很差': ['用户偏好', '兴趣爱好'],
  '习惯|经常|平时|每周|每天|每周|每次': ['生活记录', '用户习惯'],
  '家人|妈妈|爸爸|妈|爸|老婆|老公|孩子|父母': ['亲友信息', '家庭关系'],
  '电影|书|音乐|游戏|电视|小说|动漫|画画|唱': ['兴趣爱好', '娱乐记录'],
  '身体|生病|健康|医院|医生|药|疼|痛|累|困|睡': ['健康记录', '身体状况'],
  '学|读书|课|培训|考|考试': ['学习记录', '成长记录'],
  '买|购物|想买|价格|钱': ['消费记录', '生活记录'],
};

export class AskScheduler {
  private storage: FusionStorageAdapter;

  constructor(storage: FusionStorageAdapter) {
    this.storage = storage;
  }

  /**
   * 判断现在是否适合反问
   */
  async shouldAsk(perception: PerceptionState24): Promise<AskDecision> {
    const decisions: AskDecision = {
      shouldAsk: false,
      reason: '',
      pendingCount: 0,
      suggestions: [],
    };

    try {
      const sqlite = this.storage.getSQLite();

      // 1. 检查是否有待分类知识
      const pending = sqlite.queryAll(
        `SELECT COUNT(*) as cnt FROM knowledge_base WHERE classification_pending = 1`
      );
      decisions.pendingCount = (pending[0] as any)?.cnt || 0;
      if (decisions.pendingCount === 0) {
        decisions.reason = '无待分类知识';
        return decisions;
      }

      // 2. M3 感知门控
      if ((perception.pleasure ?? 0) < -0.2) {
        decisions.reason = '用户情绪低落 (pleasure=' + (perception.pleasure ?? 0).toFixed(2) + ')';
        return decisions;
      }
      if ((perception.arousal ?? 0) > 0.6) {
        decisions.reason = '用户过于兴奋 (arousal=' + (perception.arousal ?? 0).toFixed(2) + ')';
        return decisions;
      }
      if ((perception.intimacy ?? 0) > 0.5) {
        decisions.reason = '亲密场景不适合反问';
        return decisions;
      }

      // 3. 距离上次反问 > 2 小时
      const lastAsk = sqlite.queryAll(
        `SELECT MAX(created_at) as last FROM knowledge_base WHERE classification = '冲突检测' OR classification_pending = 0`
      );
      if (lastAsk.length > 0 && (lastAsk[0] as any)?.last) {
        const lastTime = new Date((lastAsk[0] as any).last as string).getTime();
        if (Date.now() - lastTime < ASK_INTERVAL_MS) {
          decisions.reason = '距离上次反问不到 2 小时';
          return decisions;
        }
      }

      decisions.shouldAsk = true;
      decisions.reason = '适合反问 (' + decisions.pendingCount + ' 条待分类)';
    } catch (err) {
      decisions.reason = '调度器异常: ' + (err as Error).message;
    }

    return decisions;
  }

  /**
   * 从标题/内容推断分类建议
   */
  suggestClassifications(title: string, content?: string): string[] {
    const combined = (title + ' ' + (content || '')).toLowerCase();
    const suggestions = new Set<string>();

    for (const [pattern, tags] of Object.entries(CLASSIFICATION_KEYWORDS)) {
      if (new RegExp(pattern).test(combined)) {
        for (const tag of tags) suggestions.add(tag);
      }
    }

    if (suggestions.size === 0) suggestions.add('其他');
    if (suggestions.size > 3) {
      // 限制最多 3 个建议
      return [...suggestions].slice(0, 3);
    }

    return [...suggestions];
  }

  /**
   * 获取下一条待反问的知识
   */
  async nextPending(): Promise<{ id: string; title: string; suggestions: string[] } | null> {
    try {
      const sqlite = this.storage.getSQLite();
      const rows = sqlite.queryAll(
        `SELECT id, title, content FROM knowledge_base
         WHERE classification_pending = 1
         ORDER BY created_at ASC LIMIT 1`
      );
      if (rows.length === 0) return null;
      const r = rows[0] as any;
      return {
        id: r.id as string,
        title: r.title as string,
        suggestions: this.suggestClassifications(r.title as string, r.content as string),
      };
    } catch { return null; }
  }
}
