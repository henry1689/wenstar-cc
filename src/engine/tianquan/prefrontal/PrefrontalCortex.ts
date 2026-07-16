/**
 * PrefrontalCortex.ts — 前额叶决策皮层 (V1.0 / BIONIC-002 Phase 1)
 * ==================================================================
 * 全域唯一顶层指挥中心。接收 SceneSnapshot，编排五子模块，产出 PrefrontalDirective。
 *
 * 仿生编排流程（WS-TIANQUAN-BIONIC-001 §第三部分）:
 *   ① WorkingMemory.load(snapshot)          — 加载到"思维桌面"
 *   ② GoalStack.setImmediate(intent)        — 解析当前意图
 *   ③ ConstraintValidator.validate(input)   — 五维约束校验
 *   ④ DirectiveGenerator.generate(...)       — 编码执行指令
 *   ⑤ afterResponse(...)                     — 运算结束清空 + 复盘
 *
 * 硬性职责边界:
 *   - 禁止生成场景、渲染画面、调取底层记忆素材
 *   - 禁止存储海量会话/知识/时序原始数据
 *   - 仅存放目标栈、约束规则、短时工作内存
 *
 * 使用:
 *   const cortex = new PrefrontalCortex(wm, gs, cv, dg, mc);
 *   const output = await cortex.process({ snapshot, sessionId, rawInput: message });
 *   // ... M3/M4/M5 处理 ...
 *   await cortex.afterResponse(output.directive, outcome);
 */
import type { SceneSnapshot } from '../temporal/types.js';
import type {
  PrefrontalInput, PrefrontalOutput, PrefrontalDirective,
  ActualOutcome, MetacognitionSummary,
  ConstraintInput,
} from './types.js';
import type { M3Decision } from '../../../m3/types/perception.js';
import { WorkingMemory } from './WorkingMemory.js';
import { GoalStack } from './GoalStack.js';
import { ConstraintValidator } from './ConstraintValidator.js';
import { DirectiveGenerator } from './DirectiveGenerator.js';
import { MetacognitionReview } from './MetacognitionReview.js';

export class PrefrontalCortex {
  public readonly workingMemory: WorkingMemory;
  public readonly goalStack: GoalStack;
  public readonly constraintValidator: ConstraintValidator;
  public readonly directiveGenerator: DirectiveGenerator;
  public readonly metacognitionReview: MetacognitionReview;

  private bus: { emit: (event: any) => Promise<void> } | null = null;

  constructor(
    wm: WorkingMemory,
    gs: GoalStack,
    cv: ConstraintValidator,
    dg: DirectiveGenerator,
    mc: MetacognitionReview,
  ) {
    this.workingMemory = wm;
    this.goalStack = gs;
    this.constraintValidator = cv;
    this.directiveGenerator = dg;
    this.metacognitionReview = mc;
  }

  /**
   * 设置事件总线（可选注入，不阻塞主流程）
   */
  setEventBus(bus: { emit: (event: any) => Promise<void> }): void {
    this.bus = bus;
  }

  /**
   * 【主入口】处理单轮对话输入
   *
   * 编排流程:
   *   ① wm.load(snapshot)          — 加载到工作记忆
   *   ② goals.setImmediate(intent) — 设定即时意图
   *   ③ validator.validate(input)  — 五维约束校验
   *   ④ directiveGen.generate(...) — 生成执行指令
   */
  async process(
    input: PrefrontalInput,
    decision?: M3Decision | null,
  ): Promise<PrefrontalOutput> {
    // ① 加载场景快照到工作记忆
    this.workingMemory.load(input.snapshot);

    // ② 解析意图，设定即时目标
    const intent = this._inferIntent(input.rawInput);
    this.goalStack.setImmediate(intent);

    // ③ 构建约束输入并执行五维校验
    const constraintInput = this._buildConstraintInput(input);
    const constraints = this.constraintValidator.validate(constraintInput);

    // ④ 生成执行指令（使用传入的 decision 或默认值）
    const directive = this.directiveGenerator.generate(
      decision || this._defaultDecision(),
      constraints,
      this.goalStack.getState(),
    );

    // V4.0 Phase 3: 组装上下文 — 将 PFC 守卫消息 + 外部上下文块合并为 assembledContext
    const pfcGuards = this.constraintValidator.buildGuardMessages(constraints, constraintInput);
    if (pfcGuards) {
      directive.payload['guardMessages'] = pfcGuards;
    }
    // 合并外部上下文块（CoreMemory / 经验 / 情绪 / 时空），按 priority 降序排列
    if (input.contextBlocks && input.contextBlocks.length > 0) {
      const sorted = [...input.contextBlocks].sort((a, b) => b.priority - a.priority);
      directive.payload['assembledContext'] = sorted.map(b => b.content).join('\n\n');
    }

    // V4.0 Phase 2: 发布前额指令事件，打通 TianquanEventBus 正向流
    this.bus?.emit?.({
      type: 'prefrontal:directive_issued',
      traceId: `pfc_${Date.now().toString(36)}`,
      timestamp: Date.now(),
      sessionId: input.sessionId,
      payload: {
        directive,
        sourceModule: 'prefrontal',
        workingMemoryState: { activeSlots: this.workingMemory.activeCount, evictionPolicy: 'lru' },
      },
    }).catch(() => {});

    return {
      directive,
      wmState: this.workingMemory.getState(),
    };
  }

