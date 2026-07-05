/**
 * FourLayerDataCollector — 四层数据采集器（串行五层截断版）
 *
 * v4.0 重构：从并行7路改为五层串行截断
 *   L1: 实时上下文 → 有结果直接截断
 *   L2: 砂金→金库→黑钻 → 有亲属结果截断
 *   L3: 实体拓扑递归 → 顺藤摸瓜跨实体查询
 *   L4: 知识库 → 标准化称谓
 *   L5: LLM门控 → hasValidRelation 控制编造
 */
import type { DomainContext, CharacterClass } from './types.js';
import type { FamilyGraphRoleBranch } from '../alignment/FamilyGraphRoleBranch.js';
import type { FourLayerData, PersonStructProfile, Layer1Data, Layer2Data, Layer3Data, Layer4Data, MemoryEntry } from './types.js';
import { generateRoleplayId } from './types.js';
import { FamilyGraphAdapter } from './FamilyGraphAdapter.js';
import type { FullClueResult } from '../../m4/MemoryRetriever.js';

const COLLECT_TIMEOUT = 3000;
const MAX_SAND = 10;
const MAX_VAULT = 8;
const MAX_DIAMOND = 5;
const MAX_KB = 3;

const withTimeout = <T>(p: Promise<T>, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>(r => setTimeout(() => r(fallback), COLLECT_TIMEOUT))]);

export async function collectFourLayerData(
  ctx: DomainContext,
  message: string,
  roleplay: string,
  characterClass: CharacterClass,
  rpBranch: FamilyGraphRoleBranch | null,
): Promise<FourLayerData> {
  const roleplayId = generateRoleplayId();
  const fg = ctx.m4?.getFamilyGraph?.();
  const fgAdapter = fg ? new FamilyGraphAdapter(fg, roleplayId) : null;

  // ═══ 串行5层检索 ═══
  let clueResult: FullClueResult | null = null;
  try {
    if (ctx.storage) {
      const { MemoryRetriever } = await import('../../m4/MemoryRetriever.js');
      const retriever = new MemoryRetriever(ctx.storage as any);
      clueResult = await withTimeout(
        retriever.retrieveFullClue(roleplay, message, null, true),
        null as any,
      );
    }
  } catch {}
  if (clueResult) {
    console.log('[Roleplay] 串行: layers=' + clueResult.layersUsed.join('-') + ' rel=' + clueResult.hasValidRelation + ' topo=' + clueResult.l3Topology.length);
  }

  // ── Layer1: 核心身份 ──
  const selfProfile = fgAdapter?.getPersonProfile(roleplay) || null;
  const layer1 = buildLayer1(roleplay, selfProfile);

  // ── Layer2: 关系（来自FG + 拓扑） ──
  const relativeResult = await withTimeout(
    fgAdapter?.listRelativeProfiles(roleplay, 1, rpBranch)
      ?? Promise.resolve({ rootProfile: { name: roleplay, hasProfile: false, knownFields: {} } as PersonStructProfile, relatives: [] as PersonStructProfile[], knownFields: {} as Record<string, boolean> }),
    { rootProfile: { name: roleplay, hasProfile: false, knownFields: {} } as PersonStructProfile, relatives: [] as PersonStructProfile[], knownFields: {} as Record<string, boolean> },
  );

  // 🔴 入口级二次校验
  if (rpBranch) {
    const validNames = new Set<string>([roleplay, ...(rpBranch.getAllNames?.() || [])]);
    relativeResult.relatives = relativeResult.relatives.filter(r =>
      validNames.has(r.name) || rpBranch.isInFamily?.(r.name)
    );
  }

  const layer2 = buildLayer2(
    roleplay, relativeResult.relatives, rpBranch, {},
    undefined, undefined,
    clueResult?.l3Topology || [],
  );

  // ── Layer3: 记忆（串行结果） ──
  const sandEntries: MemoryEntry[] = (clueResult?.l2Sand || []).map((t, i) => ({
    id: `sand_${i}`, text: '👤对方：' + t, source: 'sand' as const, score: 0.5, created_at: '',
  }));
  const vaultEntries: MemoryEntry[] = (clueResult?.l2Vault || []).map((t, i) => ({
    id: `vault_${i}`, text: t, source: 'vault' as const, score: 0.7, created_at: '',
  }));
  const diamondEntries: MemoryEntry[] = (clueResult?.l2Diamond || []).map((t, i) => ({
    id: `diamond_${i}`, text: '【珍藏记忆】' + t, source: 'black_diamond' as const, score: 1.0, created_at: '',
  }));
  const layer3 = buildLayer3(sandEntries, vaultEntries, diamondEntries);

  // ── Layer4: 知识库 ──
  const layer4 = buildLayer4([]);

  // ── L5门控标记 ──
  const hasRelation = clueResult?.hasValidRelation || false;

  return {
    layer1, layer2, layer3, layer4,
    parsedEntities: [],
    parsedKinshipTerms: [],
    kinshipToName: {},
    hasValidRelation: hasRelation,
    roleplayId,
    source: 'roleplay',
  };
}

