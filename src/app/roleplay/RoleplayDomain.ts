/**
 * RoleplayDomain — 角色扮演域统一入口
 *
 * 🔴 架构铁律：
 *   - 所有查询走主系统标准接口（约束1）
 *   - Layer1+Layer2 会话缓存（约束2）
 *   - 双标签数据隔离 source=roleplay + roleplay_id（约束3）
 *   - 层级顺序不可逆（约束4）
 *   - 记忆严格控量（约束5）
 *   - 开关回退兜底（约束7）
 */
import type { DomainContext, CharacterClass, FourLayerData } from './types.js';
import { collectFourLayerData } from './FourLayerDataCollector.js';
import { assemblePrompt } from './PromptAssembler.js';
import { validateReply } from './Validator.js';
import { ConfigService } from '../../config/ConfigService.js';
import { checkReadiness } from './ReadinessGate.js';
import { clearSessionCache } from './RoleplaySessionCache.js';
import { reportAssembly, reportValidation, reportGrowth } from './RoleplayProbeReporter.js';
import { buildRoleplayRules } from './bridges.js';

// 🔴 运行时检测：ESM 模块级代码在 .env 加载前执行，必须用函数而非常量
function isStructuredEnabled(): boolean {
  return ConfigService.getBool("ROLEPLAY_STRUCTURED_ENABLED");
}
export { isStructuredEnabled };

interface DomainState {
  roleplay: string | null;
  sessionId: string | null;
  turnCounter: number;
}

let _state: DomainState = { roleplay: null, sessionId: null, turnCounter: 0 };

export function getDomainStatus() {
  return { roleplay: _state.roleplay, structured: isStructuredEnabled(), turns: _state.turnCounter };
}

export function clearCache(): void {
  _state = { roleplay: null, sessionId: null, turnCounter: 0 };
  clearSessionCache();
}

/**
 * 运行角色扮演管线
 * 返回装配后的 knowledgeBaseText（以【角色扮演】开头）
 */
export async function runRoleplayPipeline(
  ctx: DomainContext,
  message: string,
  dna: any,
): Promise<string> {
  const roleplay = ctx.currentRoleplay;
  if (!roleplay) return '';

  _state.roleplay = roleplay;
  _state.turnCounter++;

  // 🔴 运行时检测（ESM 安全）
  const _enabled = isStructuredEnabled();
  console.log('[RoleplayDomain] runRoleplayPipeline: role=' + roleplay + ' structured=' + _enabled + ' env=' + ConfigService.get("ROLEPLAY_STRUCTURED_ENABLED"));
  if (!_enabled) {
    return buildRoleplayRules(roleplay) + '\n' + `【当前身份】${roleplay} — 你不是玉瑶，不是任何其他人。忘记你原来叫玉瑶。`;
  }

  const _t0 = Date.now();

  // ═══ 七路采集 → 四层装配 ═══
  const data: FourLayerData = await collectFourLayerData(
    ctx, message, roleplay, ctx.characterClass as CharacterClass, ctx.currentRPBranch as any,
  );

  // ═══ 就绪门（修复4：传入解析实体，检测未知亲属） ═══
  const queryEntities = [...data.parsedEntities, ...data.parsedKinshipTerms, ...(message.match(/[一-龥]{2,4}/g) || [])];
  const readiness = checkReadiness(data, queryEntities);

  // ═══ 提示词装配（修复4：就绪门约束注入） ═══
  const knowledgeBaseText = assemblePrompt({
    roleplay,
    data,
    // readiness removed from AssembleInput in v4.0

    styleInstruction: ctx.rpParamsSnapshot?.buildStyleInstruction?.(roleplay) || '',
  });

  // ═══ 探针上报 ═══
  const _t1 = Date.now();
  reportAssembly(_t1 - _t0, {
    layer1: data.layer1.identityText.length,
    layer2: data.layer2.relationText.length,
    layer3: data.layer3.memoryText.length,
    layer4: data.layer4.knowledgeText.length,
  });
  reportGrowth(_state.turnCounter);

  return knowledgeBaseText;
}

/**
 * 生成后校验（供 chat.ts 在 LLM 回复后调用）
 */
export async function afterGenerate(
  ctx: DomainContext,
  message: string,
  reply: string,
  storage: any,
): Promise<void> {
  const roleplay = ctx.currentRoleplay;
  if (!roleplay || !isStructuredEnabled()) return;

  // 重新采集数据供校验（首轮已验证的Layer1+Layer2从缓存读取）
  try {
    const data = await collectFourLayerData(
      ctx, message, roleplay, ctx.characterClass as CharacterClass, ctx.currentRPBranch as any,
    );

    const validation = validateReply(reply, data, roleplay);

    // 探针上报
    if (validation.severity !== 'pass') {
      for (const issue of validation.issues) {
        if (issue.startsWith('[ERR]')) reportValidation('identity', false, issue);
        else if (issue.includes('数字') || issue.includes('事实')) reportValidation('fact', false, issue);
        else reportValidation('boundary', false, issue);
      }
    } else {
      reportValidation('identity', true);
      reportValidation('fact', true);
      reportValidation('boundary', true);
    }
  } catch { /* 校验不阻塞回复 */ }
}
