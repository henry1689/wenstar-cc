/**
 * RoleplayDomain — 角色扮演域统一入口
 *
 * chat.ts 唯一调用点，接管所有角色扮演的持续扮演逻辑。
 * 内部调用五步管线：DataCollector → ReadinessGate → PromptAssembler → LLM Generate → Validator
 *
 * 🔴 铁律：
 *   - 此文件是 chat.ts 与角色扮演域的唯一接口
 *   - 所有角色扮演相关逻辑迁移至此域内
 *   - chat.ts 只保留入口检测和本函数的调用
 */
import type { CollectedData, ReadinessDecision, PipelineOutput, DomainContext, CharacterClass } from './types.js';
import { collectData, classifyIntent } from './DataCollector.js';
import { checkReadiness } from './ReadinessGate.js';
import { assemblePrompt } from './PromptAssembler.js';
import { validateReply } from './Validator.js';
import { assembleCharacterPortrait, scanContextForCharacter } from './CharacterProfileScanner.js';
import type { FamilyGraphRoleBranch } from '../alignment/FamilyGraphRoleBranch.js';

// ─── 模块级缓存（跨轮次持久化） ───

let _cachedPortrait: string | null = null;
let _cachedRoleplay: string | null = null;

/** 获取当前缓存状态（供 chat.ts 健康检查读取） */
export function getDomainStatus(): { roleplay: string | null; hasPortrait: boolean } {
  return { roleplay: _cachedRoleplay, hasPortrait: !!_cachedPortrait };
}

/** 清除缓存（退出角色扮演时调用） */
export function clearCache(): void {
  _cachedPortrait = null;
  _cachedRoleplay = null;
}

/** 设置缓存（角色激活时从 chat.ts 传入已构建的画像） */
export function setCachedPortrait(portrait: string, roleplay: string): void {
  _cachedPortrait = portrait;
  _cachedRoleplay = roleplay;
}

/**
 * 运行角色扮演管线（持续扮演每轮调用一次）
 *
 * @returns 装配好的 knowledgeBaseText（如字符串）或 PipelineOutput
 */
export async function runRoleplayPipeline(
  ctx: DomainContext,
  currentRPBranch: FamilyGraphRoleBranch | null,
): Promise<PipelineOutput> {
  const roleplay = ctx.currentRoleplay;
  _cachedRoleplay = roleplay;

  // ═══ 第一步：数据采集 ═══
  const collectedData: CollectedData = await collectData(
    ctx, ctx.message, roleplay, ctx.characterClass, currentRPBranch,
  );

  // ═══ 画像装配（仅首次，之后读取缓存） ═══
  if (!_cachedPortrait) {
    let portrait = assembleCharacterPortrait(roleplay, {
      fgContext: collectedData.fg.treeText,
      kbContext: collectedData.kb.length > 0
        ? collectedData.kb.map(k => `\u{1f4c4} ${k.title}\n${k.content}`).join('\n\n')
        : undefined,
      historyContext: collectedData.history.length > 0
        ? collectedData.history.map(h => h.content).join('\n')
        : undefined,
      contextExtract: undefined,
    });

    // 锁年龄
    try {
      const fg = ctx.m4?.getFamilyGraph?.();
      if (fg) {
        const pf = fg.getPersonProfile(roleplay);
        if (pf?.age && !portrait.includes('【年龄】')) {
          portrait += `\n\n【年龄】${roleplay}今年${pf.age}岁。`;
        }
      }
    } catch (_) {}
    if (!portrait.includes('【年龄】')) {
      const ht = ctx.conversationHistory.slice(-20).map(t => t.content).join(' ');
      const hm = ht.match(new RegExp(roleplay + '.*?(\\d{1,2})岁'));
      if (hm) {
        portrait += `\n\n【年龄】${roleplay}今年${hm[1]}岁。`;
      }
    }
    if (!portrait.includes('【年龄】')) {
      portrait += '\n\n【年龄】⚠️ 你没有关于自己年龄的信息。如果有人问年龄，说"你没告诉过我，我不确定"。绝对禁止编造年龄。';
    }

    _cachedPortrait = portrait;
  }

  // ═══ 第二步：就绪门判定 ═══
  const readiness = checkReadiness(collectedData);

  // ═══ 第三步：提示词装配 ═══
  const knowledgeBaseText = assemblePrompt({
    roleplay,
    portrait: _cachedPortrait,
    data: collectedData,
    readiness,
    styleInstruction: ctx.rpParamsSnapshot?.buildStyleInstruction?.(roleplay) || '',
  });

  // ═══ 第四步：LLM 生成（在 chat.ts 中执行，此处返回装配结果） ═══
  // ═══ 第五步：验证（在 chat.ts 中调用 validateReply） ═══
  const validation = { pass: true, issues: [], severity: 'pass' as const, fix: 'none' as const };

  return {
    knowledgeBaseText,
    portrait: _cachedPortrait,
    collectedData,
    readiness,
    validation,
  };
}
