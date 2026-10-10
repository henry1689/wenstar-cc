/**
 * 工作微信「受限共享可见名单」写入链路契约 —— WX-EXT-2（2026-10-08）
 * ================================================================
 * 业主指令（2026-10-07）：「微信是工作微信，他只对玉瑶和徐诗雨开放。」
 *
 * 背景（实测）：
 *   户籍三元组批2 已经把**读侧**闸门做好了（`policyFor('shared', …, { restrictedSharing: true })`
 *   + `passes()` 认 `visible_entity_uuids`），但**写侧**断了两截：
 *     1. `KnowledgeEngine.add()` 的 INSERT 根本没有 `visible_entity_uuids` 这一列
 *        ⇒ 任何经 HTTP 入库的新条目恒为 NULL；
 *     2. `server-knowledge-routes.ts` 的 body 里既不接 `visible_entity_uuids`
 *        也不接 `belongEntityUuid` ⇒ 调用方传了也被丢掉。
 *   ⇒ 读侧再正确，写侧给不出值，限流对**新数据永不生效**。
 *   此前只有停服才能跑的离线脚本 `scripts/migration/p0-10/set-wechat-visibility.cjs`
 *   能改这一列，且它管不了以后新采的消息。
 *
 * 本测试锁定两件事：
 *   A. **门阀语义**（真代码，非字符串）—— 可见名单非空时只有名单内实体放行；
 *   B. **写入链路**（源码契约）—— add / update / 去重合并 / HTTP 路由四段都必须把
 *      该字段传下去，任何一段掉链子都等于限流失效。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { policyFor, passes } from '../../../governance/police/UUIDPoliceFilter.js';

const YUYAO = 'TXS-000000001';   // 玉瑶
const SHIYU = 'TXS-000000007';   // 徐诗雨
const ZIMING = 'TXS-000000003';  // 熊梓铭（不得看见工作微信）

const ENGINE_SRC = readFileSync(
  join(process.cwd(), 'src/app/knowledge/KnowledgeEngine.ts'), 'utf-8');
const ROUTE_SRC = readFileSync(
  join(process.cwd(), 'src/webui/server-knowledge-routes.ts'), 'utf-8');

describe('A. 门阀语义：可见名单非空时只有名单内实体放行', () => {
  /** 策略按**会话实体**构造 —— `visibleUuids` 是「当前是谁在看」，不是「全体放行」。 */
  const forEntity = (uuid: string) => policyFor('shared', [uuid], { restrictedSharing: true });
  const visibleRow = JSON.stringify([YUYAO, SHIYU]);

  it('名单内（玉瑶 / 徐诗雨）放行 —— 这是功能的正面', () => {
    expect(passes(YUYAO, forEntity(YUYAO), visibleRow)).toBe(true);
    expect(passes(SHIYU, forEntity(SHIYU), visibleRow)).toBe(true);
  });

  it('名单外（熊梓铭）被拒 —— 这是功能的全部意义', () => {
    expect(passes(ZIMING, forEntity(ZIMING), visibleRow)).toBe(false);
  });

  it('空可见集（公共行）按归属判据放行 —— 老数据零回归', () => {
    expect(passes(YUYAO, forEntity(YUYAO), null)).toBe(true);
    expect(passes(ZIMING, forEntity(ZIMING), null)).toBe(true);
  });

  it('名单格式是 JSON 数组字符串 —— 与写入侧 normalizeVisibleList 的输出同形', () => {
    expect(JSON.parse(visibleRow)).toEqual([YUYAO, SHIYU]);
  });

  /**
   * 🔴 锁定**当前已知边界**（改变须先经业主裁决，勿顺手"修"）：
   * `weightedSearch` 在**无会话实体**（`setSessionEntityUuid(null)`，即默认模式）
   * 下构造的是空 SQL 子句 ⇒ 此时不按 `visible_entity_uuids` 过滤。
   * 之所以可接受：默认模式的在场者是默认本体（玉瑶，本身在名单内）；
   * 会晤模式一律带实体 UUID ⇒ 走 `restrictedSharing` 分支，闸门生效。
   * 若将来引入「无会晤但非默认人格」的读取路径，这条边界必须先补上。
   */
  it('默认模式（无会话实体）不加 UUID 子句 —— 现状锁定', () => {
    expect(ENGINE_SRC).toMatch(/const _police = _effUuid\s*\? buildSqlClause\(policyFor\('shared'/);
    expect(ENGINE_SRC).toMatch(/\? buildSqlClause\(policyFor\('shared', \[_effUuid\], \{ restrictedSharing: true \}\)\)\s*\n?\s*: \{ clause: '', params: \[\] as string\[\] \}/);
  });
});

describe('B. 写入链路：四段都必须把 visible_entity_uuids 传下去', () => {
  it('B1. add() 入参声明了该字段（否则路由传了也接不住）', () => {
    expect(ENGINE_SRC).toMatch(/visibleEntityUuids\?:/);
  });

  it('B2. add() 的 INSERT 必须含该列（17 列的旧写法 = 限流永不生效）', () => {
    // 🔴 列与占位符必须**来自同一条** INSERT —— 分开匹配会串到
    //    atom_address_timeline 等别的 INSERT 上，测了等于没测。
    const m = ENGINE_SRC.match(
      /INSERT INTO knowledge_base \(([^)]+)\)\s*VALUES \(([^)]+)\)/,
    );
    expect(m, '找不到 INSERT INTO knowledge_base ... VALUES').toBeTruthy();
    const cols = (m![1] || '').split(',').map((s) => s.trim());
    const placeholders = (m![2] || '').split(',').filter((s) => s.trim() === '?').length;
    expect(cols).toContain('visible_entity_uuids');
    expect(cols).toContain('belong_entity_uuid');
    expect(placeholders).toBe(cols.length);   // 错位 = 静默写串列值
    expect(placeholders).toBe(18);
  });

  it('B3. 归一化收口在唯一入口（畸形输入 fail-closed 回落 null）', () => {
    expect(ENGINE_SRC).toMatch(/function normalizeVisibleList\(/);
    expect(ENGINE_SRC).toMatch(/visible_entity_uuids: normalizeVisibleList\(/);
  });

  it('B4. update() 必须能改该列 —— 去重合并路径走的就是它', () => {
    expect(ENGINE_SRC).toMatch(/UPDATE knowledge_base SET title=\?, content=\?, tags=\?, locked=\?, visible_entity_uuids=\?/);
    // 未传 = 保留既有值（HTTP PUT 不带该字段时零影响）
    expect(ENGINE_SRC).toMatch(/params\.visibleEntityUuids === undefined/);
  });

  it('B5. 去重合并必须携带可见集（否则受限内容并进公共条目 = 泄漏）', () => {
    expect(ENGINE_SRC).toMatch(/update\(dup\.id,\s*\{[\s\S]{0,240}?visibleEntityUuids:\s*params\.visibleEntityUuids/);
  });

  it('B6. HTTP 路由必须从 body 透传可见名单 + 归属（断在路由 = 上游全废）', () => {
    expect(ROUTE_SRC).toMatch(/visibleEntityUuids:\s*body\.visible_entity_uuids/);
    expect(ROUTE_SRC).toMatch(/belongEntityUuid:\s*body\.belongEntityUuid/);
  });
});
