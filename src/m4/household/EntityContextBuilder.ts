/**
 * EntityContextBuilder — 实体会晤人物上下文构建器 V10.0
 * ======================================================
 * 从实体 dossier + edges 构建 LLM 上下文。
 * V10.0: 家庭+社交双区块，acquaintance_of 传递闭包，去重+方向修正
 */
import type { FamilyGraph, PersonProfile, PersonDossier } from './FamilyGraph.js';
import { getRelationLabel, getCorrectedRelation } from './shared/RelationLabels.js';
import { buildGreetingProtocol } from './EntityGreetingProtocol.js';

export interface EntityContextOptions {
  entityName: string; appearance?: boolean; feminineDetails?: boolean;
  recentHistoryCount?: number; isFirstTurn?: boolean; userName?: string;
  recentConversations?: Array<{ role: string; content: string; timestamp: string }>;
}
export interface EntityContextResult {
  systemText: string;
  summary: string;
  completeness: number;
  /** V27 结构修复: 会晤铁律改为结构化输出，由 chat.ts 注册进 PromptAssembler（同 id 自动去重）。 */
  rules?: Array<{ id: string; content: string }>;
}

const GARBAGE_NAMES = new Set(['我','妹妹','妈妈','老婆','爸爸','姐姐','哥哥','弟弟','叔叔','公司','学生','小说','开心','时候你','纪实小','计划吗','那你','加班','爸爸','妈妈','姑姑','上司','小龙','老邱','老大','焦虑','方案','无聊','徐茜','徐敏','什么名字','那你说','那继续','快乐','老家','那你再']);
const EXCLUDE_RELS = new Set(['grandchild_of','grandmother_of','grandfather_of','grandparent_of','lives_in','residence_of','has_appearance','has_feature','其他','认识的人']);

const SOCIAL_LABELS: Record<string,string> = {
  'colleague_of':'同事','boss_of':'上司','subordinate_of':'下属',
  'friend_of':'朋友','classmate_of':'同学','partner_of':'合伙人',
  'client_of':'客户','neighbor_of':'邻居','teacher_of':'老师',
  'spouse_of':'配偶','acquaintance_of':'认识的人',
};

