/**
 * DataCollector — 七路全量数据采集器
 *
 * 🔴 铁律（约束1）：所有查询走主系统标准接口
 *   - 图谱查询 → FamilyGraph
 *   - 知识检索 → KnowledgeBase
 *   - 记忆查询 → SQLiteAdapter（主系统公开 API）
 *
 * 采集完成后输出结构化数据，由 PromptAssembler 按四层装配。
 */
import type { DomainContext, CharacterClass } from './types.js';
import type { FamilyGraphRoleBranch } from '../alignment/FamilyGraphRoleBranch.js';

const COLLECT_TIMEOUT = 3000;

/** 四层结构化输出 */
export interface FourLayerData {
  layer1: { identity: string; ageGuard: string };
  layer2: { relations: string; relationState: string };
  layer3: { history: string[]; goldMemories: string[]; diamondMemories: string[] };
  layer4: { kbEntries: string[] };
  /** 实体解析结果 */
  entities: string[];
  kinshipTerms: string[];
  pronounTarget: string | null;
  /** 原始数据（供验证器使用） */
  rawFgTree: string;
}

const withTimeout = <T>(p: Promise<T>, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>(r => setTimeout(() => r(fallback), COLLECT_TIMEOUT))]);

export async function collectData(
  ctx: DomainContext,
  message: string,
  roleplay: string,
  characterClass: CharacterClass,
  rpBranch: FamilyGraphRoleBranch | null,
): Promise<FourLayerData> {
  const src = ctx.m4?.getFamilyGraph?.();

  // ── 并行 7 路采集 ──
  const [
    fgProfile, fgFamily, fgTree,
    kbHits,
    history,
    diamondMemories,
    entities,
  ] = await Promise.all([
    // ① 角色本人 FG profile
    withTimeout(Promise.resolve(src?.getPersonProfile?.(roleplay) ?? null), null),
    // ② 家族成员 profile
    withTimeout(collectFamilyProfiles(src, rpBranch, roleplay), {} as Record<string, any>),
    // ③ FG 家族树文本
    withTimeout(Promise.resolve(rpBranch?.getFamilyTreeText?.() ?? ''), ''),
    // ④ 知识库（角色名 + 消息实体 + 家族成员）
    withTimeout(collectKB(ctx, message, roleplay, rpBranch, characterClass), [] as string[]),
    // ⑤ 历史对话
    withTimeout(loadHistory(ctx, roleplay), [] as string[]),
    // ⑥ 黑钻记忆
    withTimeout(collectDiamond(ctx, roleplay), [] as string[]),
    // ⑦ 实体解析
    withTimeout(resolveEntities(ctx, message, roleplay, rpBranch, src), { entities: [] as string[], kinshipTerms: [] as string[], pronounTarget: null as string | null }),
  ]);

  // ── 装配四层数据 ──

  // Layer1: 核心身份 — 🔴 从FG/KB/历史多源回填年龄
  const ageFromProfile = fgProfile?.age ? `你今年${fgProfile.age}岁。` : null;
  const ageFromKB = extractAgeFromKB(kbHits, roleplay);
  const ageFromHistory = extractAgeFromHistory(history, roleplay);
  const ageText = ageFromProfile ?? ageFromKB ?? ageFromHistory;
  const identityParts: string[] = [];
  if (fgProfile?.description) identityParts.push(fgProfile.description);
  if (fgProfile?.occupation) identityParts.push(`职业：${fgProfile.occupation}`);
  if (fgProfile?.traits?.length) identityParts.push(`性格：${fgProfile.traits.join('、')}`);

  // 如果FG没有画像但有KB资料，用KB回填
  if (identityParts.length === 0 && kbHits.length > 0) {
    const kbId = extractIdentityFromKB(kbHits, roleplay);
    if (kbId) identityParts.push(kbId);
  }

  const identity = identityParts.length > 0 ? identityParts.join('\n') : `你是${roleplay}`;

  // 🔴 年龄锚点（强硬版本 — 不可被LLM忽略）
  const ageGuard = ageText
    ? `【年龄事实 — 不可违反】${ageText}\n如果在回复中提到年龄，必须与此一致。`
    : '【年龄事实 — 不可违反】你不知道自己具体多少岁。如果被问到年龄，必须直接回答"你没告诉过我"或"我不太清楚"。\n🔴 不允许说"已经不年轻了"之类模糊表达。如果不知道就明确说不知道。';

  // Layer2: 关系
  const familyBlocks: string[] = [];
  if (fgTree) familyBlocks.push(fgTree);
  if (fgFamily && typeof fgFamily === 'object') {
    for (const [name, pf] of Object.entries(fgFamily) as [string, any][]) {
      const fields: string[] = [];
      if (pf.age) fields.push(`年龄：${pf.age}`);
      if (pf.occupation) fields.push(`职业：${pf.occupation}`);
      if (pf.relation) fields.push(`关系：${pf.relation}`);
      if (pf.traits?.length) fields.push(`性格：${pf.traits.join('、')}`);
      if (fields.length > 0) familyBlocks.push(`【${name}】${fields.join(' | ')}`);
    }
  }
  // 🔴 关系强化：从家族树中提取所有人名和关系，生成不可覆盖的声明
  const knownRelations = extractKnownRelations(fgTree, fgFamily, rpBranch, roleplay);
  const relations = familyBlocks.length > 0
    ? familyBlocks.join('\n') + (knownRelations ? '\n\n' + knownRelations : '')
    : (knownRelations || '');

  // Layer3: 记忆（历史10轮+金库+黑钻）
  const allHistory = history.slice(-10);
  const goldMemories: string[] = []; // 金库通过 ctx.storage 在主流程中已做
  const diamondList = diamondMemories.length > 0 ? ['【珍藏记忆】' + diamondMemories.join('\n')] : [];

  // Layer4: 知识（限2条）
  const kbList = kbHits.slice(0, 2);

  return {
    layer1: { identity, ageGuard },
    layer2: { relations, relationState: '' },
    layer3: { history: allHistory, goldMemories, diamondMemories: diamondList },
    layer4: { kbEntries: kbList },
    entities: entities.entities,
    kinshipTerms: entities.kinshipTerms,
    pronounTarget: entities.pronounTarget,
    rawFgTree: fgTree,
  };
}

