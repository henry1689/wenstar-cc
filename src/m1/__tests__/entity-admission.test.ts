/**
 * entity-admission 契约测试（ADR-020）
 *
 * 锁定四件事：
 *   ① 解析：只有正文开始前的 `entity:` 头被识别；正文里的 entity: 不算；
 *   ② 反幻觉硬闸门：证据必须是用户消息的**连续子串**，名字必须在证据里；
 *   ③ 失败安全：纯 JSON / 畸形头 / 无头 一律按正文处理，绝不吞正文；
 *   ④ 流式闸门：跨块到达的头不进输出；无头消息原样放行。
 */
import { describe, it, expect } from 'vitest';
import {
  parseEntityEvidence,
  verifyAdmission,
  verifyAdmissions,
  EvidenceHeaderGate,
  ENTITY_EVIDENCE_INSTRUCTION,
} from '../entity-admission.js';

describe('parseEntityEvidence · 字段边界解析', () => {
  it('标准头 + 分隔行 → 提取实体且正文干净', () => {
    const text = 'entity: 安琪|person|她叫安琪\nentity: 罗珍思|person|这是我同事罗珍思\n---\n好啊，安琪这个名字挺温柔的。';
    const r = parseEntityEvidence(text);
    expect(r.present).toBe(true);
    expect(r.entities.map(e => e.name)).toEqual(['安琪', '罗珍思']);
    expect(r.body).toBe('好啊，安琪这个名字挺温柔的。');
  });

  it('没有头 → 原样返回、零实体', () => {
    const text = '今天天气不错，我们出去走走吧。';
    const r = parseEntityEvidence(text);
    expect(r.present).toBe(false);
    expect(r.entities).toEqual([]);
    expect(r.body).toBe(text);
  });

  it('正文里出现 entity: 不会被误判（头只扫正文开始前）', () => {
    const text = '好的，我记下了。\nentity: 假名字|person|并不存在';
    const r = parseEntityEvidence(text);
    expect(r.present).toBe(false);
    expect(r.entities).toEqual([]);
    expect(r.body).toBe(text);
  });

  it('纯 JSON → 整体跳过（V45：宁可漏处理，不可削正文）', () => {
    const text = '{"answer":"hi"}';
    const r = parseEntityEvidence(text);
    expect(r.present).toBe(false);
    expect(r.body).toBe(text);
  });

  it('畸形行计入 malformed，不影响合法行', () => {
    const text = 'entity: 缺字段\nentity: 安琪|person|她叫安琪\n---\n正文';
    const r = parseEntityEvidence(text);
    expect(r.present).toBe(true);
    expect(r.malformed).toBe(1);
    expect(r.entities.map(e => e.name)).toEqual(['安琪']);
    expect(r.body).toBe('正文');
  });

  it('无分隔行但头后紧跟正文 → 头仍剥离（宽容）', () => {
    const text = 'entity: 安琪|person|她叫安琪\n好啊，安琪。';
    const r = parseEntityEvidence(text);
    expect(r.present).toBe(true);
    expect(r.body).toBe('好啊，安琪。');
  });
});

describe('verifyAdmission · 原文证据硬闸门', () => {
  const MSG = '她叫安琪，是我以前的同事';

  it('证据是消息连续子串且包含名字 → 准入', () => {
    const v = verifyAdmission({ name: '安琪', type: 'person', evidence: '她叫安琪' }, MSG);
    expect(v.admitted).toBe(true);
  });

  it('证据不在消息里（编造）→ 拒绝', () => {
    const v = verifyAdmission({ name: '安琪', type: 'person', evidence: '她说她叫安琪呀' }, MSG);
    expect(v.admitted).toBe(false);
    expect(v.rejectReason).toBe('evidence_not_in_message');
  });

  it('名字不在证据里 → 拒绝', () => {
    const v = verifyAdmission({ name: '安琪', type: 'person', evidence: '是我以前的同事' }, MSG);
    expect(v.admitted).toBe(false);
    expect(v.rejectReason).toBe('name_not_in_evidence');
  });

  it('名字过短 / 过长 → 拒绝', () => {
    expect(verifyAdmission({ name: '琪', type: 'person', evidence: '她叫琪' }, '她叫琪').rejectReason).toBe('length');
    expect(verifyAdmission({ name: '一二三四五六七八九十一二三', type: 'person', evidence: 'x' }, 'x').rejectReason).toBe('length');
  });

  it('未知类型不入 person 通道（批量校验标记拒绝）', () => {
    const [v] = verifyAdmissions([{ name: '安琪', type: 'alien', evidence: '她叫安琪' }], MSG);
    expect(v.admitted).toBe(false);
  });
});

describe('EvidenceHeaderGate · 流式头剥离', () => {
  it('跨块到达的头不进输出，正文完整放行', () => {
    const g = new EvidenceHeaderGate();
    let out = '';
    out += g.push('entity: 安琪|person|她叫安');
    out += g.push('琪\n---\n好啊，');
    out += g.push('安琪。');
    out += g.flush();
    expect(out).toBe('好啊，安琪。');
  });

  it('无头消息原样放行（首行判定）', () => {
    const g = new EvidenceHeaderGate();
    let out = g.push('今天天气');
    out += g.push('不错。');
    out += g.flush();
    expect(out).toBe('今天天气不错。');
  });

  it('纯 JSON 不剥头（V45 失败安全）', () => {
    const g = new EvidenceHeaderGate();
    let out = g.push('{"a":');
    out += g.push('1}');
    out += g.flush();
    expect(out).toBe('{"a":1}');
  });

  it('头区出现非 entity 行且无分隔行 → 该行起按正文放行（不吞正文）', () => {
    const g = new EvidenceHeaderGate();
    let out = g.push('entity: 安琪|person|她叫安琪\n正文第一句');
    out += g.flush();
    expect(out).toBe('正文第一句');
  });
});

describe('协议指令', () => {
  it('包含必需字段与分隔行约定（单一副本）', () => {
    expect(ENTITY_EVIDENCE_INSTRUCTION).toContain('entity: 名称|类型|证据原文');
    expect(ENTITY_EVIDENCE_INSTRUCTION).toContain('---');
    expect(ENTITY_EVIDENCE_INSTRUCTION).toContain('不得改写');
  });
});
