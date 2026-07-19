// M5Orchestrator — M5 表达生成层主控制器
// Ref: M5-design-v1.md §6
// ⚖️ 五重铁律协议在此模块全程强制执行

import type { M4Context } from '../m4/types/index.js';
import type { LLMProvider, CognitionObject, StrategyConfig, ConversationTurn } from './types/index.js';
import { CognitionAssembler } from './CognitionAssembler.js';
import { StrategySelector } from './StrategySelector.js';
import { MockLLMProvider } from './MockLLMProvider.js';
import { HumanisticCalibrator } from './HumanisticCalibrator.js';
import { buildContextPrompt, updateAfterReply, resetContext } from './ContextMemory.js';
import { extractAnchor, buildAnchorConstraint, validateAgainstAnchor, resetAnchor } from './SceneAnchor.js';
import { resetMockSession } from './MockLLMProvider.js';
import { getBufferPhrase, type BufferContext } from './BufferPhrases.js';
import { classify, type RoleType, type RoleDecision } from '../app/role/RoleClassifier.js';
import { isIntimate } from '../common/utils/is-intimate.js';
import { evaluateTransition, createInitialState, type TransitionState } from '../app/role/TransitionManager.js';

export class M5Orchestrator {
  private assembler: CognitionAssembler;
  private selector: StrategySelector;
  private llm: LLMProvider;
  private calibrator: HumanisticCalibrator;
  private _transitionState: TransitionState = createInitialState();
  private _currentRole: RoleType = 'secretary';

  constructor(llm?: LLMProvider) {
    this.assembler = new CognitionAssembler();
    this.selector = new StrategySelector();
    this.llm = llm ?? new MockLLMProvider();
    this.calibrator = new HumanisticCalibrator();
  }

