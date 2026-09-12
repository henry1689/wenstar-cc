import { describe, it, expect } from 'vitest';
import * as DG from '../dialog-group-stage.js';

// [P0-① + P2] 对话组锚点的归属守卫与署名（2026-09-12）
//
// 背景：`flushDialogGroup` 解析锚点归属时是三层降级（dg.entities → characterName →
//   conversations 按 seq_pos 反查），**三层全失败即静默写 belong_entity_uuid = null**。
//   与会话逐轮写入（persistence-stage 有强制三级兜底）规则不一致，实测产生 117 条无归属记忆
//   —— 它们在会晤场景被 fail-closed 拒之门外（永远召不回），且服务重启时会被
//   _rebuildMemoryAnchors 的无条件 DELETE 清掉而不会重建（永久消失）。
//
// 修复（对齐《UUID户籍管理法》第五条/第七条）：
//   P0-① 守卫链：三层解析 → 会晤实体 UUID → 玉瑶 UUID → 仍为空则拒绝写入（宁拒不放）
//   P2   署名：原硬编码 '玉瑶: '，会晤徐诗雨时也写"玉瑶说" → 改用归属实体的真实姓名
//
// 红测试写法：待实现导出用 Record 断言取用，避免实现落地前让 S3 的 tsc 前置检查失败。
// 样例为日常语境，不涉亲密内容。

type OwnershipFn = (
  dg: any,
  sql: any,
  fg: any,
  fallbacks?: { meetingUuid?: string | null; yuyaoUuid?: string | null },
) => { uuid: string | null; source: string };
type SpeakerFn = (fg: any, entityUuid: string | null) => string;

const dgMod = DG as unknown as Record<string, unknown>;
const resolveAnchorOwnership = dgMod.resolveAnchorOwnership as OwnershipFn | undefined;
const resolveAnchorSpeaker = dgMod.resolveAnchorSpeaker as SpeakerFn | undefined;

const UUID_XSY = 'TXS-000000007';   // 徐诗雨
const UUID_YY = 'TXS-000000001';    // 玉瑶（户主）

/** 最小化 FG：名字↔UUID 双向可查 */
function mkFg(map: Record<string, string>) {
  return {
    getUUIDByName: (n: string) => map[n] ?? null,
    getEntityByUUID: (u: string) => {
      const name = Object.keys(map).find((k) => map[k] === u);
      return name ? { uuid: u, name } : null;
    },
  };
}

describe('[P0-①] 锚点归属解析 + 守卫（无户口写入拒绝）', () => {
  it('导出 resolveAnchorOwnership', () => {
    expect(typeof resolveAnchorOwnership).toBe('function');
  });

  it('① dg.entities 命中 → 用该实体 UUID', () => {
    const fg = mkFg({ 徐诗雨: UUID_XSY });
    const r = resolveAnchorOwnership!({ entities: ['徐诗雨'], rounds: [] }, null, fg, {});
    expect(r.uuid).toBe(UUID_XSY);
  });

  it('② 实体名解析不到 → 会晤实体 UUID 兜底', () => {
    const fg = mkFg({});
    const r = resolveAnchorOwnership!({ entities: ['查无此人'], rounds: [] }, null, fg, { meetingUuid: UUID_XSY });
    expect(r.uuid).toBe(UUID_XSY);
  });

  it('③ 会晤实体也没有 → 玉瑶 UUID 兜底', () => {
    const fg = mkFg({});
    const r = resolveAnchorOwnership!({ entities: [], rounds: [] }, null, fg, { yuyaoUuid: UUID_YY });
    expect(r.uuid).toBe(UUID_YY);
  });

  it('④ 全部失败 → 返回 null（调用方据此拒绝写入，不再静默写空）', () => {
    const fg = mkFg({});
    const r = resolveAnchorOwnership!({ entities: [], rounds: [] }, null, fg, {});
    expect(r.uuid).toBeNull();
  });

  it('⑤ conversations 按 seq_pos 反查兜底', () => {
    const fg = mkFg({});
    const sql = {
      queryAll: (s: string) => (/FROM conversations/.test(s) ? [{ belong_entity_uuid: UUID_XSY }] : []),
    };
    const r = resolveAnchorOwnership!({ entities: [], rounds: [{ seqPos: 42 }] }, sql, fg, {});
    expect(r.uuid).toBe(UUID_XSY);
  });

  it('⑥ 传入空/非法 seqPos 时不崩，走到守卫返回 null', () => {
    const fg = mkFg({});
    const sql = { queryAll: () => [] };
    const r = resolveAnchorOwnership!({ entities: [], rounds: [{ seqPos: 0 }, { seqPos: null }] }, sql, fg, {});
    expect(r.uuid).toBeNull();
  });
});

describe('[P2] 锚点说话人署名 —— 不再硬编码"玉瑶"', () => {
  it('导出 resolveAnchorSpeaker', () => {
    expect(typeof resolveAnchorSpeaker).toBe('function');
  });

  it('归属实体有效 → 用实体真实姓名', () => {
    const fg = mkFg({ 徐诗雨: UUID_XSY });
    expect(resolveAnchorSpeaker!(fg, UUID_XSY)).toBe('徐诗雨');
  });

  it('无归属 → 回退玉瑶', () => {
    const fg = mkFg({});
    expect(resolveAnchorSpeaker!(fg, null)).toBe('玉瑶');
  });

  it('UUID 在户籍中查不到 → 回退玉瑶，不抛错', () => {
    const fg = mkFg({});
    expect(resolveAnchorSpeaker!(fg, 'TXS-999999999')).toBe('玉瑶');
  });
});
