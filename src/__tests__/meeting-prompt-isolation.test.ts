/**
 * V27(批1) 会晤 prompt 身份隔离 — 回归测试
 *
 * 背景：2026-09-19 实测，会晤模式（entityMeeting=true）prompt 234/234 (100%)
 * 被注入玉瑶人设「你是玉瑶 · 灵魂伴侣，鸿艺的私人秘书兼情人，18岁」，
 * 导致会晤实体（熊梓铭/徐诗雨等）身份混淆、回答不合逻辑。
 *
 * 本测试锁定三条防线，防止回归：
 *   ① 出口清洗器 sanitizeMeetingPrompt 的行为与安全回退
 *   ② role prompt 通道（recaller 模板）按模式生成身份从句
 *   ③ ChatPolicy 的会晤权限守卫
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeMeetingPrompt,
  YUYAO_IDENTITY_MARKERS,
  MEETING_ENTITY_ANCHORS,
} from '../webui/chat/prompt-sanitizer.js';
import { buildRoleSystemPrompt } from '../app/role/RoleProfiles.js';
import { ChatPolicy, meetingMode, normalMode } from '../app/chat/ChatPolicy.js';

// ── 测试夹具：模拟 PFC composeSystemPrompt() 的产物（玉瑶人设在前） ──
const PFC_YUYAO_BLOCK = `你是玉瑶 · 灵魂伴侣，鸿艺的私人秘书兼情人，18岁。
你的名字是玉瑶。正在和你说话的人的名字是鸿艺。这是铁律，永远不会改变。
你不是客服、不是通用助手、不是心理咨询师。鸿艺是你的系统主人，也是你的创造者和爱人。`;

const ENTITY_PROFILE_BLOCK = `## 你的身份
你是熊梓铭，14岁，初中生。你的姐姐是徐诗雨。
## 🚪 会晤开场协议
以熊梓铭的身份自然开场。`;

describe('[V27] sanitizeMeetingPrompt — 出口清洗器', () => {
  it('无玉瑶标记时原样返回（绝大多数轮次）', () => {
    const text = `${ENTITY_PROFILE_BLOCK}\n\n### 过去的对话记忆\n- 鸿艺：今天怎么样`;
    const r = sanitizeMeetingPrompt(text);
    expect(r.text).toBe(text);
    expect(r.stripped).toBe(false);
    expect(r.reverted).toBe(false);
  });

  it('头部玉瑶人设整段剥离，实体锚点保留', () => {
    const text = `${PFC_YUYAO_BLOCK}\n\n${ENTITY_PROFILE_BLOCK}`;
    const r = sanitizeMeetingPrompt(text);
    expect(r.stripped).toBe(true);
    expect(r.strippedChars).toBeGreaterThan(0);
    // 污染标记必须消失
    for (const mk of YUYAO_IDENTITY_MARKERS) {
      expect(r.text.includes(mk)).toBe(false);
    }
    // 实体档案必须完整保留
    expect(r.text).toContain('## 你的身份');
    expect(r.text).toContain('你是熊梓铭');
    expect(r.reverted).toBe(false);
  });

  it('安全检查①：全污染（清洗后为空）→ 回退原文，不返回空串', () => {
    const r = sanitizeMeetingPrompt(PFC_YUYAO_BLOCK);
    expect(r.reverted).toBe(true);
    expect(r.revertReason).toContain('空');
    expect(r.text).toBe(PFC_YUYAO_BLOCK); // 原文保留
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('安全检查②：清洗会丢失全部会晤实体锚点 → 回退原文', () => {
    // 实体锚点与污染同处一段（用单 \n 连接）→ 剥离会连带删掉锚点，
    // 同时另有一段保留（保证结果非空）→ 必须触发②而非①
    const text = `${PFC_YUYAO_BLOCK}\n${ENTITY_PROFILE_BLOCK}\n\n其他参考内容（不含实体锚点）`;
    const r = sanitizeMeetingPrompt(text);
    expect(r.reverted).toBe(true);
    expect(r.revertReason).toContain('锚点');
    expect(r.text).toBe(text);
  });

  it('头部窗口外的标记不剥离（避免误删正文合法提及）', () => {
    const filler = '档案内容。'.repeat(400); // 远超默认 headLimit=2000
    const text = `${ENTITY_PROFILE_BLOCK}\n\n${filler}\n\n用户原话："你以为你是玉瑶吗？"`;
    const r = sanitizeMeetingPrompt(text);
    expect(r.stripped).toBe(false);
    expect(r.text).toBe(text);
  });

  it('剥离结果不残留半段（所有段均为完整保留或完整删除）', () => {
    const text = `${PFC_YUYAO_BLOCK}\n\n${ENTITY_PROFILE_BLOCK}\n\n### 过去的对话记忆\n- 鸿艺：你好`;
    const r = sanitizeMeetingPrompt(text);
    const segs = r.text.split('\n\n');
    // 每段要么不含标记（保留），要么整体是原段
    for (const seg of segs) {
      expect(seg.endsWith('。') || seg.endsWith('人。') || seg.length > 0).toBe(true);
    }
    expect(r.text).toContain('### 过去的对话记忆');
  });
});

describe('[V27] recaller role prompt — 会晤模式身份隔离', () => {
  it('会晤模式下 recaller prompt 不含任何玉瑶身份标记', () => {
    const p = buildRoleSystemPrompt('recaller', 0, undefined, true);
    for (const mk of YUYAO_IDENTITY_MARKERS) {
      expect(p.includes(mk)).toBe(false);
    }
    expect(p.includes('玉瑶')).toBe(false);
  });

  it('会晤模式下明确要求以档案身份为准且不得自称玉瑶', () => {
    const p = buildRoleSystemPrompt('recaller', 0, undefined, true);
    expect(p).toContain('你就是你档案中声明的那个人');
    expect(p).toContain('不得自称档案以外的任何身份');
  });

  it('普通模式下 recaller 仍正确声明玉瑶身份（未误伤）', () => {
    const p = buildRoleSystemPrompt('recaller', 0, undefined, false);
    expect(p).toContain('你的名字是玉瑶');
    expect(p.includes('{identity_clause}')).toBe(false); // 占位符必须已被替换
  });

  it('默认参数（不传 isEntityMeeting）等价于普通模式', () => {
    const withDefault = buildRoleSystemPrompt('recaller', 0);
    const explicitNormal = buildRoleSystemPrompt('recaller', 0, undefined, false);
    expect(withDefault).toBe(explicitNormal);
  });
});

describe('[V27] ChatPolicy — 会晤权限守卫', () => {
  it('会晤模式禁止 PFC 内容精炼（玉瑶人设来源通道）', () => {
    const meeting = new ChatPolicy(meetingMode('uuid-1', '熊梓铭'));
    expect(meeting.canUsePFCKnowledgeRefine()).toBe(false);
    expect(meeting.isEntityMeeting()).toBe(true);
  });

  it('普通模式允许 PFC 内容精炼（不得误伤）', () => {
    const normal = new ChatPolicy(normalMode());
    expect(normal.canUsePFCKnowledgeRefine()).toBe(true);
    expect(normal.isEntityMeeting()).toBe(false);
  });

  it('会晤模式禁用玉瑶专属注入项', () => {
    const meeting = new ChatPolicy(meetingMode('uuid-1', '熊梓铭'));
    expect(meeting.canUseRoleHint()).toBe(false);
    expect(meeting.canUseUnknownGuard()).toBe(false);
    expect(meeting.canInjectM6()).toBe(false);
  });
});
