/**
 * 🌍 外界动态注入（WX-EXT-1，2026-10-08）
 * ==========================================================
 * 业主反馈：「为什么徐诗雨看不到微信」——实测她的问法下微信条目排 #151~#183，
 * 一条都进不了上下文（点名会话「高峰电业工作群」却能排 #1 进 3 条），
 * 说明权限/分类/通道全通，卡的是**排序**：泛问时 ngram 命中少 ⇒ matchScore
 * 低于 0.30 门槛，而零命中的「行为归纳」靠印象分拿 0.355 反而挤进来。
 *
 * 本测试锁定：
 *   A. 解析 —— 任务书模板逐字段取出，自己发出的写「我」；
 *   B. 注入 —— 独立块在会晤隔离墙**之外**（默认模式也要有外界视野）、
 *              可一键关闭、可见性走唯一判定源（不许手写 UUID 判据）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  parseExternalLine,
  externalTimestampOf,
  isExternalInquiry,
  EXTERNAL_INQUIRY_LINES,
} from '../KnowledgeContextBuilder.js';

const SRC = readFileSync(
  join(process.cwd(), 'src/app/knowledge/KnowledgeContextBuilder.ts'), 'utf-8');

/** 任务书固定模板（逐字） */
const tpl = (
  ts = '2026-10-08 17:06:00',
  chat = '高峰电业工作群',
  sender = '刘运新',
  type = 'other',
  body = '入线模有异常',
) => `【外部微信社交信息】时间：${ts}｜对话对象：${chat}｜发送人：${sender}｜消息类型：${type}｜内容：${body}`;

describe('A. parseExternalLine —— 任务书模板逐字段解析', () => {
  it('A1. 他发消息：时间/会话/发送人/正文全部取出', () => {
    expect(parseExternalLine(tpl())).toBe('10-08 17:06 高峰电业工作群｜刘运新：入线模有异常');
  });

  it('A2. 自己发的写「我」，避免模型把本人发言当成外部人', () => {
    const line = parseExternalLine(tpl('2026-10-08 09:00:00', '六九（徐诗雨）', '我', 'self', '收到'));
    expect(line).toContain('｜我：收到');
    expect(line).not.toContain('我：收到｜');
  });

  it('A3. 正文里的竖线不会被截断（分隔符从左侧非贪婪匹配）', () => {
    const line = parseExternalLine(tpl(undefined, undefined, undefined, 'other', 'a｜b｜c'));
    expect(line.endsWith('a｜b｜c')).toBe(true);
  });

  it('A4. 空/非模板内容 → 空串（不产生脏行）', () => {
    expect(parseExternalLine('')).toBe('');
    expect(parseExternalLine('随便一段不是模板的文本')).toBe('');
  });

  it('A5. 时间必须落到 MM-DD HH:MM（跨天消息不丢日期）', () => {
    expect(parseExternalLine(tpl('2026-10-07 12:08:00'))).toContain('10-07 12:08');
    // 时间字段异常时原样保留，不抛异常
    expect(() => parseExternalLine('时间：x｜对话对象：y｜发送人：z｜消息类型：other｜内容：q')).not.toThrow();
  });

  it('A6. 取出的消息时间是可排序的完整时间戳（不是入库顺序）', () => {
    expect(externalTimestampOf(tpl('2026-10-08 17:06:00'))).toBe('2026-10-08 17:06:00');
    expect(externalTimestampOf(tpl('2026-10-07 12:08:00'))).toBe('2026-10-07 12:08:00');
    // 时间缺失 → 空串（排序时落到末尾，不冒充"最新"）
    expect(externalTimestampOf('【外部微信社交信息】时间：未知｜对话对象：A｜发送人：B｜消息类型：other｜内容：C')).toBe('');
    expect(externalTimestampOf('')).toBe('');
    // 格式定长 ⇒ 字符串比较即时间比较
    expect('2026-10-08 17:06:00' > '2026-10-07 12:08:00').toBe(true);
  });
});

