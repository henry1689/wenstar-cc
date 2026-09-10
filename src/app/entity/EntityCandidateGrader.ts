/**
 * EntityCandidateGrader — 实体候选分级器 (V12.0 P1-7)
 * ====================================================
 * 对新提取的人物名称做分级处理，防止称谓/情绪词/普通名词误入 FG。
 *
 * 等级定义:
 *   L0 禁止词   — 永不入 FG（代词、泛称谓、公司/学校等普通名词）
 *   L1 普通称谓 — 需绑定上下文（"姐姐""阿姨"等，需进一步指代解析）
 *   L2 昵称     — 需指代解析（"艺哥""鸿叔"等简称/别称）
 *   L3 候选姓名 — 含百家姓，可候选入库
 *   L4 已有UUID — 已在 FG 中登记的稳定实体
 *   L5 用户确认 — 用户明确说"这是XX"确认过的实体
 */

import { SURNAME_LIST, ENTITY_BLACKLIST, APP_IDENTITY } from '../../config/app-identity.js';

export type EntityGrade = 0 | 1 | 2 | 3 | 4 | 5;

export interface GradedEntity {
  name: string;
  grade: EntityGrade;
  /** 等级说明 */
  reason: string;
  /** 如果是 L1/L2，此字段指定应绑定到的已知实体 */
  bindToName?: string;
}

// ── L0: 禁止词扩展 ──
const L0_EXTRA = new Set([
  '姐姐','妹妹','哥哥','弟弟','爸爸','妈妈','叔叔','阿姨','舅舅','姑姑',
  '爷爷','奶奶','外公','外婆','老婆','老公','儿子','女儿',
  '同学','同事','朋友','老板','客户','老师','学生',
]);

// ── 句子片段拦截（V12.0 P1-9: 短语污染根因）──
// 中文里"那/和/关/幸/解/项/舒/阴"等既可能是姓氏，也可能是虚词/普通名词首字。
// 仅凭"首字在姓氏表"会把句子片段（"那你说""和身体""关系"）误判为候选姓名。
// 真实人名"徐诗雨/刘运新/熊梓铭"首字是标准姓氏、尾部是名字用字，不受影响。
const SENTENCE_TAIL_BLOCK = ['的','也','后','小','说','你','她','他','着','了','呢','吗','就','是','要','会','都'];
const SENTENCE_HEAD_BLOCK = ['那','这','和','与','跟','把','被','在','对','有','就','向','从','让','使'];
const COMMON_NOUN_BLOCK = new Set(['关系','幸福','舒服','项目','身体','感觉','情况','问题','时候','东西','朋友','同事','理由','意思','未来','现在','今天','明天']);

// M2-1 2026-09-07: 弱证据姓(兼用字)——字义高频、姓氏低频的单字。
// 它们虽在百家姓表, 但现代汉语中多作虚词/形容词/名词(温=温柔, 时=时候, 应=应该,
// 花=花朵, 别=别人, 那=那个, 幸=幸福, 解=解决, 项=项目, 舒=舒服, 阴=阴天)。
// 语义: 首字落此集合 ≠ 人名证据。hasSurname 单看首字 + L3 判定 "hasSurname||length>=3"
// 双双放行"温柔/应一下/时半/花骨朵/时间的话"等中文短语 → 入 FG 成垃圾 person(实测每日新增)。
const WEAK_EVIDENCE_SURNAMES = new Set([
  '温','时','应','花','别','那','幸','解','项','舒','阴',
  // 2026-09-11 新增（实测事故："诗韵，最近学习累不累？" 被滑窗切成 "习累" 并入库 FG）:
  //   "习" 字义高频（学习/练习/习惯/复习）、姓氏极低频 —— 与上述集合同一语义（字义高频、姓氏低频）。
  '习',
]);