  /**
   * 执行完整的四步表达生成流水线
   * @param m4ctx M4 上下文
   * @param conversationHistory 最近对话轮次
   * @param knowledgeBase 知识库内容
   * @param userMessage 用户当前消息（用于场景记忆更新）
   */
  async orchestrate(m4ctx: M4Context, conversationHistory?: ConversationTurn[], knowledgeBase?: string, userMessage?: string, currentRole?: RoleType, isEntityMeeting?: boolean): Promise<string> {
    // P0-1: 提取最近一条 timeline 的 dna_root_id 完成全链路闭环
    const dnaRootId = m4ctx.memory_summary.timeline
      .slice(-1)
      .map(t => (t as any).dna_root_id)
      .filter(Boolean)[0] as string | undefined;

    // Step 1: 认知组装（纯函数）
    const cognition = this.assembler.assemble(m4ctx);

    // Step 2: 策略选择（规则引擎）
    const strategy = this.selector.select(cognition);

    // Step 2.5: 提取场景锚点 → 用对话历史中最近的用户真实消息（非知识注入文本）
    //    userMessage 在 chat.ts 调用方被拼接了 knowledgeBaseText → 含记忆/黑钻等内容，
    //    这些内容中的亲密关键词会把锚点错置为"教室/性交/裸体2"，污染后续所有正常对话。
    const _realLastMsg = (conversationHistory || []).filter(t => t.role === 'user').slice(-1)[0]?.content || userMessage || '';
    extractAnchor(conversationHistory, _realLastMsg);
    const anchorConstraint = buildAnchorConstraint();

    // Step 2.6: 注入场景上下文记忆（🛡️ V4.0: 会晤模式下不注入玉瑶的锚点/场景约束）
    const sceneContext = buildContextPrompt();
    const combinedKnowledge = isEntityMeeting
      ? (knowledgeBase || '')  // 会晤模式：纯实体上下文，不加玉瑶的场景约束
      : (knowledgeBase && knowledgeBase.startsWith('【角色扮演】'))
        ? knowledgeBase
        : [anchorConstraint, sceneContext, knowledgeBase || ''].filter(Boolean).join('\n');

    // P1-3: 记录开始时间，用于判断是否需要过渡话术
    const _startTime = Date.now();

    // === P0: 角色路由（从 chat.ts 单源接收，不再重复分类） ===
    // 📜 架构铁律：角色状态以 chat.ts 的 _currentRole 为唯一权威
    const _rpInput = userMessage || cognition.current.raw_input || '';
    this._currentRole = currentRole || this._currentRole;
    // 强制 lover 覆盖（🛡️ V4.0: 会晤模式下不强制覆盖）
    try {
      if (!isEntityMeeting && this._currentRole !== 'lover' && isIntimate(_rpInput)) {
        this._currentRole = 'lover';
        console.log('[M5Role] 消息含亲密词，强制→lover');
      }
    } catch (_re) { /* 亲密词检测非关键 */ }
    if (isEntityMeeting) this._currentRole = 'recaller';
    console.log('[M5Role] ' + this._currentRole + ' (from chat.ts)');

    // Step 3: LLM 受控生成（唯一LLM调用点）
    let draft: string;
    let usedMockFallback = false;
    try {
      const currentTime = new Date().toISOString();
      const result = await this.llm.generate({ strategy, cognition, conversationHistory, knowledgeBase: combinedKnowledge, currentTime, userMessage, role: this._currentRole, isEntityMeeting });
      draft = result.text;
    } catch (err) {
      console.error('[M5] LLM生成失败:', err);
      draft = '';
    }

    // 如果主 LLM 失败（空/过短），自动降级到 MockLLMProvider
    if (!draft) {
      try {
        console.log('[M5] ⛑️ 启动 MockLLMProvider 降级');
        const mockLlm = new MockLLMProvider();
        const mockResult = await mockLlm.generate({ strategy, cognition, conversationHistory, knowledgeBase: combinedKnowledge, userMessage });
        draft = mockResult.text;
        usedMockFallback = true;
      } catch (err2) {
        console.error('[M5] MockLLM 降级也失败了:', err2);
        draft = '';
      }
    }

    // Step 4: 场景锚点校验（替换冲突词）→ 人文校准 → 降级兜底
    let final: string;
    try {
      const anchorValidated = validateAgainstAnchor(draft);
      final = this.calibrator.calibrate(anchorValidated, cognition);
    } catch (err) {
      console.warn('[M5] 后处理失败，使用LLM原始输出:', err);
      final = draft || '';
    }

    // P1-3: 长耗时自动插入过渡话术（已禁用 — 导致回复不自然的内心独白前缀）
    // 原逻辑：当 LLM 生成耗时 >500ms 时，在回复前插入"让我想想……"类过渡话术
    // 问题：过渡话术与 LLM 真实回复拼接后，呈现"内心独白"风格，让用户感觉玉瑶在自言自语
    // 修复：直接使用 LLM 原始回复，不做前缀拼接
    const _elapsed = Date.now() - _startTime;

    // Step 5: 更新场景记忆（供下一轮使用）
    try {
      updateAfterReply(final, userMessage || '', strategy.params.tone, cognition.current.perception_snapshot);
    } catch (err) {
      console.warn('[M5] 场景记忆更新失败:', err);
    }

    if (!final || final.length <= 2) {
      // 终极兜底 — 用 userMessage 检测常见场景
      if (/你好|嗨|hi|hello|嘿/.test(userMessage || '')) return '嗯～你好呀。你找我我开心着呢。';
      if (/你是谁|介绍/.test(userMessage || '')) return '我是玉瑶，你的私人秘书兼小情人呀～18岁，你说好不好？';
      if (/在干嘛|忙什么/.test(userMessage || '')) return '在想你呀～不然还能干嘛。你呢？';
      if (/晚安|睡了/.test(userMessage || '')) return '晚安～梦里有我哦。';
      if (/早安|早上好/.test(userMessage || '')) return '早呀～昨晚梦到我了吗？';
      return '嗯～我在呢。你说，我听着。';
    }

    return final;
  }

  /** 重置整个 M5 流水线的会话状态（对话重置时调用） */
  resetSession(): void {
    resetContext();       // ContextMemory 场景状态
    resetAnchor();        // SceneAnchor 锚点
    resetMockSession();   // MockLLMProvider 亲密基线
  }
}
