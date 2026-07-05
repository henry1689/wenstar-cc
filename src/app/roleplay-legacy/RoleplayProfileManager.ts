/**
 * RoleplayProfileManager — 角色扮演域·三阶生长（阶段2-2）
 *
 * 针对没有预设档案的角色，自动经历临时建档→转正→持续丰满的生长路径。
 *
 * ── 三阶规则 ──
 * 第一阶：临时建档期（0~5轮互动）— 临时表，不入主图谱
 * 第二阶：自动转正期（≥5轮+≥8信息点）— 写入 FamilyGraph 主表
 * 第三阶：持续丰满期 — 每轮自动提取更新
 *
 * 🔴 边界：
 *   - 所有自动提取信息必须来自用户明确表达过的内容
 *   - 所有字段带「来源对话」标记
 *   - 核心人设变更必须有用户明确指令
 */
import crypto from 'node:crypto';
import type { FamilyGraphRoleBranch } from '../alignment/FamilyGraphRoleBranch.js';

/** 配置参数 */
export const RP_PROFILE_CONFIG = {
  probationTurns: 5,
  minInfoPoints: 8,
  maxTempChars: 20,
  autoPromote: true,
};

/** 信息点来源 */
export interface InfoSource {
  field: string;
  value: string;
  dialogSeq: number;
  originalText: string;
  confidence: number;
}

/** 临时角色档案 */
export interface TempProfile {
  name: string;
  infoPoints: InfoSource[];
  turnCount: number;
  stage: 'probation' | 'promoted' | 'mature';
  lastUpdated: string;
  dialogGroupId: string;
}

/** FamilyGraph 接口（最小依赖） */
export interface FGProfileAPI {
  getPersonProfile(name: string): Record<string, any> | null;
  addNode?(node: { id: string; type: string; name: string; properties: Record<string, any> }): Promise<void>;
  addPersonRelation?(src: string, rel: string, tgt: string, ctx?: string): Promise<void>;
  updateNodeProperties?(name: string, props: Record<string, any>): Promise<void>;
  updatePersonProfile?(name: string, updates: Record<string, any>): Promise<void>;
}

// ─── 域内临时档案存储（内存，跨轮次持久化） ───

const _tempProfiles = new Map<string, TempProfile>();

/** 获取或创建临时角色档案 */
export function getOrCreateTempProfile(charName: string): TempProfile {
  let p = _tempProfiles.get(charName);
  if (!p) {
    p = {
      name: charName,
      infoPoints: [],
      turnCount: 0,
      stage: 'probation',
      lastUpdated: new Date().toISOString(),
      dialogGroupId: `rp_temp_${Date.now().toString(36)}`,
    };
    _tempProfiles.set(charName, p);
    console.log(`[RPProfile] 临时建档: ${charName}`);
  }
  return p;
}

/** 获取临时档案 */
export function getTempProfile(charName: string): TempProfile | null {
  return _tempProfiles.get(charName) ?? null;
}

/** 删除临时档案 */
export function deleteTempProfile(charName: string): void {
  _tempProfiles.delete(charName);
}

/** 清空所有临时档案 */
export function clearAllTempProfiles(): void {
  _tempProfiles.clear();
}

/** 获取临时档案总数 */
export function getTempProfileCount(): number {
  return _tempProfiles.size;
}

/**
 * 从对话中提取信息点并更新档案
 */
