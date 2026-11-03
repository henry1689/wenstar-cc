/**
 * recall-structure-guard.test.ts — 记忆召回结构化改善守卫（2026-10-18，业主批准）
 * ============================================================
 * 被守的缺陷（阿珍压测实锤 2026-10-18）：
 *   问"还记得我俩的第一次吗"→ 她只敢说日期，细节要用户提示"诗雨"才说出、
 *   要用户确认"你说得对"才敢继续。三层根因：
 *   ① exit 正则 `下了$` 无位置约束 ⇒ "我已经在楼下了"被判退出、会晤强制转场玉瑶
 *      （压测 seq=11970 后半段对话全部错归玉瑶）；
 *   ② PrivacyFilter 文字判据（UUID 权威机制的前朝兜底）把当前实体自己的
 *      三人场景记忆当"他人私密"误杀（实测一次杀 11 条：36→25）；
 *   ③ 回忆问句兜底取"最早 6 条"（时间轴头），事件在中段 ⇒ 事件锚点结构性缺席。
 *
 * 修复（全部是判据/权威层的结构修正，非词表补丁）：
 *   ①' exit「下了」语法位置规则：退出动词（子句首位/主语情态毗邻）vs 结果补语（附着前字）；
 *   ②' 文字隐私判据退役：权威=UUID 隔离（查询侧 belong_entity_uuid 收敛 + filterPrivateConversations）；
 *   ③' 第四召回通道 anchorRecallByKeywords（真源 meeting-recall.ts，两处同源接线）；
 *   ④' 自信回忆铁律（记忆内直说不求确认 / 记忆外不编）。
 *
 * 本测试锁定：S1 exit 位置判据行为；S2 锚点通道行为与接线；S3 文字判据退役且上游全 UUID 收敛；
 *   S4 自信回忆铁律存在且与回忆≠编造成对。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EntityMeeting } from '../../../m4/household/EntityMeeting.js';
import { anchorRecallByKeywords, RECALL_TRIGGER_RE } from '../../../m4/retrieval/meeting-recall.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

// ─── S1: exit 语法位置判据 ────────────────────────────
describe('S1 — exit「下了」语法位置判据（结构规则，非词表）', () => {
  const names = ['阿珍', '徐诗雨', '熊梓铭'];

  it('附着式「X下了」（结果补语）不得判退出 —— 压测 seq=11970 精确反转', () => {
    for (const m of ['好了，妈，我已经在楼下了', '我先去睡下了', '洗完澡下了', '他刚躺下了']) {
      expect(EntityMeeting.detectIntent(m, names, true).kind).not.toBe('exit');
    }
  });

  it('独立动词「下/下了/下线」（子句首位或主语/情态毗邻）仍判退出', () => {
    for (const m of ['我先下了', '我得下了', '我这就下线了', '下了', '就得下了']) {
      expect(EntityMeeting.detectIntent(m, names, true).kind).toBe('exit');
    }
  });

  it('既有退出词不受影响（拜拜/先这样/聊到这）', () => {
    for (const m of ['拜拜', '今天先这样吧', '就聊到这，下次再聊', '散会']) {
      expect(EntityMeeting.detectIntent(m, names, true).kind).toBe('exit');
    }
  });

  it('正常对话不误判（压测语料）', () => {
    for (const m of ['对的，接着说', '很对，继续说', '那天晚上不是诗雨还帮了你的，不记得吗']) {
      expect(EntityMeeting.detectIntent(m, names, true).kind).not.toBe('exit');
    }
  });
});

// ─── S2: 锚点事件召回通道 ────────────────────────────
describe('S2 — anchorRecallByKeywords 第四召回通道', () => {
  /** 桩数据源：模拟 memories 表（含 ANCHOR 与普通行） */
  const rows = [
    { id: '000207M01FAMC_DG_11910_ANCHOR', raw_input: '【核心】用户: 还记得我俩的第一次吗 阿珍: 十月十五号...', calcium_score: 0.2, effective_strength: 1, created_at: '2026-10-18T03:21:00Z', perception_40d: 'x' },
    { id: '000383M01EMOP_DG_11134_ANCHOR', raw_input: '【核心·阿珍】鸿艺：第一次，还是得感谢诗雨，有她的陪伴和安慰', calcium_score: 0.4, effective_strength: 1, created_at: '2026-10-16T11:53:00Z', perception_40d: 'x' },
    { id: '000451M01EMOP_DG_11140_ANCHOR', raw_input: '【核心·阿珍】鸿艺：昨晚是第一次，更多的是紧张和初次的疼痛', calcium_score: 0.86, effective_strength: 1, created_at: '2026-10-16T14:31:00Z', perception_40d: 'x' },
    { id: 'mem_mvcsa21g_rep7w7', raw_input: '……第一次啊。阿珍记得那是十月十五号', calcium_score: 0.2, effective_strength: 1, created_at: '2026-10-18T03:21:00Z', perception_40d: 'x' },
  ];
  const src = {
    queryAll: (sql: string, params: unknown[]) => {
      // 能力断言：锚点通道必须限定 ANCHOR 行（ESCAPE 转义防 _ 通配符）且带 UUID
      expect(sql).toContain("id LIKE '%\\_ANCHOR' ESCAPE '\\'");
      expect(sql).toContain('belong_entity_uuid = ?');
      const kw = String(params[1] as string).replace(/%/g, '');
      return rows.filter((r) => r.id.endsWith('_ANCHOR') && r.raw_input.includes(kw));
    },
  };

  it('按问句关键词直取事件锚点（含中段事件，不看钙化/时间片）', () => {
    const hits = anchorRecallByKeywords(src as any, 'TXS-A', ['第一次', '诗雨'], 4);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.some((h: { id: string }) => h.id === '000383M01EMOP_DG_11134_ANCHOR')).toBe(true); // 诗雨锚点
    expect(hits.every((h: { id: string }) => h.id.endsWith('_ANCHOR'))).toBe(true); // 只取锚点
  });

  it('无关键词/无命中 ⇒ 空数组（不阻塞主流程）', () => {
    expect(anchorRecallByKeywords(src as any, 'TXS-A', [], 4)).toEqual([]);
    expect(anchorRecallByKeywords(src as any, 'TXS-A', ['量子力学'], 4)).toEqual([]);
  });

  it('回忆触发判据含压测问句（RECALL_TRIGGER_RE 与通道同源触发）', () => {
    expect(RECALL_TRIGGER_RE.test('妈，还记得我俩的第一次吗')).toBe(true);
  });
});

