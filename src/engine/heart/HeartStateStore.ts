/**
 * HeartStateStore — 边缘系统状态仓库
 *
 * 集中管理情感/关系/状态。
 * 每次 dispatchUpdate 自动记录变更审计日志。
 */
import type { IEventBus, ILifecycle, IStorageProvider } from '../types.js';
import type { HeartStateUpdatedEvent, IntentClassifiedEvent, MemoryRetrievedEvent } from '../bus/types.js';
import { HeartGlobalState, StateChangeLog, defaultHeartState } from './types.js';
import { applyEmotionStimulus, transitionRelation, computeAtmosphere } from './bionic-hooks.js';
import { computeSynapseStrength } from './relation-synapse.js';
import { applyReconsolidation, evaluateLibraryPromotion } from './reconsolidation.js';
import { classifyEmotion, type EmotionLabel } from './emotion-label.js';
import { checkEmergence, emergenceToHint, type EmergenceState } from './emotional-emergence.js';
import { updateDesireStack, defaultDesireStack, type DesireStackState } from './desire-stack.js';
import type { StimulusType } from './stimulus-table.js';
import { EngineContext } from '../EngineContext.js';

const MAX_AUDIT_HISTORY = 20; // 保留最近 20 轮变更记录

export class HeartStateStore implements ILifecycle {
  private state: HeartGlobalState = defaultHeartState();
  private _onIntentClassified: ((event: any) => void) | null = null;
  private _onMemoryRetrieved: ((event: any) => void) | null = null;
  private bus: IEventBus | null = null;
  private storage: IStorageProvider | null = null;
  private auditLog: StateChangeLog[] = [];
  private listeners: Set<(state: HeartGlobalState) => void> = new Set();
  // 欲望栈 + 涌现 状态
  private desireStack: DesireStackState = defaultDesireStack();
  private activeEmergence: EmergenceState | null = null;
  private totalTurns = 0;
  private lastEmergence: { type: string; turn: number } | null = null;
  private lastEmotionLabel: EmotionLabel | null = null;
  private lastDesireHints: string[] = [];
  private lastEmergenceHint: string = '';

  async init(bus: IEventBus, storage?: IStorageProvider): Promise<void> {
    this.bus = bus;
    this.storage = storage ?? null;

    // 始终从默认值开始（生产环境从存储恢复）
    this.state = defaultHeartState();
    if (storage) {
      try {
        const saved = await storage.get<HeartGlobalState>('heart_state');
        if (saved) {
          // 校验合理性：修复写死的极值
          const rm = saved.relationMetrics;
          if (rm && (rm.trust > 100 || rm.intimacy > 100 || rm.rapport > 100 || rm.crack > 100)) {
            console.warn('[Heart] 状态数据异常（超出范围），使用默认值');
          } else if (saved.emotionVector && saved.relationState) {
            this.state = saved;
          }
        }
      } catch { /* 首次启动无历史状态 */ }
    }

    // 订阅意图事件 → 更新情感状态（S2 主入口）
    this._onIntentClassified = this.onIntentClassified.bind(this);
    bus.on('intent:classified', this._onIntentClassified, 400);
    // 订阅记忆事件 → 触达调整
    this._onMemoryRetrieved = this.onMemoryRetrieved.bind(this);
    bus.on('memory:retrieved', this._onMemoryRetrieved, 400);
  }

  reset(): void {
    this.state = defaultHeartState();
    this.auditLog = [];
  }

  destroy(): void {
    if (this.bus) {
      if (this._onIntentClassified) this.bus.off('intent:classified', this._onIntentClassified);
      if (this._onMemoryRetrieved) this.bus.off('memory:retrieved', this._onMemoryRetrieved);
    }
    this.bus = null;
    this.storage = null;
    this.listeners.clear();
    this._onIntentClassified = null;
    this._onMemoryRetrieved = null;
  }

  /** 获取当前状态快照 */
  getState(): HeartGlobalState {
    return { ...this.state };
  }