  /**
   * 构建约束校验所需的完整上下文
   */
  buildConstraintInput(input: PrefrontalInput): ConstraintInput {
    return this._buildConstraintInput(input);
  }

  /**
   * 构建统一守卫消息（供 chat.ts 替换 allGuardMsgs 合并逻辑）
   * (从 chat.ts L1622 迁移)
   */
  buildGuardMessages(input: ConstraintInput): string {
    const result = this.constraintValidator.validate(input);
    return this.constraintValidator.buildGuardMessages(result, input);
  }

  /**
   * 交互后复盘（由 chat.ts 在 M5 完成后调用）
   *   ① 元认知复盘（预测 vs 实际）
   *   ② 清空工作记忆
   *   ③ 可选推送梦境引擎
   */
  async afterResponse(
    directive: PrefrontalDirective,
    outcome: ActualOutcome,
  ): Promise<MetacognitionSummary> {
    const summary = this.metacognitionReview.review(directive, outcome);

    // 推送梦境引擎
    if (summary.worthSubmitting && this.bus) {
      await this.metacognitionReview.submitToDreamEngine(summary, this.bus).catch(() => {});
    }

    // 运算结束 → 清空工作记忆 + 重置即时意图
    this.workingMemory.clearAll();
    this.goalStack.clearImmediate();

    return summary;
  }

  /**
   * 角色路由（从 chat.ts L511-523 classifyRole + evaluateTransition 迁移）
   * Phase 3 接入真实的 RoleClassifier / TransitionManager
   */
  classifyCurrentRole(input: {
    message: string;
    perception: Record<string, number>;
    entities: Array<{ name: string; type: string }>;
    previousRole: string;
    previousTransitionState: Record<string, unknown>;
  }): { role: string; transitionState: Record<string, unknown> } {
    // Phase 3: 替换为真实的 RoleClassifier + TransitionManager 调用
    // 目前返回默认角色
    const role = input.previousRole || 'secretary';
    return {
      role,
      transitionState: {
        ...input.previousTransitionState,
        consecutiveIntimate: 0,
      },
    };
  }

  /**
   * 获取当前状态快照（供 API 查询）
   */
  getStatus(): Record<string, unknown> {
    const wmUsage = this.workingMemory.getUsageStats();
    return {
      workingMemory: {
        activeSlots: this.workingMemory.activeCount,
        capacity: this.workingMemory.capacity,
        // V4.0 Phase 3: 槽位利用率监控
        usage: {
          totalLoads: wmUsage.totalLoads,
          totalEvictions: wmUsage.totalEvictions,
          avgSlotLifetimeMs: wmUsage.avgSlotLifetimeMs,
          uptimeMs: wmUsage.uptimeMs,
          evictionRate: wmUsage.uptimeMs > 0
            ? Math.round(wmUsage.totalEvictions / (wmUsage.uptimeMs / 60000)) + '/min'
            : '0/min',
        },
      },
      goalStack: this.goalStack.getState(),
      busReady: !!this.bus,
    };
  }

  // ═══════════════════════════════════════════════════════
  //  内部
  // ═══════════════════════════════════════════════════════

  /** 意图推断（Phase 1 增强，Phase 3 替换为 M3 决策 + GoalStack 联动） */
  private _inferIntent(rawInput: string): string {
    if (/^(你好|嗨|哈[喽啰]|hi|hello)/i.test(rawInput)) return '问候';
    if (/[？?]/.test(rawInput) && /什么|怎么|为什么|谁|哪|多少|如何/.test(rawInput)) return '回答问题';
    if (/(谢谢|感谢|多谢)/.test(rawInput)) return '回应感谢';
    if (/(再见|拜拜|bye)/i.test(rawInput)) return '结束对话';
    if (/(帮我|帮忙|我要|我想|请你|麻烦你)/.test(rawInput)) return '请求协助';
    if (/(扮演|模仿|演一下|cos)/.test(rawInput)) return '角色扮演请求';
    if (/(忘掉|忘记|删除|不提|别再提|不要再提)/.test(rawInput)) return '遗忘指令';
    if (/(开心|难过|生气|焦虑|紧张|害怕|高兴|伤心)/.test(rawInput)) return '情绪表达';
    if (/(好的|嗯|哦|行|可以|知道了|明白了|懂了)/i.test(rawInput)) return '确认/回应';
    if (rawInput.length > 100) return '长篇叙述';
    return '日常对话';
  }