export function buildEntityContext(familyGraph: FamilyGraph, options: EntityContextOptions): EntityContextResult {
  const { entityName, appearance=true, feminineDetails=false, recentHistoryCount=5, isFirstTurn=false, userName='鸿艺', recentConversations } = options;
  const profile = familyGraph.getPersonProfile(entityName);
  if (!profile) return { systemText: `你是 ${entityName}。（暂无详细档案）`, summary: `${entityName}: 档案不存在`, completeness: 0 };

  const dossier = profile.dossier || {} as PersonDossier;
  const selfProfile = dossier.selfProfile || {};
  const basicInfo = dossier.basicInfo || {};
  const socialIdentity = dossier.socialIdentity || {};
  const edges = _getRelatedEdges(familyGraph, entityName);
  const parts: string[] = [];

  // ═══ 身份 ═══
parts.push('## 你的身份');
  const _nbj = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const _nh = new Date().getHours();
  const _nds = _nh < 6 ? '凌晨' : _nh < 9 ? '早晨' : _nh < 12 ? '上午' : _nh < 14 ? '中午' : _nh < 18 ? '下午' : _nh < 22 ? '晚上' : '深夜';
  parts.push(`🕐 现在是 **${_nbj}**（${_nds}）。你的所有行动必须基于这个时间。深夜不要说上班或出门。`);
  // 🔴 A3 修复（2026-10-06）：「学历」曾被当成「在读学段」注入。
  //   原判据 `_ed.includes('大学')` + 出生年 2004~2011 区间 ⇒ 已就业的成年人也命中；
  //   且文案直接复用 `_ed`（学历字段）当学段，产出
  //     「🎓 你是 **大学**，日常是上课学习，不是上班族。」
  //   —— 语法不通且概念错位。业主 2026-10-06 实测：徐诗雨 2008 年生、已在
  //   高峰电业做跟单员，却被告知「你是大学，日常上课」。
  //   现把「在校生判据」与「学段文案」分开：
  //     · 判据：显式「在读/学生」；或 **无职业记录** 且年龄落在在校区间（6~22）
  //       —— 有职业即已就业，不是在读；「学历含大学」只说明最高学历，不说明在读
  //     · 文案：由学段推出，且补「生」字（大学→大学生），**不再复用学历字段**
  //     · 已就业 ⇒ 不注入 —— 不注入好过注入一句错话
  const _by = basicInfo.birthYear || (profile as any).birthYear || 0;
  const _edu = String(basicInfo.education || '');
  const _occupation = String(socialIdentity.currentOccupation || (profile as any).occupation || '').trim();
  const _age = _by > 0 ? new Date().getFullYear() - _by : 0;
  const _explicitInSchool = _edu.includes('在读') || _edu.includes('学生');
  const _inSchool = _explicitInSchool || (!_occupation && _age >= 6 && _age <= 22);
  if (_inSchool) {
    let _stage: string;
    if (_explicitInSchool) {
      _stage = _edu.replace(/^在读/, '').trim() || '学生';
      if (_stage && !/生$/.test(_stage)) _stage += '生';
    } else {
      _stage = _age <= 12 ? '小学生' : _age <= 15 ? '初中生' : _age <= 18 ? '高中生' : '大学生';
    }
    parts.push(`🎓 你是 **${_stage}**，日常是上课学习，不是上班族。不要说"在办公室加班""开会""出差"。`);
  }
  parts.push(`你是 **${entityName}**。以下是你的人生档案，请严格基于此档案回复。`);
  parts.push('');

  // ===== 家庭关系摘要(核心+扩展亲属) =====
  const PARENT_RELS = new Set(["child_of","parent_of","mother_of","father_of"]);
  const SIBLING_RELS = new Set(["elder_sister_of","younger_sister_of","sister_of","elder_brother_of","younger_brother_of","brother_of","sibling_of"]);
  const EXT_FAMILY_RELS = new Set(["aunt_of","uncle_of","niece_of","nephew_of","cousin_of","grandmother_of","grandfather_of","grandchild_of"]);
  const parentEdges = edges.filter((e: any) => PARENT_RELS.has(e.relation));
  const siblingEdges = edges.filter((e: any) => SIBLING_RELS.has(e.relation));
  const extFamilyEdges = edges.filter((e: any) => EXT_FAMILY_RELS.has(e.relation));

  // 🔴 V10.14 家人年龄注入：用归一化读取器 getPersonBio 取家人的结构化事实（性别/N岁/职业）。
  //    此前家人区块只输出"名字（关系标签）"，从不读家人 birthYear——LLM 只能靠对话记忆翻旧账编造年龄。
  //    无数据时返回 ''，绝不编造年龄。
  const personDetail = (name: string): string => {
    const bio = familyGraph.getPersonBio?.(name);
    if (!bio) return '';
    const segs: string[] = [];
    if (bio.gender) segs.push(bio.gender);
    if (bio.age !== null && bio.age !== undefined) segs.push(`${bio.age}岁`);
    if (bio.occupation) segs.push(bio.occupation);
    return segs.join('，');
  };
  const decorate = (name: string): string => { const d = personDetail(name); return d ? `${name}（${d}）` : name; };

  const hasFamily = parentEdges.length > 0 || siblingEdges.length > 0 || extFamilyEdges.length > 0;
  if (hasFamily) {
    parts.push('### 你的家人');
    const fatherNames: string[] = [];
    const motherNames: string[] = [];
    for (const e of parentEdges) {
      // 🔴 归一化 gender（dossier+顶层择优，过滤'未知'），避免顶层 female 的节点被判成父亲
      const bio = familyGraph.getPersonBio?.(e.entity);
      if (bio?.gender === '女') motherNames.push(decorate(e.entity));
      else fatherNames.push(decorate(e.entity));
    }
    if (fatherNames.length) parts.push(`父亲：${fatherNames.join('、')}`);
    if (motherNames.length) parts.push(`母亲：${motherNames.join('、')}`);
    if (siblingEdges.length) {
      // 🔴 去重：同一人可能有多条同级关系边（如 elder_sister_of + younger_sister_of 同时存在），按名字去重
      const seenSibs = new Set<string>();
      const uniqueSibs = siblingEdges.filter((e: any) => { if (seenSibs.has(e.entity)) return false; seenSibs.add(e.entity); return true; });
      // 🔴 注入 (性别,N岁,职业)：`熊梓玥（妹妹，女，8岁，学生）`；无 birthYear 则保持原样不编造
      parts.push(`兄弟姐妹：${uniqueSibs.map((e: any) => {
        const d = personDetail(e.entity);
        return `${e.entity}（${e.relationLabel}${d ? '，' + d : ''}）`;
      }).join('、')}`);
    }
    if (extFamilyEdges.length) {
      // 分组展示
      const grouped: Record<string, string[]> = {};
      for (const e of extFamilyEdges) {
        const lbl = e.relationLabel || e.relation;
        if (!grouped[lbl]) grouped[lbl] = [];
        grouped[lbl].push(decorate(e.entity));
      }
      for (const [lbl, names] of Object.entries(grouped)) {
        parts.push(`${lbl}：${names.join('、')}`);
      }
    }
    parts.push('');
  }

  // ═══ 基本信息 ═══
  const bioParts: string[] = [];
  if (basicInfo.gender) bioParts.push(`性别: ${basicInfo.gender}`);
  if (basicInfo.birthYear) bioParts.push(`出生年: ${basicInfo.birthYear}`);
  // 🔴 S2-I1: 出生地注入（原漏注入 — "我是哪里人"全靠编造）
  if (basicInfo.birthPlace) bioParts.push(`出生地: ${basicInfo.birthPlace}`);
  if (basicInfo.education) bioParts.push(`学历: ${basicInfo.education}`);
  if (basicInfo.maritalStatus) bioParts.push(`婚姻: ${basicInfo.maritalStatus}`);
  if (bioParts.length > 0) { parts.push('### 基本信息'); parts.push(bioParts.join('  |  ')); parts.push(''); }

  // ═══ 社会身份 ═══
  const socParts: string[] = [];
  if (socialIdentity.currentOccupation) socParts.push(`职业: ${socialIdentity.currentOccupation}`);
  if (socialIdentity.currentWorkplace) socParts.push(`工作单位: ${socialIdentity.currentWorkplace}`);

  // 🔴 A2 修复（2026-10-06）：正式身份只认「实体 ↔ 用户」这一条关系。
  //   原实现扫 `edges`（= _getRelatedEdges = getRelatedPersons，**出边+入边、不分方向、不限对方是谁**），
  //   命中第一个 `child_of` 就写「鸿艺的孩子」并 break ⇒ 徐诗雨与自己父亲的边（child_of→徐东伟）
  //   排在她的用户边之前，"与鸿艺的关系"就被渲染成「鸿艺的孩子」。
  //   实测（2026-10-06 真实库）：她与用户之间有 9 条互斥边（spouse_of/child_of/sibling_of/grandchild_of…），
  //   而业主定音的正确口径「同事、情人」一条都没有 ⇒ 读取侧挑得再准也只能挑出错的那条。
  //   ⇒ 读取侧收窄为「用户边」，方向交给 getRelationLabel(relation, isOutgoing)，不再自建第二张映射表。
  const _userRel = _getUserRelation(familyGraph, entityName);
  let _relationLabel = _userRel.labels.join('、');
  if (!_relationLabel) _relationLabel = getCorrectedRelation(entityName, profile.relation_to_user);
  // 🔴 A2 修复（2026-10-06）：删除「——亲密互动（热力追踪已确认）」后缀，热力状态改独立一行。
  //   业主定音（2026-10-06）：「不要把对话亲密情趣互动的称呼作为正式档案记录，这个错误很严重，
  //   很容易把档案搞乱」。原实现（V10.8 category='X' / V10.9 A 类 warmth）把热力状态**拼进了正式身份行**，
  //   而她那条 warmth 是热力追踪器盲取 `edges[0]` 写到**父女边**上的（见 RelationHeatTracker）——
  //   于是"正式身份"变成了「鸿艺的孩子——亲密互动（热力追踪已确认）」。
  //   ⇒ 亲密状态归「互动亲密度」独立行（只影响语气），「与 X 的关系」只放客观关系。
  const _rpProfile=dossier.roleplayProfile||(profile).roleplayProfile;if(_rpProfile?.names?.length){parts.push("### 角色扮演（仅限情趣互动场景）");parts.push("你在亲密互动时曾用以下称谓称呼鸿艺："+_rpProfile.names.join("、")+"。");parts.push("🔴 这些称谓仅限情趣互动/角色扮演场景，不影响正式身份。");if(_relationLabel)parts.push("你的正式身份："+_relationLabel+"。");parts.push("日常聊天/正式对话请以正式身份交流。");parts.push("");};if (_relationLabel) socParts.push(`与鸿艺的关系: ${_relationLabel}`);
  if (_userRel.warmth) socParts.push(`互动亲密度: ${WARMTH_LABEL[_userRel.warmth]}（热力追踪）—— 只影响语气，不改变正式身份`);
  if (socParts.length > 0) { parts.push('### 社会身份'); parts.push(socParts.join('  |  ')); parts.push(''); }

  // ═══ 性格 ═══
  if (selfProfile.traits?.length) { parts.push('### 性格'); parts.push(selfProfile.traits.join('、')); parts.push(''); }

  // ═══ 社交关系（系统级：通过 acquaintance_of 传递闭包构建完整人际网络） ═══
  // 原理：entity → acquaintance_of → 所有人 → 过滤社交类型标签
  // 展示 entity 直接和间接认识的所有同事/朋友等
  const allKnownNames = familyGraph.getAllPersonNames?.() || [];
  const knownSet = new Set(allKnownNames.filter((n: string) => !GARBAGE_NAMES.has(n) && n !== entityName));
  const socialDirect = edges.filter((e: any) => SOCIAL_LABELS[e.relation]);
  const seen = new Set(socialDirect.map((e: any) => e.entity));

  // 传递闭包：通过 acquaintance_of 找到所有间接认识的人
  const acqEdges = edges.filter((e: any) => e.relation === 'acquaintance_of');
  for (const ae of acqEdges) {
    if (!seen.has(ae.entity) && knownSet.has(ae.entity)) {
      socialDirect.push({ ...ae, relation: 'acquaintance_of', relationLabel: '认识的人' });
      seen.add(ae.entity);
    }
  }

  if (socialDirect.length > 0) {
    // 收集家庭标签中已有的人（不重复展示在社交区）
    const familyNames = new Set<string>();
    for (const e of [...parentEdges, ...siblingEdges, ...extFamilyEdges]) familyNames.add(e.entity);

    // V10.0: 标签升级 — 通过传递闭包确定精确关系类型
    const upgraded = socialDirect
      .filter((e: any) => !familyNames.has(e.entity)) // 排除已有家族边的人
      .map((e: any) => {
        const personEdges = _getRelatedEdges(familyGraph, e.entity);
        const isColleague = personEdges.some((pe: any) => pe.relation === 'colleague_of');
        const isBoss = personEdges.some((pe: any) => pe.relation === 'boss_of');
        const isSub = personEdges.some((pe: any) => pe.relation === 'subordinate_of');
        if (isBoss) return { ...e, label: '上司' };
        if (isSub) return { ...e, label: '下属' };
        if (isColleague) return { ...e, label: '同事' };
        return { ...e, label: SOCIAL_LABELS[(e as any).relation] || e.relationLabel };
      });

    parts.push('### 你认识的人');
    for (const e of upgraded) {
      parts.push(`- ${e.entity}：${(e as any).label}`);
    }
    parts.push('（以上是你的人际网络。有人问你认不认识，你认识——档案里写了。不知道具体细节就说"知道但不太清楚详情"。）');
    parts.push('');
  }

  // ═══ 外貌 ═══
  if (appearance) {
    const ap: string[] = [];
    if (selfProfile.appearance) ap.push(selfProfile.appearance);
    if (selfProfile.bodyFeatures) ap.push(selfProfile.bodyFeatures);
    if (selfProfile.style) ap.push(selfProfile.style);
    if (ap.length > 0) { parts.push('### 外貌'); parts.push(ap.join(' | ')); parts.push(''); }
  }

  // ═══ 人生里程碑 ═══
  // 🔴 S2-I1: 从 3 条改为 6 条 — 让档案里的真实经历(关系变迁等)更多可见，减少 LLM 编造填充
  if (dossier.lifeMilestones?.length) {
    parts.push('### 人生里程碑');
    for (const ms of dossier.lifeMilestones.slice(0, 6)) parts.push(`- ${ms.date}: ${ms.event}`);
    parts.push('');
  }

  // ═══ 行为约束 ═══
  parts.push('### 规则');
  parts.push(`- 你就是 ${entityName} 本人。基于你的档案和过去的对话记忆来回应鸿艺。`);
  // === V27 结构修复: 铁律改为结构化输出（rules），由 chat.ts 注册进 PromptAssembler ===
  // 目的：同 id + conflictPolicy override → 自动去重；并获得 PAS 的分层/优先级/预算保障。
  // 原文一字不改，仅改变承载通道。
  const rules: Array<{ id: string; content: string }> = [
    {
      id: 'entity_self_title',
      content: `- 🔴【自称铁律 · 系统级规范】你的每一条回复中，除了括号里的心理描写外，在**正文语句里**必须自然地带上你的名字或自称（如"${entityName}觉得…""${entityName.slice(-2)}在这儿呢""我${entityName}…"）。这是为了让鸿艺一眼认出是谁在说话，也是系统识别说话人的兜底规则。`,
    },
    {
      id: 'entity_memory_priority',
      content: '- 🔴【记忆优先于标签】如果【过去的对话记忆】中显示你和鸿艺有比档案关系更亲密或不同的互动——那些记忆是真实的、发生过的。关系可以从无到有、从疏到亲。档案里的关系标签只是一个标签，不是对你行为的限制。记忆中有的，就是事实。',
    },
    {
      id: 'entity_recall_not_fabrication',
      content: '- 🔴【回忆 ≠ 编造】下面的【过去的对话记忆】是你和鸿艺之间**真实发生过的对话**——这是你亲身的经历，不是编造。当你回顾这些记忆时，是在**回忆事实**。你可以自然地讲述记忆中发生的事、说过的话——因为那些是真实存在的。',
    },
    {
      // 🔴 S2-N1: 「共同过去」法定分界线 — 过去分两类，忠实复述禁止添加细节
      // ⚠️ V27: 与 chat.ts memoryGuard 同 id（权威版含 S2-R4），assembler override 后以 chat.ts 版本为准。
      id: 'entity_past_boundary',
      content: '- 🔴【系统铁律·过去的法定分界线=共同过去】过去分两类：\n'
        + '  ① 共同过去 = 你和鸿艺真实聊过并存进记忆/数据库的内容 + 知识库已有文档（含本档案）。这些是事实，**只能忠实复述记录中已有的内容**（可摘要/详细/润色语言）。**绝对禁止添加记录中不存在的事件、物品、场景、对话、细节**——比如记录只写了\'14岁父亲出差接你去宿舍学习\'，就不能编\'银色丰田来接/白粥咸鸭蛋\'这些没有的。没有的就是没有，诚实说\'这个我没有记录/不记得/档案里没写\'。\n'
        + '  ② 框架内创造 = 档案/知识库/记忆里都没有的空白过去。允许在符合你个人背景（生活/家庭/工作/性格/年龄/爱好）的框架下合理创造。但一旦这些创造被记录进记忆，就固化为\'共同过去\'，之后**绝不能再次编造或再创造**。\n'
        + '  判断某段过去属于哪类，先看它在不在记忆/数据库/知识库档案里：在 → 共同过去（只复述记录内事实，禁止添加细节）；不在 → 才允许框架内创造。',
    },
    {
      id: 'entity_memory_fact',
      content: '- 🔴【记忆即事实·铁律】记忆片段中鸿艺对你说的话、和你做的事——就是真实发生过的。不管你的关系标签怎么写，不管你的身份是谁，记忆中有的互动就是你亲身经历的事实。鸿艺提到这些时，你必须正面回应，不能否认、不能回避、不能说\'我们不熟\'\'我只是你的XX\'。你记忆中发生过的，就是发生过。',
    },
  ];
  parts.push('- 提到别人时你仍是你自己，不替别人说话。');

  // 🆕 V10.13 修复: 注入【过去的对话记忆】— 此前 recentConversations 传入但被丢弃，
  // 导致实体会晤时对话记忆恢复却不进 LLM 上下文（"像没有记忆一样"）。
  // 现在把真实的对话记忆拼进 systemText，让实体能"回忆"与鸿艺的真实互动。
  // 🆕 V26 修复: 加【历史记录·当前时间以系统提示为准】强约束，防止 LLM 被历史对话里的时间词（如"四点""睡吧"）带偏，在当前时段重复错误语境。
  if (recentConversations && recentConversations.length > 0) {
    const memParts = ['### 过去的对话记忆'];
    for (const t of recentConversations.slice(0, 10)) {
      const speaker = t.role === 'user' ? userName : entityName;
      const content = (t.content || '').replace(/\s+/g, ' ').substring(0, 200);
      memParts.push(`- ${speaker}：${content}`);
    }
    memParts.push('（以上是你和鸿艺之间真实发生过的对话。有人提到这些事，你要自然回应——这些是你亲身经历的，不是编造。）');
    memParts.push('⚠️ 【时间约束铁律】以上对话是历史记录。你当前的时间以系统提示里「现在是」的标注为准，不以历史对话里提到的时间点为准。历史对话里说的"四点""睡吧""大半夜"是当时的情境，不代表现在。你现在是什么时段就按什么时段回应，不要套用历史对话里的时间语境。');
    memParts.push('');
    parts.push(memParts.join('\n'));
  }

  let systemText = parts.join('\n');
  if (isFirstTurn) {
    const greeting = buildGreetingProtocol(profile, userName);
    if (greeting) systemText = greeting + '\n\n' + systemText;
  }

  return {
    systemText,
    summary: `${entityName}: ${profile.relation_to_user || ''} ${socialIdentity.currentOccupation || ''}`.trim(),
    completeness: Math.round((profile.completeness || 0) * 100),
    rules,
  };
}

