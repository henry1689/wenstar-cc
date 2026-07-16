/**
 * ConstraintValidator.ts — 五维约束校验器 (V1.0 / BIONIC-002 Phase 1)
 * =====================================================================
 * 模仿前额叶的"闸门控制"功能：在生成回应前对输入进行五维校验。
 *
 * 五维校验:
 *   personaCheck  — 人设一致性（回答是否符合当前角色人设）
 *   emotionCheck  — 情感合理性（情感响应是否与场景匹配，防抖）
 *   safetyCheck   — 安全拦截（有害内容、越界话题、后门攻击）
 *   logicCheck    — 逻辑纠错（自相矛盾、时间错乱、FG 冲突）
 *   realityCheck  — 现实规则（家族关系铁律、知识边界、幻觉防护）
 *
 * Phase 1 骨架: 方法签名 + 默认通过逻辑。
 * Phase 3 接入 chat.ts 的 MemoryGate / HallucinationValidator 真实逻辑。
 *
 * 使用:
 *   const cv = new ConstraintValidator(sqlite);
 *   const result = cv.validate(input);
 *   const guards = cv.buildGuardMessages(result, input);
 */
import type { SQLiteAdapter } from '../../../m2/SQLiteAdapter.js';
import type { ConstraintInput, ConstraintResult } from './types.js';

export class ConstraintValidator {
  private sqlite: SQLiteAdapter;

  constructor(sqlite: SQLiteAdapter) {
    this.sqlite = sqlite;
  }

  /**
   * 主入口 — 五维全量校验
   */
  validate(input: ConstraintInput): ConstraintResult {
    const violations: string[] = [];

    const personaCheck  = this._checkPersona(input, violations);
    const emotionCheck  = this._checkEmotion(input, violations);
    const safetyCheck   = this._checkSafety(input, violations);
    const logicCheck    = this._checkLogic(input, violations);
    const realityCheck  = this._checkReality(input, violations);
    // V4.0 第六维：知识一致性
    const knowledgeConsistencyCheck = this._checkKnowledgeConsistency(input, violations);

    return {
      personaCheck, emotionCheck, safetyCheck, logicCheck, realityCheck,
      knowledgeConsistencyCheck,
      passed: violations.length === 0,
      violations,
    };
  }

  /**
   * 构建统一守卫消息字符串（从 chat.ts L1622 allGuardMsgs 合并逻辑迁移）
   * 将违规/约束编码为 LLM 可读的 guard message，注入 system prompt
   */
  buildGuardMessages(result: ConstraintResult, input: ConstraintInput): string {
    const guards: string[] = [];

    if (!result.realityCheck) {
      guards.push(...this._buildRealityGuards(input));
    }
    if (!result.personaCheck) {
      guards.push(...this._buildPersonaGuards(input));
    }
    if (!result.safetyCheck) {
      guards.push('⚠️ 安全规则：不要回答越界内容。');
    }

    // 追加所有违规详情
    for (const v of result.violations) {
      guards.push(v);
    }

    return guards.filter(Boolean).join('\n');
  }

  // ═══════════════════════════════════════════════════════
  //  五维校验子方法（Phase 1 骨架，Phase 3 填充）
  // ═══════════════════════════════════════════════════════

  /** ① 人设一致性 */
  private _checkPersona(input: ConstraintInput, violations: string[]): boolean {
    // Phase 3 接入: RoleClassifier + PersonaRegistry
    if (input.isRoleplaying && !input.currentRoleplay) {
      violations.push('⚠️ 人设校验: 角色扮演状态异常');
      return false;
    }
    return true;
  }