  /** 构建约束校验输入（V4.0 Phase 2: 融合三源数据） */
  private _buildConstraintInput(input: PrefrontalInput): ConstraintInput {
    // 🔥 从 globalThis 接入真实数据源（HeartStateStore / FamilyGraph / 会话状态）
    const heartState: any = (globalThis as any).__heartStateStore;
    const fg: any = (globalThis as any).__familyGraph;
    const _cr: string | null = (globalThis as any).__currentRoleplay || null;

    // 情感向量：优先读 HeartStateStore，其次用 snapshot 自带 emotion，最后默认值
    const snapshot = input.snapshot;
    let emotionVector = this._getDefaultEmotionVector();
    if (heartState && typeof heartState.getState === 'function') {
      try {
        const hs = heartState.getState();
        if (hs && hs.emotionVector) {
          emotionVector = { ...hs.emotionVector };
        }
      } catch { /* 静默降级 */ }
    } else if (snapshot?.emotion) {
      emotionVector = {
        ...emotionVector,
        joy: (snapshot.emotion.pleasure > 0 ? snapshot.emotion.pleasure : 0) * 50 + 30,
        sadness: (snapshot.emotion.pleasure < 0 ? -snapshot.emotion.pleasure : 0) * 50,
        affection: snapshot.emotion.intimacy * 50,
        arousal: snapshot.emotion.arousal > 0 ? snapshot.emotion.arousal * 50 : 10,
        trust: 30,
        calm: 50,
      };
    }

    // 🔥 V4.0 Phase 2: 融合瑶灵 32D 体感 + 瑶光 6D 环境 → 增强情感向量
    try {
      const { SensationAdapter } = require('./SensationAdapter.js') as typeof import('./SensationAdapter.js');
      const { somatic, env } = SensationAdapter.getLatestSnapshots();
      if (somatic || env) {
        const enhanced = SensationAdapter.enhance(emotionVector, somatic, env);
        emotionVector = enhanced.emotionVector;
      }
    } catch { /* SensationAdapter 不可用不阻塞 */ }

    // 家族上下文：从 FamilyGraph 读取人物关系
    const familyContext: Array<{ entity: string; relation: string }> = [];
    if (fg && typeof fg.getFamilySummary === 'function') {
      try {
        const summary = fg.getFamilySummary();
        if (summary?.members) {
          for (const m of summary.members) {
            if (m.name && m.relation_to_user) {
              familyContext.push({ entity: m.name, relation: m.relation_to_user });
            }
          }
        }
      } catch { /* 静默降级 */ }
    }

    // 会话历史：从 globalThis 获取（由 chat.ts 注入）
    const conversationHistory: Array<{ role: string; content: string }> =
      (globalThis as any).__pfcConversationContext || [];

    return {
      message: input.rawInput,
      snapshot: input.snapshot,
      goalState: this.goalStack.getState(),
      emotionVector,
      familyContext,
      socialContext: [],
      conversationHistory,
      currentRoleplay: _cr,
      isRoleplaying: !!_cr,
    };
  }

  /** 默认情感向量（Phase 2 替换为 HeartStateStore 真实值） */
  private _getDefaultEmotionVector(): Record<string, number> {
    return {
      joy: 30, sadness: 0, anger: 0, fear: 0, surprise: 10, disgust: 0,
      calm: 50, anxiety: 0, affection: 20, trust: 30, intimacy: 10, respect: 20,
      arousal: 10, fatigue: 10, excitement: 10, boredom: 0, dominance: 0,
      compliance: 10, warmth: 30, coldness: 0, nostalgia: 0, curiosity: 20,
      shyness: 0, jealousy: 0,
    };
  }

  /** 默认 M3Decision（Phase 2 替换为真实的 M3 输入） */
  private _defaultDecision(): M3Decision {
    return {
      enhanced: {
        branch_id: 'default',
        locus_path: 'root.default',
        raw_input: '',
        entity_genes: [],
        perception: this._getDefaultEmotionVector() as any,
        calcium_score: 0.5,
        calcium_level: 1,
      } as any,
      actions: [],
      reason: 'default',
      timestamp: new Date().toISOString(),
    };
  }
}
