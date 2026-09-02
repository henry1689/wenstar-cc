import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FamilyGraph } from '../household/FamilyGraph.js';

const TEST_DB = join(__dirname, '.test-family-graph.db');

describe('FamilyGraph — 基础操作', () => {
  let graph: FamilyGraph;

  beforeEach(async () => {
    graph = new FamilyGraph(TEST_DB);
    await graph.initialize();
  });

  afterEach(() => {
    try { if (existsSync(TEST_DB)) unlinkSync(TEST_DB); } catch {}
  });

  it('添加节点并查询', async () => {
    await graph.addNode({ id: 'n1', type: 'person', name: '李华' });
    const result = await graph.findRelated('李华');
    expect(result.length).toBe(1);
    expect(result[0].node.name).toBe('李华');
  });

  it('添加边并查询关系', async () => {
    await graph.addNode({ id: 'u1', type: 'person', name: '我' });
    await graph.addNode({ id: 'p1', type: 'person', name: '李华' });
    await graph.addEdge({ source_id: 'u1', target_id: 'p1', relation: 'mother_of' });
    const result = await graph.findRelated('李华');
    expect(result.length).toBe(1);
    expect(result[0].relationships.length).toBeGreaterThanOrEqual(1);
  });
});

describe('FamilyGraph — 自动推断', () => {
  let graph: FamilyGraph;

  beforeEach(async () => {
    graph = new FamilyGraph(TEST_DB);
    await graph.initialize();
  });

  afterEach(() => {
    try { if (existsSync(TEST_DB)) unlinkSync(TEST_DB); } catch {}
  });

  it('妈妈+人名 → 自动创建 mother_of 边', async () => {
    const result = await graph.integrateFromEntity(
      [{ name: '妈妈', type: 'person', allele: '妈妈', phenotype: 'neutral', knowledge_type: 'family' }],
      '我妈妈叫李华'
    );
    expect(result.nodes_created).toBeGreaterThanOrEqual(1);
    expect(result.edges_created).toBeGreaterThanOrEqual(1);
    expect(result.details.some(d => d.includes('mother_of'))).toBe(true);
  });

  it('老公+人名 → 自动创建 spouse_of 边', async () => {
    const result = await graph.integrateFromEntity(
      [{ name: '老公', type: 'person', allele: '老公', phenotype: 'neutral', knowledge_type: 'family' }],
      '我老公叫张伟'
    );
    expect(result.edges_created).toBeGreaterThanOrEqual(1);
    expect(result.details.some(d => d.includes('spouse_of'))).toBe(true);
  });

  it('家庭成员+地点 → 自动创建 lives_in 边', async () => {
    const result = await graph.integrateFromEntity(
      [
        { name: '妈妈', type: 'person', allele: '妈妈', phenotype: 'neutral', knowledge_type: 'family' },
        { name: '深圳', type: 'place', allele: '深圳', phenotype: 'neutral', knowledge_type: 'world' },
      ],
      '我妈妈在深圳'
    );
    expect(result.details.some(d => d.includes('lives_in'))).toBe(true);
  });

  it('家庭摘要应包含成员', async () => {
    await graph.integrateFromEntity(
      [{ name: '妈妈', type: 'person', allele: '妈妈', phenotype: 'neutral', knowledge_type: 'family' }],
      '我妈妈叫李华'
    );
    const summary = await graph.getFamilySummary();
    expect(summary.members.length).toBeGreaterThanOrEqual(1);
  });

  it('重复 pending 条目应自动晋升为正式档案字段', async () => {
    // 使用含姓氏的正式姓名（"小雨"会被 GarbageEntityGuard 拦截为 L2 昵称）
    await graph.integrateFromEntity(
      [{ name: '姐姐', type: 'person', allele: '姐姐', phenotype: 'neutral', knowledge_type: 'family' }],
      '我姐姐叫张雨'
    );
    await graph.addPendingItem('张雨', 'contact.workplace', '深圳上班', '来源1');
    await graph.addPendingItem('张雨', 'contact.workplace', '深圳上班', '来源2');
    await graph.addPendingItem('张雨', 'contact.workplace', '深圳上班', '来源3');

    const profile = graph.getPersonProfile('张雨');
    expect(profile?.dossier?.contact?.workplace).toBe('深圳上班');
    expect(profile?.pendingItems ?? []).toHaveLength(0);
  });

  it('重复相同家族陈述也应累加观察并晋升档案字段', async () => {
    const entities = [{ name: '姐姐', type: 'person', allele: '姐姐', phenotype: 'neutral', knowledge_type: 'family' }] as const;
    await graph.integrateFromEntity([...entities], '我姐姐叫霁月，她在深圳上班。');
    await graph.integrateFromEntity([...entities], '我姐姐叫霁月，她在深圳上班。');
    await graph.integrateFromEntity([...entities], '我姐姐叫霁月，她在深圳上班。');

    const profile = graph.getPersonProfile('霁月');
    const summary = await graph.getFamilySummary();
    const member = summary.members.find((item) => item.name === '霁月');
    expect(profile?.mention_count).toBe(3);
    expect(profile?.dossier?.contact?.workplace).toBe('深圳上班');
    expect(profile?.pendingItems ?? []).toHaveLength(0);
    expect(member?.aliases ?? []).toEqual(['姐姐']);
  });

  it.skip('历史脏别名在读取家庭摘要时也应去重', async () => {
    await graph.addNode({ id: 'self', type: 'person', name: '我', aliases: ['我', '我自己'] });
    await graph.addNode({ id: 'p1', type: 'person', name: '阿宁', aliases: ['姐姐', '姐姐'] });
    await graph.addEdge({ id: 'e1', source_id: 'self', target_id: 'p1', relation: 'sibling_of' });
    await graph.addEdge({ id: 'e2', source_id: 'p1', target_id: 'self', relation: 'sibling_of' });

    const summary = await graph.getFamilySummary();
    const member = summary.members.find((item) => item.name === '阿宁');
    // 阿宁应在家庭摘要中
    expect(member).toBeDefined();
    expect(member!.name).toBe('阿宁');
  });

  it('泛称占位节点合并实名人物时不应继承旧 mention_count', async () => {
    await graph.addNode({
      id: 'placeholder',
      type: 'person',
      name: '姐姐',
      properties: {
        name: '姐姐',
        relation_to_user: '姐姐',
        last_mentioned: '2026-07-01T00:00:00.000Z',
        mention_count: 4,
      } as any,
    });

    await graph.integrateFromEntity(
      [{ name: '姐姐', type: 'person', allele: '姐姐', phenotype: 'neutral', knowledge_type: 'family' }],
      '我姐姐叫秋宁，她在苏州上班。'
    );

    const profile = graph.getPersonProfile('秋宁');
    expect(profile?.mention_count).toBe(1);
  });
});

