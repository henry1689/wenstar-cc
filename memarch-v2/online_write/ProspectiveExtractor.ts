/**
 * MemArch-v2.0.0 / M2-OnlineWrite / ProspectiveExtractor
 *
 * 前瞻记忆在线抽取（正则库驱动）
 * 识别模式：承诺类 / 提醒类 / 时间类 / 计划类
 * 写入 prospective_items 表
 *
 * 设计依据：主设计文档 §4.2 步骤⑦
 */

import { createHash, randomUUID } from 'node:crypto';
import type { WriteQueue } from '../storage/write_queue/WriteQueue.js';
import { M2_CONFIG } from './config.js';
import type { ProspectiveItem } from './types.js';

interface PatternDef {
  kind: ProspectiveItem['kind'];
  trigger_type: ProspectiveItem['trigger_type'];
  pattern: RegExp;
  confidence: number;
}

/** 正则库（可扩充，M3/M6 可在此基础上增强） */
const PATTERNS: PatternDef[] = [
  // ===== 承诺类 =====
  {
    kind: 'promise',
    trigger_type: 'event',
    pattern: /(我答应你|我会记得|下次一定|我保证|我发誓|一言为定|说话算话)/,
    confidence: 0.9,
  },
  {
    kind: 'promise',
    trigger_type: 'event',
    pattern: /(我会[记做办]|我一定[要会]|我保证[会]|答应[你我])/,
    confidence: 0.7,
  },

  // ===== 提醒类 =====
  {
    kind: 'reminder',
    trigger_type: 'time',
    pattern: /(别忘了|记得提醒我|到时候说一声|提醒我|记得[要去做]|不要忘记)/,
    confidence: 0.85,
  },
  {
    kind: 'reminder',
    trigger_type: 'event',
    pattern: /(到时候提醒|等.*的时候|到了.*告诉我)/,
    confidence: 0.7,
  },

  // ===== 计划类 =====
  {
    kind: 'plan',
    trigger_type: 'time',
    pattern: /(我们要去|约好|计划着|打算去|准备去|安排了|定好了)/,
    confidence: 0.8,
  },
  {
    kind: 'plan',
    trigger_type: 'event',
    pattern: /(下周|下个月|下个月|这周末|下周末|周一|周二|周三|周四|周五|周六|周日|星期[一二三四五六日])/,
    confidence: 0.65,
  },

  // ===== 纪念日类 =====
  {
    kind: 'anniversary',
    trigger_type: 'time',
    pattern: /(纪念日|生日|周年|情人节|圣诞节|春节|过年|中秋|端午|国庆)/,
    confidence: 0.9,
  },
];

export class ProspectiveExtractor {
  constructor(private readonly writer: WriteQueue) {}

  /**
   * 从文本中抽取前瞻记忆条目
   * @param content 消息文本
   * @param sourceMessageId 来源消息 ID
   * @param owner 归属（user 说的 = user，assistant 承诺的 = assistant）
   */
  extract(
    content: string,
    sourceMessageId: string,
    owner: 'user' | 'assistant',
  ): ProspectiveItem[] {
    const results: ProspectiveItem[] = [];
    const minConf = M2_CONFIG.prospective.min_confidence;

    for (const def of PATTERNS) {
      const match = content.match(def.pattern);
      if (!match) continue;
      if (def.confidence < minConf) continue;

      results.push({
        kind: def.kind,
        trigger_type: def.trigger_type,
        content: match[0],
        owner,
        confidence: def.confidence,
        source_message_id: sourceMessageId,
        matched_pattern: def.pattern.source,
        due_at: this.inferDueAt(content, def.trigger_type),
      });
    }

    // 去重（同一条消息命中多个相似模式时，保留置信度最高的）
    return this.deduplicate(results);
  }

  /**
   * 将抽取的前瞻记忆写入 prospective_items 表
   */
  async persist(items: ProspectiveItem[], namespace: string): Promise<string[]> {
    const ids: string[] = [];
    for (const item of items) {
      const id = this.generateId(item);
      await this.writer.enqueue((db) => {
        db.prepare(`
          INSERT OR IGNORE INTO prospective_items
            (id, kind, content, owner, trigger_type, due_at, status, source_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `).run(
          id,
          item.kind,
          item.content,
          item.owner,
          item.trigger_type,
          item.due_at ?? null,
          item.source_message_id,
          Date.now(),
        );
      }, 'high');
      ids.push(id);
    }
    return ids;
  }

  /**
   * 简单推断到期时间（粗粒度，精确版由 M3 或日历模块处理）
   */
  private inferDueAt(content: string, triggerType: string): number | undefined {
    const now = Date.now();
    const HOUR = 3_600_000;
    const DAY = 24 * HOUR;

    if (triggerType !== 'time') return undefined;

    if (/下周/.test(content)) return now + 7 * DAY;
    if (/下个月/.test(content)) return now + 30 * DAY;
    if (/这周末/.test(content) || (/周末/.test(content) && !/下/.test(content))) {
      // 粗略：加 3-5 天到周末
      return now + 3 * DAY;
    }
    if (/下周末/.test(content)) return now + 10 * DAY;
    if (/明天/.test(content)) return now + DAY;
    if (/今天/.test(content)) return now + HOUR * 12;
    if (/一会儿|待会|马上/.test(content)) return now + HOUR;

    return undefined;
  }

  /** 同类型去重，保留置信度最高的 */
  private deduplicate(items: ProspectiveItem[]): ProspectiveItem[] {
    const byKind = new Map<string, ProspectiveItem>();
    for (const item of items) {
      const existing = byKind.get(item.kind);
      if (!existing || item.confidence > existing.confidence) {
        byKind.set(item.kind, item);
      }
    }
    return Array.from(byKind.values());
  }

  /** 生成唯一 ID */
  private generateId(item: ProspectiveItem): string {
    const raw = `${item.source_message_id}:${item.kind}:${item.matched_pattern}`;
    return `pi_${createHash('sha1').update(raw).digest('hex').slice(0, 16)}`;
  }
}
