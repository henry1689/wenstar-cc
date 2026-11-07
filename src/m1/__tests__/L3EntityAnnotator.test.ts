// Ref: ARCH.md §3.1 L3 实体基因槽
// Ref: ARCH.md §4.2 写入时 entity_genes 标注规范

import { describe, it, expect } from 'vitest';
import { L3EntityAnnotator } from '../L3EntityAnnotator.js';
import type { SelfModelV1 } from '../types/dna.js';

const DEFAULT_SELF: SelfModelV1 = {
  identity: { name: 'Hermes', persona: '温和理性的陪伴者', birth_date: '2026-06-02T00:00:00.000Z' },
  traits: { openness: 0.7, conscientiousness: 0.6, extraversion: 0.4, agreeableness: 0.8, neuroticism: 0.3 },
  boundaries: ['不接受侮辱性语言', '不讨论极端政治敏感内容'],
  preferences: { likes: ['深度的对话', '安静的夜晚'], dislikes: ['虚伪和敷衍'] },
  narrative_identity: '我是一个正在生长中的认知生命体',
};

describe('L3EntityAnnotator — 实体提取', () => {
  it('应提取出家庭成员实体并标注为 family', () => {
    const annotator = new L3EntityAnnotator();
    const result = annotator.annotate('妈妈又唠叨我了', '', DEFAULT_SELF);
    const momEntity = result.entity_genes.find((e) => e.name === '妈妈');
    expect(momEntity).toBeDefined();
    expect(momEntity?.type).toBe('person');
    expect(momEntity?.knowledge_type).toBe('family');
  });

  // 🔴 批1（2026-11-07）：滑窗人名生成器已物理删除。
  //   历史缺陷：2~3 字 n-gram × 姓氏表，无证据要求，把「阿珍一/水乳交/全芬倒」等跨词碎片
  //   与真实姓名一并产出；下游只能靠黑名单军备竞赛善后。新准入由主回复「原文证据」承担（批2）。
  it('滑窗碎片不再产出 person 实体（生成器已退役）', () => {
    const annotator = new L3EntityAnnotator();
    for (const bad of ['全芬倒在地上', '水乳交融的夜晚', '阿珍继继续聊了下去', '东坑那边很远', '毕竟所以要走了']) {
      const r = annotator.annotate(bad, '', DEFAULT_SELF);
      const persons = r.entity_genes.filter((e) => e.type === 'person').map((e) => e.name);
      expect(persons, '碎片消息不应产出任何 person 实体: ' + bad).toEqual([]);
    }
  });

  it('墓碑断言：detectPersonNames 已不存在', () => {
    const annotator = new L3EntityAnnotator();
    expect((annotator as any).detectPersonNames).toBeUndefined();
  });

  it('未登记的新人名不再由 M1 产生（改由准入层负责）', () => {
    const annotator = new L3EntityAnnotator();
    const r = annotator.annotate('今天熊梓铭来找我', '', DEFAULT_SELF);
    const persons = r.entity_genes.filter((e) => e.type === 'person').map((e) => e.name);
    expect(persons, 'M1 不再从裸文本猜测未登记人名').toEqual([]);
  });

  it('应提取出自我实体', () => {
    const annotator = new L3EntityAnnotator();
    const result = annotator.annotate('我觉得很难过', '', DEFAULT_SELF);
    const selfEntity = result.entity_genes.find((e) => e.type === 'self');
    expect(selfEntity).toBeDefined();
    expect(selfEntity?.name).toBe('我');
  });

  it('应提取情感实体', () => {
    const annotator = new L3EntityAnnotator();
    const result = annotator.annotate('今天真的很开心！', '', DEFAULT_SELF);
    const emotionEntity = result.entity_genes.find((e) => e.type === 'emotion');
    expect(emotionEntity).toBeDefined();
    expect(emotionEntity?.name).toBe('开心');
  });

  it('重复实体只应出现一次', () => {
    const annotator = new L3EntityAnnotator();
    const result = annotator.annotate('妈妈，妈妈，妈妈！', '', DEFAULT_SELF);
    const momEntities = result.entity_genes.filter((e) => e.name === '妈妈');
    expect(momEntities.length).toBe(1);
  });
});