// ─── S3/S4: 源码级结构断言（防回退）──────────────────
describe('S3/S4 — 隐私权威与自信回忆铁律（能力断言）', () => {
  const retrievalSrc = readFileSync(join(REPO, 'src', 'webui', 'chat', 'retrieval-stage.ts'), 'utf8');
  const chatSrc = readFileSync(join(REPO, 'src', 'webui', 'chat.ts'), 'utf8');
  const ecbSrc = readFileSync(join(REPO, 'src', 'm4', 'household', 'EntityContextBuilder.ts'), 'utf8');
  const wallSrc = readFileSync(join(REPO, 'src', 'm4', 'retrieval', 'adapters', 'MeetingWallAdapter.ts'), 'utf8');

  it('S3: 会晤检索路径的文字隐私判据必须退役（isIntimateAboutOthers 不再被调用，注释除外）', () => {
    // 断言"无调用"而非"无提及"——退役注释本身会提到该函数名（防误报）
    expect(retrievalSrc).not.toMatch(/isIntimateAboutOthers\(/);
    // 权威隐私闸门仍在（filterPrivateConversations 消费方在 chat.ts）
    expect(chatSrc).toMatch(/filterPrivateConversations\(/);
  });

  it('S3: 退役注释必须声明权威=UUID（防好心人凭感觉复活文字层）', () => {
    expect(retrievalSrc).toMatch(/隐私判据结构退役/);
    expect(retrievalSrc).toMatch(/权威实现是 UUID 隔离/);
  });

  it('S4: 自信回忆铁律必须存在且与「回忆≠编造」成对（边界不可偏废）', () => {
    expect(ecbSrc).toMatch(/entity_confident_recall/);
    expect(ecbSrc).toMatch(/自信回忆·铁律/);
    expect(ecbSrc).toMatch(/记忆里\*\*没有\*\*的 → 不编/); // 底线成对声明
    // 既有铁律不得被挤掉
    expect(ecbSrc).toMatch(/entity_recall_not_fabrication/);
    expect(ecbSrc).toMatch(/entity_past_boundary/);
  });

  it('S2 接线: 锚点通道在隔离墙（retrieval-stage）与 MeetingWallAdapter 之外的主路径已接入', () => {
    expect(retrievalSrc).toMatch(/anchorRecallByKeywords\(_sqlite, _entityUuid/);
    // MeetingWallAdapter 保持与隔离墙同源的三通道（近期/历史/关键词）——锚点通道接线为可选增强，
    // 此处只断言其召回仍走共享真源（防再次内联分叉）
    expect(wallSrc).toMatch(/from '\.\.\/meeting-recall\.js'/);
  });

  it('S5: 锚点通道时间分层双端取数（近端沉淀窗后 DESC×2 + 远端 ASC×2 原始事件），总量仍由 limit 封顶', () => {
    const mrSrc = readFileSync(join(REPO, 'src', 'm4', 'retrieval', 'meeting-recall.ts'), 'utf8');
    const fnStart = mrSrc.indexOf('export function anchorRecallByKeywords');
    const fnNext = mrSrc.indexOf('\nexport ', fnStart + 10);
    const fnBody = mrSrc.substring(fnStart, fnNext > 0 ? fnNext : fnStart + 2500);
    // 近端：沉淀窗排除当前对话回声 + DESC×2
    expect(fnBody).toMatch(/julianday\('now'\) - julianday\(created_at\) > \?/);
    expect(fnBody).toMatch(/created_at DESC LIMIT 2/);
    // 远端：原始事件记录（时间轴最老端）
    expect(fnBody).toMatch(/created_at ASC LIMIT 2/);
    // 总量封顶 + 去重短路仍在
    expect(fnBody).toMatch(/if \(out\.length >= limit\) break;/);
    // 钙化序必须不在本通道（事件通道职责=覆盖，排序归钙化槽）——防回退
    expect(fnBody).not.toMatch(/calcium_score DESC/);
  });

  it('S6: 时间注入必须是环境元数据定性（非对话内容/禁复述）——core-rules/会晤路径/chat.ts 三处成对', () => {
    const crSrc = readFileSync(join(REPO, 'src', 'm5', 'prompts', 'core-rules.ts'), 'utf8');
    // 轮4根治：陈述句（现在是X）→ 元数据字段（元数据≠素材，禁复述）+ 正面替代（当下问句可答/过去从记忆答）
    //   轮3实锤：负面禁令敌不过"现在是X"陈述句的模式匹配（问什么时候开始叫妈 → 答手机时间）
    expect(crSrc).toMatch(/非对话内容，禁复述此行/);
    // 会晤路径（EntityContextBuilder）同源定性（轮4报时实际发生路径）
    expect(ecbSrc).toMatch(/非对话内容，禁复述/);
    expect(ecbSrc).toMatch(/问\*\*过去\*\*的日期\/时间/);
    // chat.ts timeGuard 第三处同源
    expect(chatSrc).toMatch(/环境数据·当前时间（非对话内容，禁复述）/);
  });

  it('S7: 时间轴兑底必须用真时间序且排除锚点行（锚点 seq 为负，seq ASC = 本轮讨论回声）', () => {
    const mrSrc = readFileSync(join(REPO, 'src', 'm4', 'retrieval', 'meeting-recall.ts'), 'utf8');
    // 真源函数：created_at ASC + seq_pos > 0（排除负 seq 锚点）
    expect(mrSrc).toMatch(/export function earliestMemoriesByTime/);
    const fnStart = mrSrc.indexOf('export function earliestMemoriesByTime');
    const fnBody = mrSrc.substring(fnStart, fnStart + 800);
    expect(fnBody).toMatch(/seq_pos > 0/);
    expect(fnBody).toMatch(/created_at ASC LIMIT \?/);
    // 两处调用方必须收编到真源（不得再内联 seq_pos ASC）
    expect(retrievalSrc).toMatch(/earliestMemoriesByTime\(_sqlite, _entityUuid, 6\)/);
    expect(wallSrc).toMatch(/earliestMemoriesByTime\(this\.source, entityUuids\[0\], 6\)/);
    expect(retrievalSrc).not.toMatch(/ORDER BY seq_pos ASC LIMIT 6/);
    expect(wallSrc).not.toMatch(/ORDER BY seq_pos ASC LIMIT 6/);
  });

  it('S8: 记忆注入必须携带时间坐标（数据层时间 100% 在库，注入层不得再剥除）——T003扩容', () => {
    // 单源格式化函数存在：当年 `·MM-DD`，跨年 `·YYYY-MM-DD`，无时间回退旧标签
    expect(retrievalSrc).toMatch(/function memFragWithTime\(label: string, body: string, createdAt/);
    // 主通道（近期/历史/锚点/最早槽汇流）必须接时间标注
    expect(retrievalSrc).toMatch(/memFragWithTime\(_meetingEntityName \+ '的记忆', _t, _em\.created_at\)/);
    // 砂金重要记忆 SQL 必须带出 created_at（否则该通道无时间可用）
    expect(retrievalSrc).toMatch(/SELECT raw_input, calcium_level, created_at FROM memories WHERE belong_entity_uuid = \? AND calcium_level >= 2/);
    // 金库通道接线
    expect(retrievalSrc).toMatch(/memFragWithTime\('金库记忆', _t, _gr\.created_at\)/);
    // fail-open：无时间回退旧标签（防坏数据阻塞注入）
    expect(retrievalSrc).toMatch(/if \(!d \|\| isNaN\(d\.getTime\(\)\)\) return `【\$\{label\}】\$\{body\}`/);
  });

  it('S8: 未接时间坐标的注入点必须只剩带内生时间语义的（时间检索/长文/作品/回忆三档/默契元素）', () => {
    // 【时间检索】自带"昨天/上周"语义；【对话原文】【作品】是长内容（时间坐标价值低、预算敏感）；
    // 【回忆表达三档】是指令非记忆（正向表达权指引，业主2026-11-01法理升级；旧"反编造铁律"正向化后标记变更）。
    // 【默契元素 · MemSym】🔴 2026-11-03 补收（批6）：其注入文案自身已明令「无需回忆前缀；
    //   不得复述为往事事件，**不得新增细节/时间/地点**」—— 是「非往事叙事、可溯源」的**当下氛围素材**，
    //   不是记忆类。给它套 memFragWithTime 加时间坐标会**直接违反其自身定义**，
    //   且与 S8 的立法意图（**记忆类**才需时间坐标）相悖；与已收的【回忆表达三档】同类。
    // 其余记忆类注入必须全部经 memFragWithTime。
    const legacyLabelPushes = retrievalSrc.match(/memoryFragments\.push\('【[^']*' \+/g) ?? [];
    //   【用户状态】chat.ts:1039 —— `somaticContext` 是**当下**躯体感知（该处注释原文
    //   「反映用户当前的身体/情绪状态」），非记忆、无时间坐标可言 ⇒ 收。
    //   🔴 2026-11-03（S4 独立评审 P1-B 类）：【深度回忆素材包 · MemSym】retrieval-stage:842
    //   **已从本允许清单移除** —— 原豁免理由（「SweptFragment 无时间字段」「CRYSTAL_DIRECTIVE
    //   已给替代防线」）经评审员读上游代码证伪：① sweepAllStores 三条 SQL 只 SELECT 文本，
    //   而数据层 created_at 100% 在库（SQL 自己就 ORDER BY created_at DESC），是**通道选择不取**；
    //   ② CRYSTAL_DIRECTIVE 只对顺序/精确度打印象标记，**不补时间坐标**，防不住「把素材放进
    //   错误的年月」；③ 该通道是**体量最大的记忆聚合**（跨砂金/金库黑钻/知识库三仓、无时间窗、
    //   maxFrags=12）。故改为根治：sweepAllStores 补取 created_at → organizeForQuestion 透传
    //   → retrieval-stage 经 memFragWithTime 输出（时间格式化保持单源）。
    // 允许的遗留（非记忆/带内生时间）：时间检索、对话原文、作品、回忆表达三档、
    //                      默契元素、用户状态、深度回忆素材包（**仅指指令性标题行**）
    // 🔴 2026-11-03 复核（S4 B类已根治后的口径澄清）：本正则抓的是
    //   `memoryFragments.push('【标签…` 的**标签字面量**，不是包内内容。
    //   深度回忆素材包的**内容**已逐条经 memFragWithTime 带时间坐标
    //   （retrieval-stage 改为 `_swept.map(s => memFragWithTime(s.source, s.content, s.createdAt))`，
    //   输出 `【砂金·10-15】content`，与金库通道同形态）；留在清单里的只是
    //   「【深度回忆素材包 · MemSym】以下是全部记忆仓…」这句**告诉 LLM 这是什么的指令前缀**，
    //   它本身不是记忆、无时间可言 —— 与已收的【回忆表达三档】【默契元素】同类。
    //   ⇒ S8 立法意图（记忆类必须带时间）**未被削弱**：内容层已强制，豁免的仅是指令行。
    // 🔴 收紧而非放松：正则形态、收集方式、逐条 match 全部不变 ⇒
    //   新出现的任何记忆类注入（无时间、且非指令行）仍会红。
    for (const m of legacyLabelPushes) {
      expect(m).toMatch(/时间检索|对话原文|作品|回忆表达三档|默契元素|用户状态|深度回忆素材包/);
    }
  });
});
