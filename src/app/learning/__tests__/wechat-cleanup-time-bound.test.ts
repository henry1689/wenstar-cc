/**
 * 微信过期清理的时间边界 —— 契约锁定（2026-10-08，业主：「要改」）
 * ================================================================
 * 背景（实测）：
 *   原实现是**无时间条件的全量 DELETE** `source_name LIKE 'wechat_relay/%'`。
 *   而 `_lastRunDate` 是**内存态**、服务一重启即清零，`start()` 又是「启动后立即执行一次」
 *   ⇒ **每次重启都全量清一遍**。
 *   实测当日 pm2 `↺20` 次重启，微信条目从 909 → 0 全部发生在白天，
 *   此时中继侧 `RETENTION_HOURS=24` 的 22:00 清扫还没到 ⇒「保留当天」被打破，
 *   玉瑶白天查不到当天的外部消息。
 *
 * 改法：只删**超过 24h** 的，与中继保留期同语义。
 *
 * 本测试锁定两件事，任何一条被改回都要先经业主裁决：
 *   A. 时间边界必须在（禁止退回全量删）
 *   B. 结构性判据不变（「只删 wechat_relay/*」是业主明文规则，不能扩大成按内容猜）
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(process.cwd(), 'src/app/learning/DailyMaintenanceScheduler.ts'), 'utf-8');

/** 截取「微信清理」那一段（⓪-b），避免断言撞到别处的 SQL。 */
function block(): string {
  const start = SRC.indexOf('⓪-b');
  const end = SRC.indexOf('① 知识衰减');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe('A. 时间边界必须在（禁止退回全量删）', () => {
  it('A1. DELETE 必须带 created_at < ? 条件', () => {
    expect(block()).toMatch(
      /DELETE FROM knowledge_base WHERE source_name LIKE 'wechat_relay\/%' AND created_at < \?/);
  });

  it('A2. 阈值必须是 24 小时（与中继 RETENTION_HOURS=24 同语义）', () => {
    expect(block()).toMatch(/Date\.now\(\) - 24 \* 3600_000/);
  });

  it('A3. 不得存在无时间条件的全量删（一旦出现即为回归）', () => {
    const unbounded = block().match(
      /DELETE FROM knowledge_base WHERE source_name LIKE 'wechat_relay\/%'(?! AND)/g);
    expect(unbounded, '出现无时间边界的全量 DELETE —— 会让白天重启即丢当天数据')
      .toBeNull();
  });

  it('A4. 删除量必须落日志（业主原则：清了没清要看得见）', () => {
    expect(block()).toMatch(/微信过期清理\(>24h\)/);
    expect(block()).toMatch(/changes/);   // 取的是实际删除行数，不是「待清总数」
  });
});

describe('B. 结构性判据不变', () => {
  it('B1. 判定依据仍是 source_name 前缀（不许改成按内容猜）', () => {
    expect(block()).toMatch(/source_name LIKE 'wechat_relay\/%'/);
  });

  it('B2. 未超 24h 的分支必须明确走「不清理」', () => {
    expect(block()).toMatch(/均未超 24h，本次不清理/);
  });

  it('B3. 失败不阻塞（清理异常不得中断整个每日维护）', () => {
    expect(block()).toMatch(/微信临时信息清理失败\(不阻塞\)/);
  });
});