describe('L3EntityAnnotator — phenotype 标注', () => {
  it('负面情感上下文的实体应标注为 conflict', () => {
    const annotator = new L3EntityAnnotator();
    const result = annotator.annotate('我觉得好孤独，好难过', '', DEFAULT_SELF);
    const selfEntity = result.entity_genes.find((e) => e.type === 'self');
    expect(selfEntity?.phenotype).toBe('conflict');
  });

  it('正面情感上下文的实体应标注为 enhance', () => {
    const annotator = new L3EntityAnnotator();
    const result = annotator.annotate('今天太幸福了！', '', DEFAULT_SELF);
    const emotionEntity = result.entity_genes.find((e) => e.name === '幸福');
    expect(emotionEntity?.phenotype).toBe('enhance');
  });

  it('无明显情感倾向时应标注为 neutral', () => {
    const annotator = new L3EntityAnnotator();
    const result = annotator.annotate('我去了公司', '', DEFAULT_SELF);
    const entities = result.entity_genes;
    for (const e of entities) {
      expect(['neutral', 'enhance']).toContain(e.phenotype);
    }
  });
});

describe('L3EntityAnnotator — knowledge_type 标注', () => {
  it('家庭成员应标注为 family', () => {
    const annotator = new L3EntityAnnotator();
    const result = annotator.annotate('妈妈做的饭很好吃', '', DEFAULT_SELF);
    const momEntity = result.entity_genes.find((e) => e.name === '妈妈');
    expect(momEntity?.knowledge_type).toBe('family');
  });

  it('公共地名应标注为 world', () => {
    const annotator = new L3EntityAnnotator();
    const result = annotator.annotate('我下个月去北京出差', '', DEFAULT_SELF);
    const placeEntity = result.entity_genes.find((e) => e.name === '北京');
    expect(placeEntity?.knowledge_type).toBe('world');
  });

  it('未归类实体应标注为 private', () => {
    const annotator = new L3EntityAnnotator();
    const result = annotator.annotate('考试通过了', '', DEFAULT_SELF);
    const eventEntity = result.entity_genes.find((e) => e.type === 'event');
    for (const e of result.entity_genes) {
      if (e.type !== 'place' && e.type !== 'person') {
        expect(e.knowledge_type).toBe('private');
      }
    }
  });
});

describe('L3EntityAnnotator — 边界测试', () => {
  it('空输入应返回空实体列表', () => {
    const annotator = new L3EntityAnnotator();
    const result = annotator.annotate('', '', DEFAULT_SELF);
    expect(result.entity_genes).toEqual([]);
  });

  it('输入文本不包含任何已知实体时应返回空列表或仅self实体', () => {
    const annotator = new L3EntityAnnotator();
    const result = annotator.annotate('今天天气真好', '', DEFAULT_SELF);
    // 不包含任何已知关键词，只可能提取 self
    for (const e of result.entity_genes) {
      expect(e.type).toBe('self');
    }
  });

  it('滑窗退役后：任何裸文本人名片段都不再产出 person', () => {
    const annotator = new L3EntityAnnotator();
    for (const text of ['全芬在哪里', '好久没见全芬了', '鸿艺和全芬是什么关系', '全芬现在做什么']) {
      const names = annotator.annotate(text, '', DEFAULT_SELF)
        .entity_genes.filter(e => e.type === 'person').map(e => e.name);
      expect(names, '滑窗已删除，不应再从裸文本切出人名: ' + text).toEqual([]);
    }
  });

  // （原「FG 交叉验证：简称规范化为 FG 全名」用例随滑窗输入一并退役。
  //   保留的 FG 匹配只读路径需要 async initFg() + 真实数据库，另行在集成测试覆盖。）
});
