/**
 * summary-semantics.test.ts — 摘要条目语义契约 + 归档豁免
 * =========================================================
 * 背景（2026-09-13 砂金库全局诊断）：
 *   `conversations` 里 `is_compacted=1` 有 1969 条，而 `is_summary=1` **一条都没有**。
 *   实测摘要条目长这样：
 *     id=447  is_compacted=1  is_summary=0  | 【对话摘要】【历史对话】你好 徐诗雨 你好呀 散会…
 *
 *   **三重失效**：
 *     ① `ConversationDB.insertConversation` 的 options **没有 `isSummary` 字段**，
 *        写入时把 `is_compacted` 的值同时赋给 `is_summary`（注释称"过渡兼容"）→
 *        摘要永远落不了 `is_summary=1`。
 *     ② `Maintenance.runCompaction` 的归档 SQL 不带 `AND (is_summary IS NULL OR is_summary=0)`
 *        → **摘要条目被自己归档压掉**，随即失去"摘要"身份。
 *     ③ 摘要生成未排除已有摘要 → 反复摘要，实测出现 `【对话摘要】【历史对话】【历史对话】` 嵌套。
 *
 *   后果：早期记忆既不在近期窗口（被归档）、又没有可识别的摘要（is_summary=0）、
 *   还被当普通对话再摘要一次 —— 砂金库的"压缩→摘要"通道形同虚设。
 *
 * 契约（本测试锁定）：
 *   A. `isSummary=1` 写入 → `is_summary=1` 且 `is_compacted=0`（摘要不参与归档）
 *   B. 不带 `isSummary` 的普通对话 → `is_summary=0`（不误标）
 *   C. `isCompacted` 与 `isSummary` **互相独立**，不再联动赋值
 *
 * 测试用库落在 D:\tmp（遵守 C 盘禁写铁律）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ConversationDB } from '../ConversationDB.js';

const TMP_DIR = 'D:/tmp';

/** 用类型交集断言取尚未实现的 isSummary 字段，避免实现落地前 S3 tsc 前置检查失败 */
type InsertOpts = NonNullable<Parameters<ConversationDB['insertConversation']>[2]>;
type SummaryOpts = InsertOpts & { isSummary: number };

let db: ConversationDB;
let dbPath: string;

beforeEach(async () => {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  dbPath = path.join(TMP_DIR, 'test-summary-semantics-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.db');
  db = new ConversationDB(dbPath);
  await db.initialize();
});

afterEach(() => {
  try { db?.close?.(); } catch { /* 忽略 */ }
  try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch { /* 忽略 */ }
});

describe('摘要条目语义契约', () => {
  it('🔴 A. isSummary=1 → 落库 is_summary=1 且 is_compacted=0（摘要不被归档）', () => {
    db.insertConversation('assistant', '【对话摘要】用户与徐诗雨讨论了天气。', {
      seqPos: 0,
      isSummary: 1,
    } as SummaryOpts);

    const rows = db.queryAll(
      "SELECT is_summary, is_compacted FROM conversations WHERE content LIKE '【对话摘要】%'",
    ) as any[];

    expect(rows.length).toBe(1);
    expect(Number(rows[0].is_summary)).toBe(1);
    expect(Number(rows[0].is_compacted)).toBe(0);
  });

  it('🔴 C. isCompacted 与 isSummary 互相独立（不再联动赋值）', () => {
    // 只标归档、不标摘要 → is_summary 必须仍为 0
    db.insertConversation('user', '一条被归档的普通对话', { seqPos: 1, isCompacted: 1 } as InsertOpts);
    // 只标摘要、不标归档 → is_compacted 必须仍为 0
    db.insertConversation('assistant', '【对话摘要】另一条摘要', { seqPos: 2, isSummary: 1 } as SummaryOpts);

    const archived = db.queryAll("SELECT is_summary FROM conversations WHERE content = '一条被归档的普通对话'") as any[];
    const summary = db.queryAll("SELECT is_compacted FROM conversations WHERE content = '【对话摘要】另一条摘要'") as any[];

    expect(Number(archived[0].is_summary)).toBe(0);
    expect(Number(summary[0].is_compacted)).toBe(0);
  });

  it('✅ B. 普通对话（不带 isSummary）→ is_summary=0，不误标', () => {
    db.insertConversation('user', '普通消息', { seqPos: 3 });

    const rows = db.queryAll("SELECT is_summary, is_compacted FROM conversations WHERE content = '普通消息'") as any[];
    expect(Number(rows[0].is_summary)).toBe(0);
    expect(Number(rows[0].is_compacted)).toBe(0);
  });
});
