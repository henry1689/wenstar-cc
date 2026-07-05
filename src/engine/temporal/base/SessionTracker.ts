/**
 * SessionTracker — 会话状态追踪
 *
 * 职责：
 * 1. 道别词识别（分级：短暂离开 / 会话完结）
 * 2. 会话完结封存 + 记忆权重降级
 * 3. 新会话判定（间隔 ≥ 2h 默认新会话）
 * 4. 情绪锚点豁免：高强度情绪记忆不降权
 *
 * v2: 关键词/规则从 TemporalConfig 读取，不再硬编码。
 */
import type { IStorageProvider } from '../../types.js';
import type { FarewellLevel, FarewellRule, SessionState, TemporalConfig } from '../global-types.js';
import { DURATION_CONFIG, FAREWELL_RULES, HIGH_INTENSITY_WORDS } from '../TemporalConfig.js';

const STORAGE_KEY_SESSION = 'temporal_session_state';

interface SessionSnapshot {
  lastActiveTime: number;
  lastFarewellLevel: FarewellLevel;
  latestSessionDate: string;
  sessionCount: number;
  lastEmotionIntensity: number;
  isSealed: boolean;
}

export class SessionTracker {
  private storage: IStorageProvider;
  private state: SessionSnapshot;
  private newSessionThreshold: number;
  private emotionalAnchorEnabled: boolean;
  private farewellRules: FarewellRule[];
  private highIntensityWords: string[];

  constructor(config: TemporalConfig) {
    this.storage = config.storage;
    this.newSessionThreshold = config.newSessionThreshold ?? DURATION_CONFIG.newSessionIntervalMs;
    this.emotionalAnchorEnabled = config.emotionalAnchorEnabled ?? true;
    this.farewellRules = FAREWELL_RULES;
    this.highIntensityWords = HIGH_INTENSITY_WORDS;
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

    const intensity = this.detectEmotionIntensity(content);
    if (intensity > this.state.lastEmotionIntensity) {
      this.state.lastEmotionIntensity = intensity;
    }

    await this.persist();
  }

  /** 检测道别级别 */
  detectFarewell(message: string): FarewellLevel {
    for (const rule of this.farewellRules) {
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

    if (this.state.isSealed) return true;

    if (this.emotionalAnchorEnabled && this.state.lastEmotionIntensity > DURATION_CONFIG.emotionalAnchorThreshold) {
      return false;
    }

    return gap > this.newSessionThreshold;
  }

  /** 获取会话状态 */
  getSessionState(): SessionState {
    if (this.state.isSealed) return 'sealed';
    if (this.emotionalAnchorEnabled && this.state.lastEmotionIntensity > DURATION_CONFIG.emotionalAnchorThreshold) return 'emotional_anchor';
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
    for (const word of this.highIntensityWords) {
      if (text.includes(word)) hits++;
    }
    return Math.min(1, hits / DURATION_CONFIG.emotionNormalizer);
  }

  private async persist(): Promise<void> {
    try {
      await this.storage.set(STORAGE_KEY_SESSION, this.state);
    } catch (e: any) { console.error('[SessionTracker] error:', e?.message); }
  }
}