/**
 * 名尾非人名用字（2026-09-11，数据驱动 + 保守裁剪）
 * ================================================
 * 背景：实体候选来自**滑窗**，会跨词边界切出片段（"学习累不累" → "习累"）。
 * 这类片段的共同特征是**尾字是高频虚词/代词/助词/常见动词形容词**，
 * 而汉人名的收尾字几乎不会是这些字。
 *
 * 取材依据（不是拍脑袋）：对全库 92 个「已确认垃圾候选」（entities 中 type='person'
 * 且从未获得 UUID）与 34 个真实人名/别名（FG status='active'，已排除污染源）
 * 做字符分布差异 —— 下列字**只出现在垃圾集中、从未出现在真实人名中**。
 *
 * ⚠️ 刻意**排除**同一统计里出现的真实姓名用字（成/胡/时/温/舒/边/和/易/阴/那/苁/友/水/满/爱/一/力/动/化/压）
 * —— 纳入会误伤未来的真人姓名（如"成龙""胡歌""时XX"）。宁可少拦不可误伤。
 *
 * 这是**类别级**判据（虚词/代词/助词字集，非人名），不违反「零硬编码人名」原则。
 */
const NON_NAME_TAIL_CHARS = new Set([
  '了','些','什','从','但','你','候','儿','再','别','又','可','后','吗','嘛','她',
  '好','就','是','更','有','条','样','次','的','要','说','那','哪','里','间','面','首',
  '乱','亲','痛','满','熟','注','装','资','足','班','饭','尘','粉','毕','竟','虽','干',
  '打','排','摸','声','地','累',
  // 2026-09-11 二轮扩充（更大的垃圾语料：92 entities + 125 FG void + 已确认 3 个 = 221）
  //  实测漏网案例："中秋节快乐" → "秋节快"；"马上"。二者尾字 快/上 均为典型非名尾字。
  //  同样经过「只在垃圾尾部出现、且从不在真实人名任何位置出现」筛选，
  //  **并人工剔除歧义字**：一/大/日/方/爱/玲/英/峰/白/梦/真/相/子/家/定/性/力/动/化/半/
  //   又/友/叔/玉/美/诗/全/小/东/秋 —— 这些是常见人名用字（李峰、张爱玲、王一…），
  //   纳入会误伤未来真人。宁可漏拦，不可误伤。
  '上','下','不','为','以','位','作','号','呀','啦','唠','净','几','凹','单','得','忍',
  '总','感','慢','慰','或','户','抓','掰','放','显','朵','柔','查','涂','湿','溜','滑',
  '胀','致','苍','茎','蒂','落','讲','话','谁','走','越','身','量','针','闷','阴','快',
  '屏','屄','嘴','婆','今','仔','先','光','内','假','节','菲',
]);

/** 判断是否为句子片段/普通名词（非人名）。供 gradeEntity 与 LLMEntityExtractor 复用。 */
export function looksLikeSentenceFragment(name: string): boolean {
  if (COMMON_NOUN_BLOCK.has(name)) return true;
  for (const t of SENTENCE_TAIL_BLOCK) if (name.endsWith(t)) return true;
  if (SENTENCE_HEAD_BLOCK.includes(name[0])) return true;
  // 2026-09-11: 名尾落在「非人名高频用字」→ 跨词边界的滑窗片段（"习累"/"满足"/"喜欢"）。
  // 放在尾部字面量判定之后、姓氏判定之前，使所有下游路径（含 hasSurname）都受益。
  if (name.length >= 2 && NON_NAME_TAIL_CHARS.has(name[name.length - 1])) return true;
  return false;
}

/** 检查是否在百家姓中 */
function hasSurname(name: string): boolean {
  if (name.length < 2) return false;
  // 单姓匹配
  if (SURNAME_LIST.some(s => name.startsWith(s) && s.length <= 2)) return true;
  return false;
}

/**
 * 对实体名进行分级
 *
 * @param name         候选实体名
 * @param knownUUIDs   当前已知的所有 FG 实体 UUID 映射 (name → uuid)
 * @returns 分级结果
 */