/** 关系标签优先级：数字越小越靠前（业主 2026-10-06 口径「同事、情人」⇒ 情人先展示） */
const USER_REL_PRIORITY: string[] = [
  'spouse_of', 'lover_of',
  'parent_of', 'father_of', 'mother_of', 'child_of',
  'elder_brother_of', 'younger_brother_of', 'brother_of',
  'elder_sister_of', 'younger_sister_of', 'sister_of', 'sibling_of',
  'colleague_of', 'boss_of', 'subordinate_of',
  'friend_of', 'classmate_of', 'neighbor_of', 'acquaintance_of',
];

const WARMTH_LABEL: Record<string, string> = {
  soulmate: '灵魂伴侣级', intimate: '亲密', trusted: '信任', friendly: '友好', distant: '疏远',
};
const WARMTH_RANK: Record<string, number> = { distant: 0, friendly: 1, trusted: 2, intimate: 3, soulmate: 4 };

/**
 * 🔴 A2（2026-10-06）：取「实体 ↔ 用户」这一条关系 —— 正式身份的唯一来源。
 *
 * 为什么必须是「唯一来源」：原实现遍历该实体的**全部**边（出+入、不限对方、不分方向），
 * 命中第一个关系词就 break。实测徐诗雨名下 `child_of→徐东伟`（真·父女边）排在前面，
 * 于是她的"与鸿艺的关系"被渲染成「鸿艺的孩子」——**跟用户毫无关系的一条边**。
 *
 * 方向语义（本条修复新增，原实现完全丢失了方向）：
 *   · `实体 --R--> 用户`  ⇒ 正向，标签 = label(R)          （她 --child_of--> 我 ⇒ 子女）
 *   · `用户 --R--> 实体`  ⇒ 反向，标签 = label(reverse(R))（我 --child_of--> 她 ⇒ 父母）
 * 方向交给 `getRelationLabel(relation, isOutgoing)` 的既有实现，
 * **不再自建第二张「关系→中文」映射表**（本仓不变量 #7：同一规则禁止多处实现）。
 */