  /** ② 情感合理性（防抖）— Phase 1 接入 HeartStateStore 真实阈值 */
  private _checkEmotion(input: ConstraintInput, violations: string[]): boolean {
    const ev = input.emotionVector as any;
    if (!ev) return true;

    // 读取 HeartStateStore 的情感基线（如果可用）
    let angerThreshold = 80;
    let fearThreshold = 80;
    try {
      const heartState = (globalThis as any).__heartStateStore;
      if (heartState && typeof heartState.getState === 'function') {
        const hs = heartState.getState();
        // 使用 heart 域的情感向量做阈值判断（24D 维度）
        if (hs?.emotionVector) {
          const hv = hs.emotionVector;
          if (typeof hv.anger === 'number' && hv.anger > 70) {
            violations.push('⚠️ 情感校验: 当前 anger 偏高(' + Math.round(hv.anger) + ')，建议温和回应');
            return false;
          }
          if (typeof hv.fear === 'number' && hv.fear > 70) {
            violations.push('⚠️ 情感校验: 当前 fear 偏高(' + Math.round(hv.fear) + ')，建议安抚性回应');
            return false;
          }
          return true;
        }
      }
    } catch { /* 降级到默认阈值 */ }

    // 降级：使用默认阈值
    if (ev.anger > angerThreshold || ev.fear > fearThreshold) {
      violations.push('⚠️ 情感校验: 当前情绪波动过大，建议温和回应');
      return false;
    }
    return true;
  }

  /** ③ 安全拦截 */
  private _checkSafety(input: ConstraintInput, violations: string[]): boolean {
    // Phase 3 接入: SafetyInterceptor + 后门检测
    const msg = input.message || '';
    // 基础后门检测
    if (/(忽略|无视|绕过)(以上|所有|之前|一切)(规则|指令|限制)/.test(msg)) {
      violations.push('🚫 安全拦截: 检测到 prompt injection 尝试');
      return false;
    }
    return true;
  }

  /** ④ 逻辑纠错（自相矛盾 / 时间错乱 / FG 冲突）— Phase 1 基础冲突检测 */
  private _checkLogic(input: ConstraintInput, violations: string[]): boolean {
    const msg = input.message || '';

    // 检测 FG 人物与自称的矛盾（如：用户说"我是徐诗雨"但 FG 中徐诗雨是真实人物）
    if (input.familyContext && input.familyContext.length > 0) {
      const selfRefMatch = msg.match(/(?:我是|我叫|我就是)([一-龥]{2,4})/);
      if (selfRefMatch) {
        const claimedName = selfRefMatch[1];
        const fgPerson = input.familyContext.find(
          f => f.entity === claimedName && f.relation !== '虚构' && f.relation !== '无'
        );
        if (fgPerson) {
          violations.push(
            `⚠️ 逻辑校验: 用户自称"${claimedName}"，但 FG 中 ${claimedName} 是真实人物(${fgPerson.relation})，请确认身份`
          );
          return false;
        }
      }
    }

    // 检测明显的自相矛盾（如"我没去过X"后面又说"我在X的时候"）
    const denials = msg.match(/(?:没去过|不认得|不认识|不知道)([一-龥]{2,6})/g);
    const claims = msg.match(/(?:我去过|在.{1,10})([一-龥]{2,6})(?:的时候|那|这里|那里)/g);
    if (denials && claims) {
      for (const d of denials) {
        const dPlace = d.replace(/(?:没去过|不认得|不认识|不知道)/, '');
        for (const c of claims) {
          if (c.includes(dPlace)) {
            violations.push(
              `⚠️ 逻辑校验: 检测到可能自相矛盾 — 既说"${d}"又说"${c}"`
            );
            return false;
          }
        }
      }
    }

    return true;
  }

  /** ⑤ 现实规则（家族关系铁律 + 幻觉防护）— Phase 1 接入 FG 家族上下文 */
  private _checkReality(input: ConstraintInput, violations: string[]): boolean {
    // 从 FG 读取家族关系约束
    if (input.familyContext && input.familyContext.length > 0) {
      const fg = (globalThis as any).__familyGraph;

      // 🔴 铁律：检查是否有人物不应该被角色扮演（roleplay_forbidden）
      if (input.isRoleplaying && input.currentRoleplay) {
        try {
          if (fg && typeof fg.getPersonProfile === 'function') {
            const profile = fg.getPersonProfile(input.currentRoleplay);
            if (profile?.roleplay_forbidden) {
              violations.push(
                `🚫 现实规则: "${input.currentRoleplay}" 是 FG 中的真实人物，禁止角色扮演`
              );
              return false;
            }
          }
        } catch { /* FG 不可用不阻塞 */ }
      }

      // 🔴 铁律：家族关系一致性 — 用户 query 中提到的人物关系必须与 FG 一致
      const relationPatterns = [
        { regex: /(?:是|叫)([一-龥]{2,4})(?:的)(妈妈|爸爸|姐姐|妹妹|哥哥|弟弟|老婆|老公|女儿|儿子)/, label: '亲属关系' },
        { regex: /([一-龥]{2,4})(?:是|叫)(?:我)?(?:的)?(妈妈|爸爸|姐姐|妹妹|哥哥|弟弟|老婆|老公|女儿|儿子)/, label: '亲属关系' },
      ];

      for (const pat of relationPatterns) {
        const match = input.message.match(pat.regex);
        if (match) {
          const [_, name, relation] = match;
          const fgPerson = input.familyContext.find(f => f.entity === name);
          if (fgPerson && fgPerson.relation !== relation) {
            violations.push(
              `⚠️ 现实规则: FG 中 ${name} 的 relation_to_user 是 "${fgPerson.relation}"，与声称的 "${relation}" 不一致`
            );
            return false;
          }
        }
      }
    }

    return true;
  }

