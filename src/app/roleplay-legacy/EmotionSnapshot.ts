/**
 * EmotionSnapshot — 角色情感快照隔离（P1-1）
 *
 * 核心职责：角色扮演时情感状态独立存档，退出后恢复玉瑶本体状态。
 *
 * 🔴 铁律：
 *   1. 角色情感永不污染玉瑶本体 — exit时严格恢复
 *   2. 角色情感永不泄漏到FG — 情爱数据永久隔离
 *   3. 下次激活同一角色时恢复 — 扮演连续不中断
 *
 * 使用方式：
 *   const snapshot = new EmotionSnapshot(heartStore);
 *   snapshot.enterRoleplay('徐诗韵');   // 存档玉瑶状态，切到角色状态
 *   snapshot.getEmotionState();         // 获取当前（角色）状态
 *   snapshot.exitRoleplay();            // 恢复玉瑶状态
 */

import type { HeartStateStore } from '../../engine/heart/HeartStateStore.js';
import type { HeartGlobalState } from '../../engine/heart/types.js';

export class EmotionSnapshot {
  /** 玉瑶本体存档 — exit时恢复至此 */
  private _yuyaoSavedState: HeartGlobalState | null = null;
  /** 角色情感快照 Map */
  private _roleSnapshots = new Map<string, HeartGlobalState>();
  /** 当前扮演角色名 */
  private _currentRole: string | null = null;
  /** 是否正在角色扮演中 */
  private _active = false;

  constructor(
    private _heartStore: HeartStateStore | null,
  ) {}

  /** 进入角色扮演：存档玉瑶 → 加载角色状态（或默认初始化） */
  enterRoleplay(roleName: string): void {
    if (!this._heartStore) return;

    // 1. 存档玉瑶当前状态（仅在首次进入时）
    if (!this._yuyaoSavedState) {
      this._yuyaoSavedState = this.cloneState(this._heartStore.getState());
    }

    // 2. 检查是否有该角色的历史快照
    const saved = this._roleSnapshots.get(roleName);
    if (saved) {
      // 有历史快照 — 恢复上次的状态（续前缘）
      this.applyState(this._heartStore, saved);
      console.log(`[EmotionSnapshot] 恢复角色情感: ${roleName} (信任=${saved.relationMetrics.trust})`);
    } else {
      // 无历史快照 — 初始化为中性的默认状态
      this.applyState(this._heartStore, this.defaultRoleState(roleName));
      console.log(`[EmotionSnapshot] 初始化角色情感: ${roleName}`);
    }

    this._currentRole = roleName;
    this._active = true;
  }

  /** 退出角色扮演：存档角色 → 恢复玉瑶 */
  exitRoleplay(): void {
    if (!this._heartStore || !this._active) return;

    // 1. 存档当前角色状态
    if (this._currentRole) {
      this._roleSnapshots.set(this._currentRole, this.cloneState(this._heartStore.getState()));
    }

    // 2. 恢复玉瑶状态
    if (this._yuyaoSavedState) {
      this.applyState(this._heartStore, this._yuyaoSavedState);
    }

    this._currentRole = null;
    this._active = false;
  }

  /** 获取当前角色名 */
  getCurrentRole(): string | null {
    return this._currentRole;
  }

  /** 是否在角色扮演中 */
  isActive(): boolean {
    return this._active;
  }

  // ─── 私有方法 ───

  /** 深拷贝 HeartGlobalState */
  private cloneState(state: HeartGlobalState): HeartGlobalState {
    return JSON.parse(JSON.stringify(state));
  }

  /** 将状态写入 HeartStateStore（通过内部字段或 setter） */
  private applyState(store: HeartStateStore, state: HeartGlobalState): void {
    // HeartStateStore 没有公开 setter，但 getState 返回副本
    // 方案：直接覆盖 store 内部状态
    // 利用 (store as any).state 写入（这是 S1 架构公认的临时做法）
    const _s = store as any;
    if (_s.state) {
      _s.state = this.cloneState(state);
    }
  }

/** 角色的默认情感状态（中性，无历史）匹配 HeartGlobalState 精确类型 */
  private defaultRoleState(_roleName: string): HeartGlobalState {
    return {
      emotionVector: {
        joy: 10, sadness: 0, anger: 0, fear: 0,
        surprise: 5, disgust: 0, calm: 30, anxiety: 0,
        affection: 0, trust: 0, intimacy: 0, respect: 0,
        arousal: 0, fatigue: 0, excitement: 0, boredom: 0,
        dominance: 0, compliance: 10, warmth: 15, coldness: 0,
        nostalgia: 0, curiosity: 10, shyness: 0, jealousy: 0,
      },
      relationState: 'stranger' as any,
      atmosphere: 'neutral' as any,
      memoryPermission: 'sand' as any,
      relationMetrics: {
        trust: 0, intimacy: 0, rapport: 0, crack: 0,
        positiveStreak: 0, sharedEvents: 0,
      },
      updatedAt: new Date().toISOString(),
    };
  }
}