// ── 家族成员 profile 采集 ──

async function collectFamilyProfiles(
  fg: any,
  rpBranch: FamilyGraphRoleBranch | null,
  roleplay: string,
): Promise<Record<string, any>> {
  const result: Record<string, any> = {};
  if (!fg) return result;

  const members = rpBranch?.getAllNames?.() ?? [];
  for (const name of members) {
    if (name === roleplay || name === '我') continue;
    try {
      const p = fg.getPersonProfile?.(name);
      if (!p) continue;
      const c: Record<string, any> = {};
      if (p.age) c.age = p.age;
      if (p.occupation) c.occupation = p.occupation;
      if (p.appearance) c.appearance = p.appearance;
      if (p.traits?.length) c.traits = p.traits;
      if (p.personality) c.personality = p.personality;
      if (p.relation_to_user) c.relation = p.relation_to_user;
      if (p.description) c.description = p.description?.substring?.(0, 200);
      if (Object.keys(c).length > 0) result[name] = c;
    } catch (_) {}
  }
  return result;
}

// ── 知识库采集（角色+消息实体+家族成员） ──

async function collectKB(
  ctx: DomainContext,
  message: string,
  roleplay: string,
  rpBranch: FamilyGraphRoleBranch | null,
  characterClass: CharacterClass,
): Promise<string[]> {
  if (!ctx.knowledgeBase) return [];
  const results: string[] = [];
  const seen = new Set<string>();

  const add = async (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    try {
      const hits = await ctx.knowledgeBase.search(name, 1);
      for (const h of hits) {
        const text = `\u{1f4c4} ${h.title}\n${(h.content || '').substring(0, 300)}`;
        if (!results.includes(text)) results.push(text);
      }
    } catch (_) {}
  };

  // 角色名
  await add(roleplay);
  // 消息实体
  const names = message.match(/[一-龥]{2,4}(?=[，。！？\s]|的|了|是|有|在|说)/g) || [];
  for (const n of [...new Set(names)]) if (n !== roleplay && n !== '我') await add(n);
  // 家族成员
  const members = rpBranch?.getAllNames?.() ?? [];
  for (const m of members) if (m !== roleplay && m !== '我') await add(m);

  return results;
}

// ── 历史对话 ──

async function loadHistory(ctx: DomainContext, roleplay: string): Promise<string[]> {
  if (!ctx.conversationDB?.searchByRoleplay) return [];
  try {
    const rows = ctx.conversationDB.searchByRoleplay(roleplay, 10);
    return rows?.map((r: any) => `${r.role === 'user' ? '👤' : '💬'} ${(r.content || '').substring(0, 200)}`) ?? [];
  } catch (_) { return []; }
}

// ── 黑钻记忆 ──

async function collectDiamond(ctx: DomainContext, roleplay: string): Promise<string[]> {
  const sqlite = ctx.m4?.getFamilyGraph?.()?.getSQLite?.();
  if (!sqlite?.queryAll) return [];
  try {
    const rows = sqlite.queryAll(
      "SELECT summary FROM black_diamond WHERE tags LIKE ? ORDER BY created_at DESC LIMIT 5",
      [`%rp_${roleplay}%`],
    );
    return rows?.map((r: any) => r.summary).filter(Boolean) ?? [];
  } catch (_) { return []; }
}

// ── 实体解析 ──