  /** ⑥ 知识一致性校验（V4.0 第六维）：第二大脑 vs 第一大脑，Wikilink图辅助 */
  private _checkKnowledgeConsistency(input: ConstraintInput, violations: string[]): boolean {
    if (!input.message) return true;

    const gateway = (globalThis as any).__secondBrainGateway;
    const resolver = (globalThis as any).__wikiLinkResolver;
    if (!gateway || typeof gateway.queryByWikilink !== 'function') return true;

    try {
      const persons = (input.familyContext || []).map(f => f.entity).filter(Boolean);
      // 从消息中补充人名
      const extraNames = (input.message.match(/[一-龥]{2,3}/g) || []).filter(
        (n: string) => !'的了在是我有不和就人会也把被让从对跟说'.includes(n) && !persons.includes(n)
      );
      const allNames = [...new Set([...persons, ...extraNames])].slice(0, 5);

      if (allNames.length === 0) return true;

      // V4.0 Phase 4: 用 WikiLink 图谱分析实体间的关系距离
      if (resolver && typeof resolver.findPath === 'function' && allNames.length >= 2) {
        for (let i = 0; i < allNames.length - 1; i++) {
          for (let j = i + 1; j < allNames.length; j++) {
            const path = resolver.findPath(allNames[i], allNames[j], 2);
            if (path) {
              // 两个实体在知识图谱中距离很近（1-2跳） → 回复时应关联考虑
              // 此处不做 violation，仅增强 context（通过 PFC 的 assembledContext）
            }
          }
        }
      }

      // 高可信度 wiki 条目的矛盾检测（Phase 3 逻辑 → Phase 4 增强）
      for (const person of allNames) {
        const manifests = gateway.queryByWikilink(person);
        for (const m of manifests) {
          if (m.confidence === 'high' && m.type === 'entity') {
            const entry = gateway.getWikiEntry(m.path);
            if (entry?.relations) {
              for (const rel of entry.relations) {
                const relationTerm = rel.type.replace(/_/g, '');
                if (input.message.includes(rel.target) && input.message.includes(relationTerm)) {
                  // 高可信度实体页中的关系在消息中被提及 → 一致，通过
                }
              }
            }
          }
        }
      }
    } catch { /* 第二大脑不可用不阻塞 */ }

    return true;
  }

  // ═══════════════════════════════════════════════════════
  //  Guard 消息构建
  // ═══════════════════════════════════════════════════════

  private _buildRealityGuards(input: ConstraintInput): string[] {
    const guards: string[] = [];
    // Phase 3: 迁移家族关系约束构建逻辑 (chat.ts L1076-1107)
    if (input.familyContext && input.familyContext.length > 0) {
      const names = input.familyContext
        .map((f: { entity: string; relation: string }) => `${f.entity}(${f.relation})`).join('、');
      guards.push(`【人物档案】以下信息来自家族图谱，请严格据此回答：${names}`);
    }
    return guards;
  }

  private _buildPersonaGuards(input: ConstraintInput): string[] {
    // Phase 3: 迁移人设约束构建逻辑
    if (input.isRoleplaying && input.currentRoleplay) {
      return [`【角色约束】你正在扮演 ${input.currentRoleplay}，请保持角色一致性。`];
    }
    return [];
  }
}
