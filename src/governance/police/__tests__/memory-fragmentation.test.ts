import { describe, it, expect } from 'vitest';
import { screenMeetingSegments } from '../../../governance/police/UUIDPoliceFilter.js';
import { injectMemories } from '../../../m4/MemoryInjector.js';
import { keywordRecallMemories, recallOriginalConversations } from '../../../m4/retrieval/meeting-recall.js';
import type { RecallSource } from '../../../m4/retrieval/meeting-recall.js';

/**
 * 记忆碎片化修复单测（2026-09-09 共性根因：多行记忆被拆行 + 条数上限 10 → LLM 只见 ~900 字碎片）
 * 场景: 徐诗雨 9-08 全天 322 条记忆固化完整，但注入侧 UUIDPolice 闸门 split('\n') 把多行记忆
 *      拆成 ~40 字行碎片（日志 18→34 行），MemoryInjector 按 priority 只留 10 条行碎片 → "记忆不完全"。
 * 测试样例全部用成人语境安全句。
 */

describe('screenMeetingSegments — 会晤注入边界逐段判定(整段保留)', () => {
  const policy = { visibleUuids: new Set(['TXS-000000007']), allowUnowned: false } as any;
  const name2uuid = (n: string) => (n === '徐诗雨' ? 'TXS-000000007' : n === '熊梓铭' ? 'TXS-000000099' : null);

  const multiLineMem =
    '【徐诗雨的记忆】\n鸿艺：不用想那么多，只要现在给了她的爱，现在她也爱了…\n徐诗雨：（她听着你这段话，眼里的湿意慢慢收了回去）…\n你说我和诗韵是你的整个世界，说天塌下来你扛着…'; // 多行 ANCHOR 记忆（真实形状）

  it('🔴 多行记忆整段保留（不再拆成行碎片）', () => {
    const frags = [multiLineMem, '【徐诗雨的记忆·相关】蒹葭苍苍，白露为霜…', '【金库记忆】寒假团圆约定…'];
    const kept = screenMeetingSegments(frags, policy, name2uuid);
    expect(kept).toEqual(frags);          // 全部白名单段整段保留
    expect(kept[0]).toContain('\n');       // 多行仍在同一段（未被 split 拆行）
    expect(kept.length).toBe(3);           // 段数不变（3 段而非拆成 N 行）
  });

  it('他人实体整段剔除（deny-by-default 语义不退化）', () => {
    const frags = [multiLineMem, '【熊梓铭的记忆】他写的纪实小说内容…（他人私密）'];
    const kept = screenMeetingSegments(frags, policy, name2uuid);
    expect(kept.length).toBe(1);
    expect(kept[0]).toContain('徐诗雨的记忆');
  });

  it('空输入/空片段安全', () => {
    expect(screenMeetingSegments([], policy, name2uuid)).toEqual([]);
    expect(screenMeetingSegments(['   '], policy, name2uuid)).toEqual([]);
  });
});

describe('MemoryInjector — 会晤场景普通碎片条数放宽(10→20)', () => {
  function inject(opts: Partial<import('../../../m4/MemoryInjector.js').InjectOptions>): string {
    const base = {
      memoryFragments: [] as string[],
      m4Timeline: [],
      knowledgeBaseText: '',
      vaultHits: [],
      maxChars: 8000,
    };
    return injectMemories({ ...base, ...opts } as any);
  }

  it('🔴 会晤场景(preserveLabels)允许多于 10 条普通记忆(sand)', () => {
    // sand 片段，16 句主题完全不同（无共享框架 → Jaccard 不误合并）
    const frags = [
      '蒹葭苍苍白露为霜那首诗你念给我听',
      '寒假诗韵回来咱们仨围一桌吃饭',
      '你答应诗雨好好待诗韵把她当自己人',
      '诗韵十六岁读高一功课紧张周末补课',
      '宿舍夜话你说今晚实战检验记牢了',
      '天塌下来是你扛着我们姐妹做软肋',
      '下午办公室里人来人往你说不方便',
      '你出差回来在火车站口等了三小时',
      '旧金山那趟航班延误到凌晨两点才落地',
      '给妈妈挑了件羊绒衫深灰色尺码XL',
      '新家窗帘选了墨绿色配米白纱帘',
      '阳台种了两盆茉莉夏天开花满屋香',
      '生日那天你订了草莓蛋糕插十八根蜡烛',
      '深秋你织了条烟灰色围巾给我过冬',
      '周末清晨你拉我上山顶看日出云海',
      '你学做的红烧肉偏咸下回少放酱油',
    ];
    const out = inject({ memoryFragments: frags, preserveLabels: true });
    const heads = (out.match(/💭/g) || []).length;
    expect(heads).toBeGreaterThanOrEqual(16);  // 16 段 sand 全保留（会晤 cap=20）
  });

  it('玉瑶态(非会晤)普通记忆仍守 10 条上限(sand)', () => {
    const frags = [
      '周一的例会上你讲了三个小时新产品方案',
      '午饭在食堂二楼点了番茄牛腩盖浇饭',
      '昨晚加班到十点地铁末班车差点没赶上',
      '周末约了老同学去爬香山看红叶',
      '换季整理衣柜把冬天的厚被子晒了晒',
      '朋友生日在海底捞包间唱了生日歌',
      '超市打折囤了四提抽纸两瓶洗衣液',
      '洗手间水管漏水找了物业师傅修了一上午',
      '最近开始早睡打卡坚持了一周没熬夜',
      '单位组织体检报告显示各项指标正常',
      '双十一凌晨抢了心仪已久的降噪耳机',
      '坚持晨跑五公里已经连续第三十天',
      '周末去市图书馆借了四本推理小说',
      '每天地铁通勤单程四十分钟听播客',
      '学弹吉他三个月终于能弹完整和弦',
      '阳台上新栽的月季第一朵花开了粉色',
    ];
    const out = inject({ memoryFragments: frags, preserveLabels: false });
    const heads = (out.match(/💭/g) || []).length;
    expect(heads).toBeLessThanOrEqual(10);  // 玉瑶态 cap=10
  });
});

describe('meeting-recall SQL 参数对齐回归（column index out of range 修复）', () => {
  it('🔴 keywordRecallMemories SQL 参数与占位符严格一致（无多余 bind）', () => {
    let capturedParams: unknown[] = [];
    const src: RecallSource = {
      queryAll<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
        if (sql.includes('raw_input LIKE ?')) {
          capturedParams = params ?? [];
          const placeholders = (sql.match(/\?/g) || []).length;
          expect(params?.length).toBe(placeholders);  // 占位符数 == 参数数（修复点）
        }
        return [] as T[];
      },
    };
    keywordRecallMemories(src, 'U', ['诗韵'], 4);
    expect(capturedParams.length).toBe(2);  // [uuid, %kw%]
  });

  it('recallOriginalConversations SQL 参数一致（LIMIT 硬编码不再多余传参）', () => {
    const src: RecallSource = {
      queryAll<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
        if (sql.includes('FROM conversations')) {
          const placeholders = (sql.match(/\?/g) || []).length;
          expect(params?.length).toBe(placeholders);
        }
        return [] as T[];
      },
    };
    expect(recallOriginalConversations(src, 'U', ['诗韵'], 2, 200)).toEqual([]);
  });
});