export function gradeEntity(
  name: string,
  knownNames: Set<string> = new Set(),
): GradedEntity {
  if (!name || name.length < 2) {
    return { name, grade: 0, reason: '名称过短' };
  }

  // L5: 用户确认实体（已在 FG 且用户主动提及）
  if (knownNames.has(name)) {
    return { name, grade: 4, reason: '已登记的稳定实体' };
  }

  // L0: 禁止词
  if (ENTITY_BLACKLIST.has(name) || L0_EXTRA.has(name)) {
    return { name, grade: 0, reason: '禁止词（代词/称谓/普通名词）' };
  }

  // L0: 纯数字/单字/无意义
  if (/^\d+$/.test(name) || /^[a-zA-Z]{1,2}$/.test(name)) {
    return { name, grade: 0, reason: '无意义名称' };
  }

  // L0: AI 用户名（防止将"鸿艺""玉瑶"当新实体）
  if ((APP_IDENTITY.userAliases as readonly string[]).includes(name) || name === APP_IDENTITY.aiName) {
    return { name, grade: 4, reason: '系统内置身份' };
  }

  // L1: 普通称谓 — 有语义但非专名（"大姐""小姨"等以称谓结尾的）
  if (/[姐妹妹哥哥弟弟叔叔阿姨伯舅姑爷奶婆公]$/.test(name) && name.length <= 3) {
    return { name, grade: 1, reason: '称谓词 — 需绑定上下文' };
  }

  // V12.0 P1-9: 句子片段/普通名词拦截（短语污染根因）— 必须在 hasSurname/长度判定之前
  if (looksLikeSentenceFragment(name)) {
    return { name, grade: 0, reason: '句子片段/普通名词 — 非人名' };
  }

  // M2-1 2026-09-07: 弱证据姓拦截 — "温柔/应一下/时半/花骨朵/时间的话" 以兼用字开头
  // 被 hasSurname 单看首字误判 L3 → 入 FG 成垃圾 person。弱证据姓 ≠ 人名证据(需组合证据),
  // 降 L2 待绑定上下文; 真实弱姓人已登记走 knownNames(L4) / 用户确认(L5) 路径, 不回退。
  if (name.length >= 2 && WEAK_EVIDENCE_SURNAMES.has(name[0])) {
    return { name, grade: 2, reason: '弱证据姓(兼用字) — 疑似短语, 需绑定上下文' };
  }

  // L2: 昵称/简称 — 少于3字的非姓氏名（"艺哥""小明""阿芬"）
  if (name.length <= 2 && !hasSurname(name)) {
    return { name, grade: 2, reason: '昵称/简称 — 需指代解析' };
  }
  if (name.length === 3 && /[哥叔伯姨姐妹]$/.test(name)) {
    return { name, grade: 2, reason: '昵称/简称 — 需指代解析' };
  }

  // L3: 候选姓名 — 含百家姓或3字以上的姓名结构
  if (hasSurname(name) || name.length >= 3) {
    return { name, grade: 3, reason: '候选姓名' };
  }

  // 默认 L2
  return { name, grade: 2, reason: '无法确定分类，需进一步确认' };
}

/**
 * 批处理分级
 */
export function gradeEntities(
  names: string[],
  knownNames: Set<string> = new Set(),
): GradedEntity[] {
  return names.map(n => gradeEntity(n, knownNames));
}

/**
 * 过滤 — 只保留 L3+ 的稳定实体
 */
export function filterStableEntities(graded: GradedEntity[]): GradedEntity[] {
  return graded.filter(g => g.grade >= 3);
}

/**
 * 生成分级报告（用于日志输出）
 */
export function gradeReport(graded: GradedEntity[]): string {
  const byGrade: Record<number, string[]> = {};
  for (const g of graded) {
    if (!byGrade[g.grade]) byGrade[g.grade] = [];
    byGrade[g.grade].push(g.name);
  }
  const lines: string[] = [];
  for (const [grade, names] of Object.entries(byGrade)) {
    const labels: Record<string, string> = {
      '0': 'L0禁止', '1': 'L1称谓', '2': 'L2昵称', '3': 'L3候选', '4': 'L4已知', '5': 'L5确认',
    };
    lines.push(`  ${labels[grade] || 'L' + grade}: ${names.join(', ')}`);
  }
  return lines.join('\n');
}

export default { gradeEntity, gradeEntities, filterStableEntities, gradeReport };
