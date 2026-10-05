import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EntityContextManager } from '../EntityContextManager.js';

/**
 * [V35 / 2026-10-05] 会晤上下文归属 —— 判据必须是 belongEntityUuid，绝不可用文本内容
 * ==================================================================================
 * 背景（S1 实测）：`getContextWindow` 曾用 `content.includes(实体名)` 判定「这轮是谁说的」。
 * 实测徐诗雨 300 条助手回复中 **24.3% 正文不含自己的名字**，因而被整条移出上下文；
 * 且带说话人前缀的为 0 条 ⇒ 判定完全由内容偶然性决定。
 * 后果：模型看不见自己刚说过的话 —— 「聊着聊着忘了前面说的、没有承上启下、话题惯性弱」。
 *
 * 本测试锁住**两个方向**，只锁一个方向会漏掉另一半：
 *   ① 该留的不能丢 —— 助手轮即便正文不含自己名字，也必须留在上下文里
 *   ② 不该留的不能进 —— 他人实体的轮次即便正文**提到了**目标实体名字，也必须排除
 * 旧实现在这两个方向上是同时错的（一个用名字判「是自己的」，一个用名字判「是别人的」）。
 *
 * 样例均为日常语境，不涉亲密内容。
 */

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/** 会晤中的三个户口 */
const U_SHIYU = 'TXS-000000007';   // 徐诗雨（当前会晤对象）
const U_ZIMING = 'TXS-000000009';  // 熊梓铭（他人实体）
const TS = (n: number) => `2026-10-05T10:00:${String(n).padStart(2, '0')}.000Z`;

const mk = (role: 'user' | 'assistant', content: string, belongEntityUuid?: string, n = 0) =>
  ({ role, content, timestamp: TS(n), belongEntityUuid });

describe('[V35] 会晤上下文归属 — 按 belongEntityUuid，不按文本内容', () => {
  const ecm = () => new EntityContextManager();

  it('🔴 该留的不能丢：助手轮正文不含自己的名字，仍必须留在上下文里', () => {
    const history = [
      mk('user', '我们几点出发', U_SHIYU, 1),
      // ↓ 这是被旧实现丢掉的那一类：正文里没有"徐诗雨"三个字
      mk('assistant', '我看看行程，八点吧', U_SHIYU, 2),
      mk('user', '好', U_SHIYU, 3),
    ];
    const out = ecm().getContextWindow(history as any, U_SHIYU, 40);

    expect(out.length, '助手轮不得因正文未提及自己名字而被丢弃').toBe(3);
    expect(
      out.some(t => t.role === 'assistant' && t.content === '我看看行程，八点吧'),
      '助手自己的话必须留在上下文里 —— 它承载"我刚刚说过什么"',
    ).toBe(true);
  });

  it('🔴 不该留的不能进：他人实体的轮次即便正文提到了目标实体名字，也必须排除', () => {
    const history = [
      mk('user', '我们几点出发', U_SHIYU, 1),
      // ↓ 旧实现会因为正文含"徐诗雨"而把它当成徐诗雨的对话收进来
      mk('assistant', '徐诗雨那孩子昨天还问起你', U_ZIMING, 2),
      mk('assistant', '我看看行程，八点吧', U_SHIYU, 3),
    ];
    const out = ecm().getContextWindow(history as any, U_SHIYU, 40);

    expect(out.length, '只应保留归属徐诗雨的两轮').toBe(2);
    expect(
      out.some(t => t.content.includes('徐诗雨那孩子')),
      '他人会话绝不得因"正文提到了名字"而混入当前会晤',
    ).toBe(false);
  });

  it('🔴 deny-by-default：无归属章的轮次一律排除（户籍管理法 fail-closed）', () => {
    const history = [
      mk('user', '有归属的', U_SHIYU, 1),
      mk('assistant', '没有归属的（历史遗留）', undefined, 2),
    ];
    const out = ecm().getContextWindow(history as any, U_SHIYU, 40);
    expect(out.length, '无归属 = 拒绝，不得放行').toBe(1);
    expect(out[0].content).toBe('有归属的');
  });

  it('玉瑶态（entityUuid=null）不按归属过滤，取最近 N 条', () => {
    const history = [
      mk('user', 'a', U_SHIYU, 1),
      mk('assistant', 'b', undefined, 2),
      mk('user', 'c', U_SHIYU, 3),
    ];
    const out = ecm().getContextWindow(history as any, null, 40);
    expect(out.length).toBe(3);
  });

  it('窗口上限生效：超过上限时只保留最近的部分（且仍全部属于该实体）', () => {
    const history: any[] = [];
    for (let i = 0; i < 200; i++) history.push(mk(i % 2 ? 'assistant' : 'user', `第${i}轮`, U_SHIYU, i));
    const out = ecm().getContextWindow(history as any, U_SHIYU, 8);
    // 配置下限（contextWindowTurns）优先，取回条数 = max(8, 配置值)，且不超过总数
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.every(t => (t as any).belongEntityUuid === U_SHIYU)).toBe(true);
    // 是"最近"的一段：末条必须是最后写入的那轮
    expect(out[out.length - 1].content).toBe('第199轮');
  });
});