function _getUserRelation(familyGraph: FamilyGraph, entityName: string): { labels: string[]; warmth: string | null } {
  const empty = { labels: [] as string[], warmth: null as string | null };
  try {
    const fg = familyGraph as any;
    const userId: string | null = typeof fg.getUserNodeId === 'function' ? fg.getUserNodeId() : null;
    if (!userId) return empty;
    const uuid: string | null = typeof fg.getUUIDByName === 'function' ? fg.getUUIDByName(entityName) : null;
    const node = uuid && typeof fg.getEntityByUUID === 'function' ? fg.getEntityByUUID(uuid) : null;
    const entityId: string | null = node?.id ? String(node.id) : null;
    if (!entityId || entityId === userId) return empty;

    const rows = (fg.query(
      'SELECT source_id, relation, properties FROM edges WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)',
      [entityId, userId, userId, entityId],
    ) || []) as Array<{ source_id: string; relation: string; properties: string }>;
    if (rows.length === 0) return empty;

    // key 带方向：同一 relation 的正反两条边语义不同（child_of 正向=子女、反向=父母），不能互相覆盖
    const byRelDir = new Map<string, { relation: string; label: string }>();
    let warmth: string | null = null;
    for (const r of rows) {
      const rel = String(r.relation || '');
      if (!rel) continue;
      const isOutgoing = String(r.source_id) === entityId;
      byRelDir.set(`${rel}|${isOutgoing ? 1 : 0}`, { relation: rel, label: getRelationLabel(rel, isOutgoing) });
      try {
        const w = String(JSON.parse(r.properties || '{}')._relation_warmth || '');
        if (WARMTH_RANK[w] !== undefined && (warmth === null || WARMTH_RANK[w] > WARMTH_RANK[warmth])) warmth = w;
      } catch { /* 单条 properties 解析失败不影响其他 */ }
    }

    const labels: string[] = [];
    for (const { relation, label } of [...byRelDir.values()].sort((a, b) => {
      const ia = USER_REL_PRIORITY.indexOf(a.relation);
      const ib = USER_REL_PRIORITY.indexOf(b.relation);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    })) {
      if (label && !labels.includes(label)) labels.push(label);
    }
    return { labels, warmth };
  } catch {
    return empty;
  }
}