async function resolveEntities(
  ctx: DomainContext,
  message: string,
  roleplay: string,
  rpBranch: FamilyGraphRoleBranch | null,
  fg: any,
): Promise<{ entities: string[]; kinshipTerms: string[]; pronounTarget: string | null }> {
  const entities: string[] = [];
  const kinshipTerms: string[] = [];
  let pronounTarget: string | null = null;

  if (ctx.dna?.entity_genes) {
    for (const g of ctx.dna.entity_genes) {
      if (g.type === 'person' && g.name !== '我' && g.name !== roleplay && !entities.includes(g.name))
        entities.push(g.name);
    }
  }

  if (rpBranch && /妈|爸|姐|妹|哥|弟|老婆|老公/.test(message)) {
    for (const kw of ['妈妈','妈','爸爸','爸','姐姐','妹妹','哥哥','弟弟','老婆','老公']) {
      if (message.includes(kw)) {
        kinshipTerms.push(kw);
        for (const rn of rpBranch.resolveKinship(kw)) {
          if (!entities.includes(rn)) entities.push(rn);
        }
      }
    }
  }

  const onlyRel = entities.length > 0 && entities.every(e => /姐姐|妹妹|哥哥|弟弟|妈妈|爸爸/.test(e));
  if ((entities.length === 0 || onlyRel) && (/[她他]/.test(message) || onlyRel)) {
    const recent = ctx.conversationHistory.slice(-5).filter((t: any) => t.role === 'user').map((t: any) => t.content).join(' ');
    const names = recent.match(/[一-龥]{2,4}(?=[，。！？\s]|的|了|是|有|在|说)/g) || [];
    const real = (names as string[]).find(n =>
      n !== roleplay && n !== '我' && n.length >= 2 && !/姐姐|妹妹|哥哥|弟弟|妈妈|爸爸/.test(n)
    );
    if (real) { entities.push(real); pronounTarget = real; }
  }

  return { entities, kinshipTerms, pronounTarget };
}

// ── 多源年龄回填 ──

/** 从KB条目中提取角色的年龄 */
function extractAgeFromKB(kbHits: string[], roleplay: string): string | null {
  const agePattern = new RegExp(`${roleplay}[^。]*?(\\d{1,2})岁`);
  for (const entry of kbHits) {
    const m = entry.match(agePattern);
    if (m) return `你今年${m[1]}岁。`;
  }
  // 有时KB标题包含年龄但不含角色名在同一句
  const numPattern = /(\d{1,2})岁/;
  for (const entry of kbHits) {
    if (entry.includes(roleplay) || entry.includes('诗韵') || entry.includes('诗雨')) {
      const m = entry.match(numPattern);
      if (m) return `你今年${m[1]}岁。`;
    }
  }
  return null;
}

/** 从对话历史中提取角色的年龄 */
function extractAgeFromHistory(history: string[], roleplay: string): string | null {
  const agePattern = new RegExp(`${roleplay}[^。]*?(\\d{1,2})岁`);
  for (const entry of history.slice(-10)) {
    const m = entry.match(agePattern);
    if (m) return `你今年${m[1]}岁。`;
  }
  return null;
}

/** 从KB中提取角色身份描述（当FG画像缺失时） */
function extractIdentityFromKB(kbHits: string[], roleplay: string): string | null {
  for (const entry of kbHits) {
    if (entry.includes(roleplay)) {
      const lines: string[] = [];
      // 取前200字符中包含的描述信息
      const header = entry.substring(0, 300);
      const parts: string[] = [];
      // 提取身高、年龄、特征等
      const heightM = header.match(/身高[\d.]+米/);
      if (heightM) parts.push(heightM[0]);
      const ageM = header.match(/(\d{1,2})岁[^。]*?少女|(\d{1,2})岁的/);
      if (ageM) parts.push(ageM[0]);
      const descM = header.match(/[，。](.{5,30}女子|.{5,30}女孩|.{5,30}样子)/);
      if (descM) parts.push(descM[1]);
      if (parts.length > 0) return parts.join('，');
    }
    // FG档案范式
    if (entry.includes('FG') && entry.includes('档案') && (entry.includes(roleplay) || entry.includes('诗韵'))) {
      return null; // FG范式模板不包含身份描述
    }
  }
  return null;
}

/** 从家族树和profiles中提取所有已知关系，生成不容LLM覆盖的强硬声明 */
function extractKnownRelations(
  fgTree: string,
  fgFamily: Record<string, any>,
  rpBranch: FamilyGraphRoleBranch | null,
  roleplay: string,
): string {
  const known: string[] = [];

  // 从familyProfiles中提取（relation字段来自 profile.relation_to_user）
  if (fgFamily && typeof fgFamily === 'object') {
    for (const [name, pf] of Object.entries(fgFamily) as [string, any][]) {
      const rel = pf.relation || pf.relation_to_user;
      if (rel) {
        // 兄弟姐妹 → 推断具体称呼
        const label = rel === '兄弟姐妹'
          ? (name.includes('姐') || name.includes('妹') || name.endsWith('瑜') || name.endsWith('雨') ? '姐妹' : '兄弟')
          : rel;
        known.push(`⬆ ${name}是你的${label}`);
      }
    }
  }

  if (known.length === 0) return '';
  return '【已知亲属关系 — 必须遵守】\n' + known.join('\n') + '\n🔴 以上关系来自家族图谱，是客观事实。不得编造或更改这些关系。';
}
