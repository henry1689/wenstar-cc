/**
 * SessionTracker — 会话状态追踪
 *
 * 职责：
 * 1. 道别词识别（分级：短暂离开 / 会话完结）
 * 2. 会话完结封存 + 记忆权重降级
 * 3. 新会话判定（间隔 ≥ 2h 默认新会话）
 * 4. 情绪锚点豁免：高强度情绪记忆不降权
 */
import type { IStorageProvider } from '../../types.js';
import type { FarewellLevel, FarewellRule, SessionState, TemporalConfig } from './base-types.js';

const STORAGE_KEY_SESSION = 'temporal_session_state';

interface SessionSnapshot {
  lastActiveTime: number;       // 上次活跃时间戳
  lastFarewellLevel: FarewellLevel;
  latestSessionDate: string;    // 最近会话日期
  sessionCount: number;         // 累计会话次数
  /** 最近一轮对话的情感强度峰值 0-1 */
  lastEmotionIntensity: number;
  /** 是否已封存 */
  isSealed: boolean;
}

export class SessionTracker {
  private storage: IStorageProvider;
  private state: SessionSnapshot;
  private newSessionThreshold: number;  // 毫秒
  private emotionalAnchorEnabled: boolean;

  /** 道别词分级规则 */
  private static readonly FAREWELL_RULES: FarewellRule[] = [
    {
      level: 'session_end',
      patterns: [/下班/, /晚安/, /明天见/, /再见/, /拜拜/, /先不聊/, /我去(忙|睡|开会)/, /下次聊/, /回头见/, /结束/],
    },
    {
      level: 'short_pause',
      patterns: [/先去忙/, /一会(再)?来/, /等会(再)?聊/, /先这样/, /回头聊/, /晚点(再)?说/, /去去就来/],
    },
  ];

  /** 高强度情感维度关键词 */
  private static readonly HIGH_INTENSITY_WORDS = [
    '难过', '伤心', '崩溃', '绝望', '愤怒', '生气',
    '开心', '幸福', '激动', '兴奋', '感动', '温暖',
    '爱', '想你', '离不开', '重要',
  ];

  constructor(config: TemporalConfig) {
    this.storage = config.storage;
    this.newSessionThreshold = config.newSessionThreshold ?? 2 * 3600 * 1000; // 默认 2 小时
    this.emotionalAnchorEnabled = config.emotionalAnchorEnabled ?? true;
    this.state = {
      lastActiveTime: 0,
      lastFarewellLevel: 'none',
      latestSessionDate: '',
      sessionCount: 0,
      lastEmotionIntensity: 0,
      isSealed: false,
    };
  }

  async init(): Promise<void> {
    try {
      const saved = await this.storage.get<SessionSnapshot>(STORAGE_KEY_SESSION);
      if (saved) this.state = saved;
    } catch (e: any) { console.error('[SessionTracker] error:', e?.message); }
  }

  reset(): void {
    this.state = {
      lastActiveTime: 0,
      lastFarewellLevel: 'none',
      latestSessionDate: '',
      sessionCount: 0,
      lastEmotionIntensity: 0,
      isSealed: false,
    };
  }

  destroy(): void {
    this.persist();
  }

  /** 记录用户活跃 */
  async recordActivity(content: string): Promise<void> {
    this.state.lastActiveTime = Date.now();
    this.state.latestSessionDate = new Date().toISOString().slice(0, 10);
    this.state.sessionCount++;

    // 检测情感强度
    const intensity = this.detectEmotionIntensity(content);
    if (intensity > this.state.lastEmotionIntensity) {
      this.state.lastEmotionIntensity = intensity;
    }

    await this.persist();
  }

  /** 检测道别级别 */
  detectFarewell(message: string): FarewellLevel {
    for (const rule of SessionTracker.FAREWELL_RULES) {
      for (const pattern of rule.patterns) {
        if (pattern.test(message)) {
          this.state.lastFarewellLevel = rule.level;
          if (rule.level === 'session_end') {
            this.state.isSealed = true;
          }
          this.persist();
          return rule.level;
        }
      }
    }
    return 'none';
  }

  /** 判定是否为新会话 */
  isNewSession(currentTime: number): boolean {
    const gap = currentTime - this.state.lastActiveTime;

    // 已封存会话 → 新会话
    if (this.state.isSealed) return true;

    // 情绪锚点豁免：上一次高强度情绪即使封存也暂不隔离
    if (this.emotionalAnchorEnabled && this.state.lastEmotionIntensity > 0.7) {
      return false;
    }

    // 超时间隔 → 新会话
    return gap > this.newSessionThreshold;
  }

  /** 获取会话状态 */
  getSessionState(): SessionState {
    if (this.state.isSealed) return 'sealed';
    if (this.emotionalAnchorEnabled && this.state.lastEmotionIntensity > 0.7) return 'emotional_anchor';
    return 'active';
  }

  /** 获取距上次活跃的小时数 */
  getHoursSinceLastActive(): number {
    if (!this.state.lastActiveTime) return 0;
    return Math.max(0, (Date.now() - this.state.lastActiveTime) / 3600000);
  }

  /** 用户主动提起旧时段事件时解除封存 */
  unseal(): void {
    this.state.isSealed = false;
    this.persist();
  }

  /** 获取当前简报 */
  getState(): SessionSnapshot {
    return { ...this.state };
  }

  /** 检测情感强度 */
  private detectEmotionIntensity(text: string): number {
    let hits = 0;
    for (const word of SessionTracker.HIGH_INTENSITY_WORDS) {
      if (text.includes(word)) hits++;
    }
    // 命中数 / 总关键词数 归一化到 0-1
    return Math.min(1, hits / 5);
  }

  private async persist(): Promise<void> {
    try {
      await this.storage.set(STORAGE_KEY_SESSION, this.state);
    } catch (e: any) { console.error('[SessionTracker] error:', e?.message); }
  }
}