/** 获取实体的关系边——过滤+去重+按类型分类 */
function _getRelatedEdges(familyGraph: FamilyGraph, entityName: string): Array<{ entity: string; relationLabel: string; relation: string }> {
  try {
    const fg = familyGraph as any;
    if (typeof fg.getRelatedPersons !== 'function') return [];
    const persons = fg.getRelatedPersons(entityName) || [];
    // 排序：家族边优先，确保去重时保留家族关系而非 acquaintance_of
    const FAM_PRIORITY = new Set(['child_of','parent_of','mother_of','father_of','spouse_of',
      'elder_sister_of','younger_sister_of','sister_of','brother_of','sibling_of',
      'aunt_of','uncle_of','niece_of','nephew_of','cousin_of','grandmother_of','grandfather_of',
      // V10.0: 工作关系也优先于 acquaintance_of
      'colleague_of','boss_of','subordinate_of','friend_of','classmate_of']);
    persons.sort((a: any, b: any) => (FAM_PRIORITY.has(a.relation) ? 0 : 1) - (FAM_PRIORITY.has(b.relation) ? 0 : 1));

    return persons
      .filter((p: any) => !GARBAGE_NAMES.has(p.name) && !EXCLUDE_RELS.has(p.relation))
      .map((p: any) => ({ entity: p.name || p.entity, relationLabel: getRelationLabel(p.relation, false), relation: p.relation }))
      .filter((p: any, i: number, arr: any[]) => !arr.slice(0, i).some((x: any) => x.entity === p.entity)); // 去重
  } catch { return []; }
}