export function extractInfoPoints(
  charName: string,
  message: string,
  reply: string,
  seqPos: number,
): InfoSource[] {
  const sources: InfoSource[] = [];
  const tag = charName;

  // 年龄：诗韵才14岁 / 诗韵14岁 / 诗韵今年14
  const ageM = message.match(new RegExp(`${tag}[，, ]*(?:才|刚|今年|现在|已经|只有)?(\\d{1,2})岁`));
  if (ageM) {
    sources.push({
      field: 'age', value: ageM[1] + '岁',
      dialogSeq: seqPos, originalText: ageM[0], confidence: 0.9,
    });
  }

  // 关系：诗韵是XX / 诗韵是XX的XXX
  const relM = message.match(new RegExp(`${tag}是(?:我|你|他|她)的?([一-龥]{1,4})`));
  if (relM) {
    sources.push({
      field: 'relation', value: relM[2],
      dialogSeq: seqPos, originalText: relM[0], confidence: 0.85,
    });
  }

  // 身份/职业
  const idM = message.match(new RegExp(`${tag}是(?:个|名|位)([一-龥]{2,6}(?:生|员|师|工|手|家))`));
  if (idM) {
    sources.push({
      field: 'occupation', value: idM[1],
      dialogSeq: seqPos, originalText: idM[0], confidence: 0.8,
    });
  }

  // 外貌
  const apM = message.match(new RegExp(`${tag}(?:长[得地]很|很|看起来)([一-龥]{2,4})`));
  if (apM) {
    sources.push({
      field: 'appearance', value: apM[1],
      dialogSeq: seqPos, originalText: apM[0], confidence: 0.6,
    });
  }

  return sources;
}

/**
 * 更新临时档案（提取信息点+轮次+判断是否可转正）
 */
export function updateTempProfile(
  charName: string,
  message: string,
  reply: string,
  seqPos: number,
): TempProfile {
  const profile = getOrCreateTempProfile(charName);
  profile.turnCount++;
  profile.lastUpdated = new Date().toISOString();

  // 提取新信息点
  const newPoints = extractInfoPoints(charName, message, reply, seqPos);
  for (const np of newPoints) {
    // 去重：已有相同 field 的不再追加
    const exist = profile.infoPoints.find(p => p.field === np.field);
    if (!exist) profile.infoPoints.push(np);
  }

  return profile;
}

/**
 * 检查是否可以转正，并执行转正
 */
export async function tryPromoteProfile(
  charName: string,
  fg: FGProfileAPI | null,
): Promise<boolean> {
  const profile = _tempProfiles.get(charName);
  if (!profile || profile.stage !== 'probation') return false;
  if (!RP_PROFILE_CONFIG.autoPromote) return false;

  const canPromote = profile.turnCount >= RP_PROFILE_CONFIG.probationTurns &&
    profile.infoPoints.length >= RP_PROFILE_CONFIG.minInfoPoints;

  if (!canPromote) return false;
  if (!fg) return false;

  // ── 执行转正：写入 FG ──
  try {
    // 先检查 FG 中是否已有
    const exist = fg.getPersonProfile(charName);

    // 构建属性
    const props: Record<string, any> = { name: charName, last_mentioned: new Date().toISOString(), mention_count: 1 };
    for (const ip of profile.infoPoints) {
      props[ip.field] = ip.value;
    }

    if (!exist && fg.addNode) {
      await fg.addNode({
        id: crypto.randomUUID(),
        type: 'person',
        name: charName,
        properties: { ...props, source: 'roleplay', is_roleplay: 1 },
      });
      await fg.addPersonRelation?.(charName, 'acquaintance_of', '我', '角色扮演自动建档');
    } else if (fg.updatePersonProfile) {
      await fg.updatePersonProfile(charName, { ...props, source: 'roleplay', is_roleplay: 1 });
    }

    profile.stage = 'promoted';
    console.log(`[RPProfile] ✅ 转正成功: ${charName} (${profile.infoPoints.length}信息点, ${profile.turnCount}轮)`);
    return true;
  } catch (err) {
    console.error(`[RPProfile] ❌ 转正失败: ${charName}`, (err as Error).message);
    return false;
  }
}

/**
 * 获取角色完整信息概要（供 DataCollector/ReadinessGate 使用）
 */
export function getProfileSummary(charName: string): {
  profile: TempProfile | null;
  isTemp: boolean;
} {
  const profile = _tempProfiles.get(charName) ?? null;
  return { profile, isTemp: profile?.stage === 'probation' };
}