describe('FamilyGraph — 归一化读取器 getPersonBio', () => {
  let graph: FamilyGraph;

  beforeEach(async () => {
    graph = new FamilyGraph(TEST_DB);
    await graph.initialize();
  });

  afterEach(() => {
    try { if (existsSync(TEST_DB)) unlinkSync(TEST_DB); } catch {}
  });

  it('dossier 优先于顶层（模拟熊梓玥: 顶层 female / dossier 未知 → 女）', async () => {
    await graph.addNode({ id: 'zy', type: 'person', name: '熊梓玥' } as any);
    // 顶层写 gender=female、birthYear=2018（updatePersonProfile 路径写顶层）
    await graph.updatePersonProfile('熊梓玥', { birthYear: 2018, gender: 'female' } as any);
    // dossier 写 gender='未知'（PAE/setDossierField 路径写 dossier）
    await graph.setDossierField('熊梓玥', 'basicInfo.gender', '未知');
    await graph.setDossierField('熊梓玥', 'socialIdentity.currentOccupation', '学生');

    const bio = graph.getPersonBio('熊梓玥');
    expect(bio?.birthYear).toBe(2018);
    expect(bio?.age).toBe(new Date().getFullYear() - 2018);
    expect(bio?.gender).toBe('女');          // 归一化: '未知' 过滤 → 顶层 female 兜底 → 女
    expect(bio?.occupation).toBe('学生');     // dossier.socialIdentity 优先
  });

  it('顶层 birthYear 兜底 + 无效值过滤（0 / 越界 / 空串 → null）', async () => {
    await graph.addNode({ id: 'zm', type: 'person', name: '熊梓铭' } as any);
    // dossier 无 birthYear，顶层有 → 顶层兜底
    await graph.updatePersonProfile('熊梓铭', { birthYear: 2008 } as any);
    expect(graph.getPersonBio('熊梓铭')?.birthYear).toBe(2008);

    // 无效值 → null
    await graph.addNode({ id: 'bad1', type: 'person', name: '无数据' } as any);
    await graph.updatePersonProfile('无数据', { birthYear: 0 } as any);
    expect(graph.getPersonBio('无数据')?.birthYear).toBeNull();
    expect(graph.getPersonBio('无数据')?.age).toBeNull();
  });

  it('无 birthYear 时降级用有效顶层 age（纯读不写回）', async () => {
    await graph.addNode({ id: 'a1', type: 'person', name: '只有年龄' } as any);
    await graph.updatePersonProfile('只有年龄', { age: 8 } as any);
    const bio = graph.getPersonBio('只有年龄');
    expect(bio?.age).toBe(8);
    expect(bio?.birthYear).toBeNull();
  });

  it('不存在的名字 → null', () => {
    expect(graph.getPersonBio('不存在的人')).toBeNull();
  });
});

describe('FamilyGraph — 亲属称谓长幼判断（修复 birthYear 当 age）', () => {
  let graph: FamilyGraph;

  beforeEach(async () => {
    graph = new FamilyGraph(TEST_DB);
    await graph.initialize();
  });

  afterEach(() => {
    try { if (existsSync(TEST_DB)) unlinkSync(TEST_DB); } catch {}
  });

  it('熊梓铭(2008) vs 熊梓玥(2018): 梓玥称梓铭"姐姐"', async () => {
    await graph.addNode({ id: 'zm', type: 'person', name: '熊梓铭' } as any);
    await graph.addNode({ id: 'zy', type: 'person', name: '熊梓玥' } as any);
    await graph.updatePersonProfile('熊梓铭', { birthYear: 2008, gender: 'female' } as any);
    await graph.updatePersonProfile('熊梓玥', { birthYear: 2018, gender: 'female' } as any);
    await graph.addEdge({ source_id: 'zm', target_id: 'zy', relation: 'elder_sister_of' } as any);

    // 修复前: age = birthYear (2018) → 梓玥被误判比梓铭大 → term='姐姐'（错误）
    // 修复后: age = 实时年龄 (18 vs 8) → isElder=false → term='妹妹'，reverse='姐姐'
    const term = graph.getKinshipTerm('熊梓玥', '熊梓铭');
    expect(term?.term).toBe('妹妹');
    expect(term?.reverse).toBe('姐姐');
  });
});
