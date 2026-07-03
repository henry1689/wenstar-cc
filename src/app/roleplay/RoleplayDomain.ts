/**
 * RoleplayDomain — 角色扮演域统一入口
 *
 * chat.ts 唯一调用点，接管所有角色扮演的持续扮演逻辑。
 * 内部调用七路采集 + 四层装配 → LLM Generate → 验证
 *
 * 🔴 铁律：
 *   - 约束1：所有查询走主系统标准接口
 *   - 约束2：Layer1+Layer2 会话缓存
 *   - 约束4：层级顺序不可逆
 *   - 约束7：有开关回退兜底
 */
import type { DomainContext, CharacterClass } from './types.js';
import { collectData, type FourLayerData } from './DataCollector.js';
import { assemblePrompt } from './PromptAssembler.js';
import { buildRoleplayRules } from './RoleplayPromptBuilder.js';
import { syncRPConversation, generateRPId, type RPWriteInput } from './RoleplayMemorySync.js';
import { updateTempProfile, tryPromoteProfile } from './RoleplayProfileManager.js';
import { initSessionCache, setLayer1, setLayer2, hasLayer1, hasLayer2, clearCache as clearSessionCache } from './RoleplaySessionCache.js';

// ─── 开关（约束7） — 默认关闭，环境变量开启
const STRUCTURED_ENABLED = process.env['ROLEPLAY_STRUCTURED_ENABLED'] === 'true';
console.log(`[RoleplayDomain] 四层结构化装配: ${STRUCTURED_ENABLED ? '已开启' : '已关闭（旧逻辑）'}`);

// ─── 模块级状态 ───
let _cachedRoleplay: string | null = null;
let _activeSessionId: string | null = null;
let _seqCounter = 0;

export function getDomainStatus() {
  return { roleplay: _cachedRoleplay, structured: STRUCTURED_ENABLED };
}
export function clearCache(): void {
  _cachedRoleplay = null;
  _activeSessionId = null;
  _seqCounter = 0;
  clearSessionCache();
}
export function getSessionId(): string | null { return _activeSessionId; }

/**
 * 运行角色扮演管线
 */
export async function runRoleplayPipeline(
  ctx: DomainContext,
  message: string,
  dna: any,
): Promise<string> {
  const roleplay = ctx.currentRoleplay;
  _cachedRoleplay = roleplay;
  if (!_activeSessionId) _activeSessionId = generateRPId();
  _seqCounter++;

  updateTempProfile(roleplay, message, '', _seqCounter);

  // 🔴 开关（约束7）：关闭时回退旧逻辑
  if (!STRUCTURED_ENABLED) {
    return buildRoleplayRules(roleplay, '');
  }

  // ═══ 七路采集 ═══
  const data: FourLayerData = await collectData(
    ctx, message, roleplay, ctx.characterClass as CharacterClass, ctx.currentRPBranch as any,
  );

  // ═══ 会话缓存（约束2） ═══
  if (!hasLayer1()) {
    initSessionCache(roleplay);
  }
  if (!hasLayer1() && data.layer1.identity) {
    setLayer1(data.layer1.identity);
  }
  if (!hasLayer2() && data.layer2.relations) {
    setLayer2(data.layer2.relations);
  }

  // ═══ 四层装配 ═══
  const knowledgeBaseText = assemblePrompt({
    roleplay,
    portrait: data.layer1.identity || `你是${roleplay}`,
    data,
    styleInstruction: ctx.rpParamsSnapshot?.buildStyleInstruction?.(roleplay) || '',
  });

  return knowledgeBaseText;
}

/**
 * 生成后处理：记忆同步（供 chat.ts 在 LLM 回复后调用）
 */
export async function afterGenerate(
  ctx: DomainContext,
  message: string,
  reply: string,
  storage: any,
): Promise<void> {
  const roleplay = ctx.currentRoleplay;
  if (!roleplay || !_activeSessionId) return;
  try {
    const input: RPWriteInput = {
      roleplayId: _activeSessionId,
      roleplayChar: roleplay,
      seqPos: _seqCounter * 2,
      message, reply,
    };
    await syncRPConversation(storage, input);
  } catch (_) {}
  updateTempProfile(roleplay, message, reply, _seqCounter);
}