/** V6.0: 多人会晤上下文 */
export function buildMultiEntityContext(familyGraph: FamilyGraph, options: { entityNames: string[]; isFirstTurn?: boolean }): EntityContextResult {
  const { entityNames, isFirstTurn = false } = options;
  const allProfiles = entityNames.map(name => ({ name, profile: familyGraph.getPersonProfile(name) })).filter(p => !!p.profile);
  if (allProfiles.length === 0) return { systemText: `多人会晤：${entityNames.join('、')}`, summary: '无档案', completeness: 0 };
  const parts: string[] = [];
  parts.push(`## 多人会晤：${allProfiles.map(p => p.name).join('、')}`);
  parts.push('');
  for (const { name, profile } of allProfiles) {
    const bi = (profile as any).dossier?.basicInfo || {};
    const si = (profile as any).dossier?.socialIdentity || {};
    const sp = (profile as any).dossier?.selfProfile || {};
    // 🔴 多人会晤同用归一化读取器注入年龄（dossier 优先），避免只输出"2018年生"
    const bio = familyGraph.getPersonBio?.(name);
    parts.push(`**${name}**`);
    const b: string[] = [];
    if (bi.gender) b.push(bi.gender);
    if (bi.birthYear) b.push(`${bi.birthYear}年生`);
    if (bio?.age !== null && bio?.age !== undefined) b.push(`${bio.age}岁`);
    if (si.currentOccupation) b.push(si.currentOccupation);
    if (b.length) parts.push(b.join(' | '));
    if (sp.traits?.length) parts.push(`性格: ${sp.traits.slice(0,4).join('、')}`);
    parts.push('');
  }
  parts.push('### 规则');
  parts.push('- 你是你自己（不是玉瑶、不是AI），以档案身份和性格说话');
  parts.push('- 每次发言自然带上自称，让大家知道谁在说话');
  return { systemText: parts.join('\n'), summary: `${allProfiles.length}人会晤`, completeness: 50 };
}

export default buildEntityContext;