// ─── Layer1: 第一人称自传体 ───
function buildLayer1(roleplay: string, profile: PersonStructProfile | null): Layer1Data {
  const knownFields: Record<string, boolean> = profile?.knownFields ?? {};
  const lines: string[] = [];
  lines.push('【我自己知道的】');
  if (profile && profile?.hasProfile) {
    const facts: string[] = [];
    facts.push('我叫' + profile.name);
    if (profile?.age !== undefined) facts.push('今年' + profile.age + '岁');
    if (profile?.occupation) facts.push('是' + profile?.occupation);
    lines.push(facts.join('，') + '。');
    if ((profile?.traits?.length ?? 0) > 0) lines.push('我的性格：' + profile.traits!.join('、') + '。');
    if (profile?.appearance) lines.push('我的外貌：' + profile?.appearance + '。');
    if (profile?.birth) lines.push('我的生日：' + profile?.birth + '。');
    if (profile?.description) lines.push('其他人对我的描述：' + profile?.description + '。');
  } else {
    lines.push('我叫' + roleplay + '。');
  }
  return { roleplay, profile, knownFields, identityText: lines.join('\n') };
}

// ─── Layer2: 第一人称关系（含拓扑链路） ───
function buildLayer2(
  roleplay: string,
  relatives: PersonStructProfile[],
  rpBranch: FamilyGraphRoleBranch | null,
  kinshipToName: Record<string, string>,
  _getCircleLevel?: (n: string) => number,
  _getIntimacy?: (a: string, b: string) => number,
  l3Topology?: Array<{ rootId: string; targetId: string; relation: string; chainPath: string; level: number }>,
): Layer2Data {
  const lines: string[] = ['【我的家人】'];
  const relLabel: Record<string, string> = {
    mother_of: '妈妈', father_of: '爸爸', spouse_of: '配偶',
    sibling_of: '姐妹/兄弟', child_of: '孩子', parent_of: '父母',
    aunt_of: '姑姑', cousin_of: '表亲', niece_of: '侄女',
  };

  for (const rel of relatives) {
    const label = rel.relation ? (relLabel[rel.relation] || rel.relation) : (rel.relation_to_user || '亲人');
    let desc = label + '：' + rel.name;
    if (rel.age !== undefined) desc += '，' + rel.age + '岁';
    if (rel.occupation) desc += '，' + rel.occupation;
    if ((rel.traits?.length ?? 0) > 0) desc += '，性格' + rel.traits!.join('、');
    lines.push('· 我的' + desc);
  }

  // 拓扑链路（结构化注入）
  if (l3Topology && l3Topology.length > 0) {
    lines.push('');
    lines.push('【亲属拓扑链路】');
    for (const t of l3Topology) {
      lines.push('  ' + t.chainPath + ' → ' + t.relation);
    }
  }

  return {
    relatives,
    relationText: lines.join('\n'),
    kinshipToName,
  };
}

function buildLayer3(sand: MemoryEntry[], vault: MemoryEntry[], diamond: MemoryEntry[]): Layer3Data {
  const parts: string[] = [];
  if (diamond.length > 0) parts.push('【珍藏回忆】\n' + diamond.map(d => d.text).join('\n'));
  if (sand.length > 0) parts.push('【近期互动】\n' + sand.map(s => s.text).join('\n'));
  if (vault.length > 0) parts.push('【过往记忆】\n' + vault.map(v => v.text).join('\n'));
  return { sandMemories: sand, vaultMemories: vault, diamondMemories: diamond, memoryText: parts.join('\n\n') };
}

function buildLayer4(_entries: Array<{ title: string; content: string; score: number }>): Layer4Data {
  return { kbEntries: [], knowledgeText: '' };
}