  /** 订阅状态变更 */
  subscribe(listener: (state: HeartGlobalState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 受控更新状态 + 审计日志 */
  dispatchUpdate(partial: Partial<HeartGlobalState>, triggerEvent?: string, traceId?: string): void {
    const changes: StateChangeLog['changes'] = [];

    for (const [key, value] of Object.entries(partial)) {
      const oldVal = (this.state as any)[key];
      if (oldVal !== value) {
        changes.push({ field: key, oldValue: oldVal, newValue: value });
      }
    }

    if (changes.length === 0) return;

    // 更新状态
    this.state = { ...this.state, ...partial, updatedAt: new Date().toISOString() };

    // 审计日志
    this.auditLog.push({
      timestamp: Date.now(),
      triggerEvent: triggerEvent ?? 'unknown',
      traceId: traceId ?? '',
      changes,
    });
    if (this.auditLog.length > MAX_AUDIT_HISTORY) {
      this.auditLog.shift();
    }

    // 通知订阅者
    this.listeners.forEach(fn => fn(this.state));

    // 发布状态变更事件
    if (this.bus) {
      const event: HeartStateUpdatedEvent = {
        type: 'heart:state_updated',
        traceId: traceId ?? '',
        timestamp: Date.now(),
        sessionId: this.state.updatedAt,
        payload: {
          emotionVector: { ...this.state.emotionVector },
          relationState: this.state.relationState,
          atmosphere: this.state.atmosphere,
          memoryPermission: this.state.memoryPermission,
        },
      };
      this.bus.emit(event);
    }
  }

  /** 获取审计日志 */
  getAuditLog(): StateChangeLog[] {
    return [...this.auditLog];
  }

  /** 获取情感标签 */
  getEmotionLabel(): EmotionLabel | null {
    return this.lastEmotionLabel;
  }

  /** 获取欲望提示 */
  getDesireHints(): string[] {
    return [...this.lastDesireHints];
  }

  /** 获取涌现提示 */
  getEmergenceHint(): string {
    return this.lastEmergenceHint;
  }

  /** 获取欲望栈 */
  getDesireStack(): DesireStackState {
    return { ...this.desireStack, slots: [...this.desireStack.slots] };
  }

  /** 持久化到数据库 */
  async persist(): Promise<void> {
    if (this.storage) {
      await this.storage.set('heart_state', this.state);
    }
  }

  // ── 事件处理 ──

  /** 意图已分类 → 更新情感向量 + 关系突触 + 欲望栈 + 涌现 + 标签 */
  private onIntentClassified = async (event: IntentClassifiedEvent): Promise<void> => {
    const stimulusType = this.mapIntentToStimulus(event.payload.intent, event.payload.subIntent);
    let updatedEmotion = this.state.emotionVector;
    let atmosphere = computeAtmosphere(this.state);
    let relResult: any = { updatedMetrics: this.state.relationMetrics, stageChanged: false };
    let newRelationState = this.state.relationState;

    if (stimulusType) {
      const result = applyEmotionStimulus(
        { type: stimulusType, intensity: 0.5 + event.payload.confidence * 0.3, trustFactor: this.state.relationMetrics.trust / 100 },
        this.state,
      );
      if (result.applied) {
        updatedEmotion = result.updatedVector;
        atmosphere = computeAtmosphere({ ...this.state, emotionVector: result.updatedVector });
        const lastUpdated = this.state.updatedAt ? new Date(this.state.updatedAt).getTime() : Date.now();
        const deltaHours = Math.max(0, (Date.now() - lastUpdated) / (1000 * 60 * 60));
        const valence = this.mapIntentToValence(event.payload.intent);
        relResult = transitionRelation(this.state, valence, 0.3 + event.payload.confidence * 0.4, ['boundary_violation'].includes(event.payload.intent), event.payload.subIntent === 'save' && event.payload.intent === 'memory_operation', deltaHours);
        if (relResult.stageChanged) {
          if (relResult.stageDirection === 'upgrade') { newRelationState = this.state.relationState === 'stranger' ? 'familiar' : 'intimate'; }
          else { newRelationState = this.state.relationState === 'intimate' ? 'familiar' : 'stranger'; }
        }
      }
    }

    // ── 欲望栈更新（每轮都执行，独立于情感变化） ──
    this.totalTurns++;
    const dh = Math.max(1, (Date.now() - new Date(this.state.updatedAt).getTime()) / (1000 * 60 * 60));
    const ds = updateDesireStack(this.desireStack, event.payload.intent, newRelationState as any, dh, 24);
    this.desireStack = ds.stack;
    this.lastDesireHints = ds.hints;

    // ── 情感标签映射（每轮都执行） ──
    this.lastEmotionLabel = classifyEmotion(updatedEmotion).primary;

    // ── 情绪涌现（每轮都执行） ──
    const emergence = checkEmergence({ emotion: updatedEmotion, relationStage: newRelationState as any, trust: relResult.updatedMetrics.trust, timeOfDay: new Date().getHours(), daysSinceMet: 0, totalTurns: this.totalTurns, lastEmergence: this.lastEmergence }, this.activeEmergence);
    if (emergence) { this.activeEmergence = emergence; this.lastEmergenceHint = emergenceToHint(emergence); if (emergence.hasExpressed) this.lastEmergence = { type: emergence.type, turn: this.totalTurns }; }

    // ── 统一更新状态 ──
    this.dispatchUpdate({ emotionVector: updatedEmotion, atmosphere, relationMetrics: relResult.updatedMetrics, relationState: newRelationState }, 'intent:classified', event.traceId);

    console.log(`[Heart] emotion=${this.lastEmotionLabel?.label ?? '未分类'} rel=${newRelationState} trust=${relResult.updatedMetrics.trust.toFixed(0)} desire=${this.lastDesireHints.length ? this.lastDesireHints[0] : 'none'}${this.lastEmergenceHint ? ' emerge=' + this.lastEmergenceHint : ''}`);
    if (relResult.stageChanged) console.log(`[Heart] 关系阶段跃迁: ${relResult.stageDirection}`);
  };

  /** IntentType + subIntent → StimulusType 映射 */
  private mapIntentToStimulus(intent: string, subIntent?: string): StimulusType | null {
    if (intent === 'rp_trigger') return subIntent === 'stop' ? 'cold' : 'praise';
    if (intent === 'knowledge_query') return 'question';
    if (intent === 'memory_operation') return subIntent === 'save' ? 'casual_chat' : 'question';
    if (intent === 'boundary_violation') return 'hurtful';
    if (intent === 'system_command') return null;
    return 'casual_chat';
  }

  /** IntentType → 关系事件效价映射 */
  private mapIntentToValence(intent: string): 'positive' | 'negative' | 'neutral' {
    if (intent === 'boundary_violation') return 'negative';
    if (intent === 'system_command') return 'neutral';
    if (intent === 'rp_trigger') return 'positive';
    if (intent === 'knowledge_query') return 'neutral';
    return 'positive'; // casual_chat, memory_operation 等默认正向
  }

  /** 记忆检索后 → 再巩固调权 */
  private onMemoryRetrieved = async (event: MemoryRetrievedEvent): Promise<void> => {
    const state = this.state;
    const memCount = event.payload.totalCount;
    if (memCount === 0) return;

    // 应用再巩固到每条检索到的记忆
    // (外部存储回写由 AQC 处理，这里只计算偏移量)
    for (const mem of event.payload.shortTerm) {
      if (mem.timestamp) {
        const ageHours = (Date.now() - new Date(mem.timestamp).getTime()) / (1000 * 60 * 60);
        const result = applyReconsolidation({
          currentImportance: mem.importance * 100,
          currentVividness: 50,
          retrievalEmotion: state.emotionVector,
          trust: state.relationMetrics.trust,
          ageHours: Math.max(0, ageHours),
          retrievalCount: mem.retrievalScore ? Math.ceil(mem.retrievalScore * 10) : 1,
        });

        if (result.triggerAQC) {
          console.log(`[Reconsolidation] 🔔 触发 AQC 审核: ${mem.id} (累计偏移 ${result.cumulativeShift})`);
        }

        // 检查是否需要跨库晋升
        if (mem.library === 'sand') {
          const action = evaluateLibraryPromotion(
            result.newImportance, result.newVividness,
            state.relationMetrics.trust, state.relationState,
          );
          if (action === 'promote_sand_to_gold') {
            console.log(`[Reconsolidation] ⬆️ ${mem.id} 砂金→金库候选`);
          }
        }
      }
    }
  };
}