describe('B. 注入块契约', () => {
  it('B1. 必须在会晤隔离墙**之外**（默认模式也要看到外界）', () => {
    const wall = SRC.indexOf('V5.2: 会晤模式知识库检索结束');
    // 函数定义在文件顶部、调用在隔离墙之后 ⇒ 用 lastIndexOf 取到的是调用点
    const inject = SRC.lastIndexOf('loadExternalPerceptionLines(');
    expect(wall).toBeGreaterThan(0);
    expect(inject).toBeGreaterThan(wall);
    // 否则默认模式（非会晤）看不到外界动态
  });

  it('B2. 可一键关闭（KB_EXTERNAL_PERCEPTION=false）', () => {
    expect(SRC).toMatch(/ConfigService\.getBool\('KB_EXTERNAL_PERCEPTION', true\)/);
  });

  it('B3. 可见性走唯一判定源 —— 不许手写 UUID 判据（铁律 0.4）', () => {
    expect(SRC).toMatch(/policyFor\('shared', \[meetingUuid\], \{ restrictedSharing: true \}\)/);
    expect(SRC).toMatch(/policePasses\(/);
    // 手写判据一旦出现即为绕过闸门
    expect(SRC).not.toMatch(/visible_entity_uuids\s*(===|!==|LIKE)/);
  });

  it('B4. 按时间倒序而非按分数 —— 这是与主检索的本质区别', () => {
    // SQL 侧只是收敛取批；真正的顺序由消息时间决定
    expect(SRC).toMatch(/ORDER BY created_at DESC/);
    expect(SRC).not.toMatch(/ORDER BY .*matchScore/);
    expect(SRC).toMatch(/picked\.sort\(/);
  });

  it('B4b. 必须按**消息时间**排，不能只按入库顺序（created_at）', () => {
    // 实测：入库顺序 ≠ 消息时间，按 created_at 会让昨天的消息挤掉今天最新的
    expect(SRC).toMatch(/externalTimestampOf\(/);
    expect(SRC).toMatch(/picked\.slice\(0, limit\)/);
    // 排序依据必须来自取出的 ts，而不是 SQL 返回的 row 顺序
    expect(SRC.indexOf('externalTimestampOf(raw)'))
      .toBeLessThan(SRC.indexOf('picked.sort('));
    expect(SRC).toMatch(/a\.ts < b\.ts \? 1 : a\.ts > b\.ts \? -1 : 0/);
  });

  it('B5. 按搜索等级给条数（闲聊少给、会晤多给）', () => {
    expect(SRC).toMatch(/searchLevel <= 2 \? 8 : searchLevel === 3 \? 5 : 3/);
  });

  it('B6. 失败不阻塞 —— 外界感知挂掉不能影响正常回答', () => {
    expect(SRC).toMatch(/跳过（不阻塞）/);
    // 返回**同一个空对象**（形状与成功路径一致），绝不抛出
    expect(SRC).toMatch(/const empty: ExternalPerception = \{ lines: \[\], expanded: false \}/);
    expect(SRC).toMatch(/console\.warn\('\[KB·外界\] 跳过（不阻塞）:'[\s\S]{0,120}return empty;/);
  });

  it('B7. 未改动主检索的打分公式与门槛（零回归承诺）', () => {
    // 公式与门槛在 KnowledgeEngine / KnowledgeContextBuilder 两处，都要原样在
    const engine = readFileSync(
      join(process.cwd(), 'src/app/knowledge/KnowledgeEngine.ts'), 'utf-8');
    expect(engine).toMatch(
      /boostedTextScore \* 0\.50 \+ impressionScore \* 0\.20 \+ sceneScore \* 0\.15 \+ emotionScore \* 0\.15/);
    expect(SRC).toMatch(/matchScore >= _minScore/);
  });
});

/**
 * C. 方案 A —— 按需扩量 + 模型现场归纳（业主 2026-10-08 决策）
 *   为什么不落库归纳：与 10-07「知识库只存文档 + 微信临时信息」边界冲突，
 *   且会把「行为归纳」那种零命中却拿 0.355 的噪声继续灌进同一个池子。
 */
describe('C. 按需扩量（不落库归纳）', () => {
  it('C1. 打听外界的问句必须命中（微信/群/生产品质类）', () => {
    for (const q of [
      '微信里有什么新消息',
      '群里今天说了什么',
      '生产品质有什么进展',
      '跟单和来料的情况怎么样',
      '外面有什么动态',
      '高峰电业工作群里聊了啥',
    ]) {
      expect(isExternalInquiry(q), `应命中: ${q}`).toBe(true);
    }
  });

  it('C2. 普通闲聊不得误触（免得每轮都多塞 25 条浪费 token）', () => {
    for (const q of ['今天天气怎么样', '你吃饭了吗', '我们聊聊小说吧', '你好']) {
      expect(isExternalInquiry(q), `不该命中: ${q}`).toBe(false);
    }
    expect(isExternalInquiry('')).toBe(false);
  });

  it('C3. 命中即扩量到 25 条，且是常量不是魔法数', () => {
    expect(EXTERNAL_INQUIRY_LINES).toBe(25);
    expect(SRC).toMatch(/expanded\s*\?\s*EXTERNAL_INQUIRY_LINES/);
    // 未命中时仍走原来的分级预算（8/8/5/3）
    expect(SRC).toMatch(/: \(searchLevel <= 2 \? 8 : searchLevel === 3 \? 5 : 3\)/);
  });

  it('C4. 指令随扩量切换 —— 被追问时才允许归纳，平时仍「不要逐条复述」', () => {
    expect(SRC).toMatch(/_ext\.expanded\s*\?/);
    expect(SRC).toMatch(/可以按主题归纳/);
    expect(SRC).toMatch(/不要逐条复述、不要盘问/);
    // 两套指令必须同时存在（少了任一套 = 要么没素材要么乱复述）
    const expanded = SRC.indexOf('可以按主题归纳');
    const normal = SRC.indexOf('不要逐条复述、不要盘问');
    expect(expanded).toBeGreaterThan(0);
    expect(normal).toBeGreaterThan(0);
  });
});