describe('[V35] 源码守卫 — 防止判据再次退化为「文本含不含名字」', () => {
  it('🔴 getContextWindow 不得出现 content.includes(实体名字) 这类内容判据', () => {
    // 顺序要紧：**先剥注释、再切片**。
    // 文件头的职责说明里也写着 "getContextWindow()"，若先切片会从注释内部开始，
    // 导致块注释缺了开头的 /* 而剥不掉 —— 守卫就会去指控注释里的教训（本次踩过）。
    const src = read('src/app/entity/EntityContextManager.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const body = src.slice(src.indexOf('getContextWindow('), src.indexOf('private _cleanExpiredCache'));
    expect(body, '归属判据必须只看 belongEntityUuid，不得回退到文本内容匹配')
      .not.toMatch(/content[\s\S]{0,10}\.includes\(/);
    expect(body, '必须按归属字段匹配').toContain('belongEntityUuid');
  });

  it('🔴 isolateEntityTurns 不得复活（同一判据的第二份实现）', () => {
    const src = read('src/app/entity/EntityContextManager.ts');
    // 允许在注释里提到它（墓志铭），但不得存在真实的函数声明
    expect(src, 'isolateEntityTurns 已被 UUID 归属过滤取代，不得再引入第二道名字过滤器')
      .not.toMatch(/^\s*isolateEntityTurns\s*\(/m);
  });

  it('🔴 内存镜像必须与数据库同源盖归属章（两处 push 都要带）', () => {
    const src = read('src/webui/chat/persistence-stage.ts');
    const pushes = src.match(/conversationHistory\.push\(\{[^}]*\}/g) || [];
    expect(pushes.length, 'persistence-stage 应有两处内存 push').toBeGreaterThanOrEqual(2);
    for (const p of pushes) {
      expect(p, `内存 push 缺归属章：${p.slice(0, 60)}`).toContain('belongEntityUuid');
    }
  });

  it('🔴 EntityContextStore 的查询映射必须透传归属列（取出来就不能扔）', () => {
    const src = read('src/app/entity/EntityContextStore.ts');
    // 每处 SELECT role, content, timestamp 都必须同时取 belong_entity_uuid
    const selects = src.match(/SELECT role, content, timestamp[^\n]*/g) || [];
    expect(selects.length).toBeGreaterThan(0);
    for (const s of selects) {
      expect(s, `SELECT 漏取归属列：${s}`).toContain('belong_entity_uuid');
    }
    // 映射出口也必须带
    expect((src.match(/belongEntityUuid:/g) || []).length).toBeGreaterThanOrEqual(3);
  });
});
