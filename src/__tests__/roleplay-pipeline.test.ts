/**
 * 角色扮演域管线集成测试（第一阶段）
 *
 * 覆盖：
 *   场景 1：用户有数据 → 就绪门通过
 *   场景 2：用户问年龄但无数据 → 就绪门注入约束
 *   场景 3：用户问不认识的人 → 就绪门注入反编造
 *   场景 4：普通聊天不涉及个人信息 → 就绪门通过（无约束）
 *
 * 运行：npx vitest run src/__tests__/roleplay-pipeline.test.ts
 */
import { describe, it, expect } from 'vitest';
import { classifyIntent } from '../app/roleplay/DataCollector.js';
import { checkReadiness } from '../app/roleplay/ReadinessGate.js';
import type { CollectedData } from '../app/roleplay/types.js';

function makeEmptyData(overrides?: Partial<CollectedData>): CollectedData {
  return {
    fg: { branch: null, treeText: '', rootProfile: null, familyMembers: [] },
    kb: [],
    history: [],
    portrait: null,
    context: {
      message: '', entities: [], kinshipTerms: [],
      pronounTarget: null, intent: 'chat',
    },
    knownFields: {
      hasAge: false, hasRelations: false, hasAppearance: false,
      hasOccupation: false, hasPersonality: false, askedPersonFound: false,
    },
    ...overrides,
  };
}

describe('角色扮演域管线', () => {
  // ── 意图分类 ──
  describe('意图分类', () => {
    it('问人意图', () => {
      expect(classifyIntent('她叫什么名字')).toBe('ask_person');
      expect(classifyIntent('他是谁')).toBe('ask_person');
    });
    it('问年龄意图', () => {
      expect(classifyIntent('你多大了')).toBe('ask_age');
      expect(classifyIntent('你几岁')).toBe('ask_age');
    });
    it('问背景意图', () => {
      expect(classifyIntent('说说你自己')).toBe('ask_background');
    });
    it('普通聊天', () => {
      expect(classifyIntent('今天天气真好')).toBe('chat');
    });
  });

  // ── 就绪门 ──
  describe('就绪门：问人', () => {
    it('有数据时通过', () => {
      const data = makeEmptyData({
        context: { message: '她叫什么', entities: ['徐诗雨'], kinshipTerms: [], pronounTarget: '徐诗雨', intent: 'ask_person' },
        knownFields: { ...makeEmptyData().knownFields, askedPersonFound: true },
      });
      const d = checkReadiness(data);
      expect(d.canAnswer).toBe(true);
      expect(d.antiFabricationGuard).toBe('');
    });

    it('无数据时注入反编造', () => {
      const data = makeEmptyData({
        context: { message: '她叫什么', entities: [], kinshipTerms: [], pronounTarget: null, intent: 'ask_person' },
        knownFields: { ...makeEmptyData().knownFields, askedPersonFound: false },
      });
      const d = checkReadiness(data);
      expect(d.canAnswer).toBe(false);
      expect(d.antiFabricationGuard).toContain('反编造铁律');
    });
  });

  describe('就绪门：问年龄', () => {
    it('有年龄时通过', () => {
      const data = makeEmptyData({
        context: { message: '你多大了', entities: [], kinshipTerms: [], pronounTarget: null, intent: 'ask_age' },
        knownFields: { ...makeEmptyData().knownFields, hasAge: true },
      });
      const d = checkReadiness(data);
      expect(d.canAnswer).toBe(true);
    });

    it('无年龄时注入约束', () => {
      const data = makeEmptyData({
        context: { message: '你多大了', entities: [], kinshipTerms: [], pronounTarget: null, intent: 'ask_age' },
        knownFields: { ...makeEmptyData().knownFields, hasAge: false },
      });
      const d = checkReadiness(data);
      expect(d.canAnswer).toBe(false);
      expect(d.antiFabricationGuard).toContain('反编造铁律');
    });
  });

  describe('就绪门：普通聊天', () => {
    it('无约束', () => {
      const data = makeEmptyData({
        context: { message: '今天天气真好', entities: [], kinshipTerms: [], pronounTarget: null, intent: 'chat' },
      });
      const d = checkReadiness(data);
      expect(d.canAnswer).toBe(true);
      expect(d.antiFabricationGuard).toBe('');
    });
  });
});
