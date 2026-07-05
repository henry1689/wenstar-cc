// M6 PreferenceManager — 偏好增删改 + 强度衰减
// Ref: docs/M6-design-v1.md §3.2

import type { Preference } from './types/index.js';
import { SelfModelManager } from './SelfModelManager.js';
import { M6_CONFIG } from '../config/M6Config.js';

export class PreferenceManager {
  private manager: SelfModelManager;

  constructor(manager: SelfModelManager) {
    this.manager = manager;
  }

  /** 记录提及，自动新增/强化（仅偏好句式才记入偏好） */
  recordMention(name: string, e1Pleasure: number, sourceMessage?: string): void {
    const prefs = this.manager.getPreferences();
    const existing = prefs.find(p => p.name === name);

    // 检测是否为偏好句式（"我喜欢XX""我讨厌XX"等），非偏好句式只计数不记偏好
    const isPreferenceExpression = sourceMessage
      ? /我喜欢|我超爱|我最爱|我最喜欢|我爱|我讨厌|我不喜欢|我受不了|我恐[惧怕]/.test(sourceMessage)
      : false;

    if (existing) {
      existing.mentionCount++;
      existing.lastMentioned = new Date().toISOString();
      // 仅偏好句式才增减强度
      if (isPreferenceExpression && e1Pleasure > 0.5) {
        existing.strength = Math.min(1, existing.strength + 0.1);
        existing.type = 'like';
      } else if (isPreferenceExpression && e1Pleasure < -0.3) {
        existing.strength = Math.min(1, existing.strength + 0.1);
        existing.type = 'dislike';
      }
      this.manager.addPreference(existing);
      return;
    }

    // 新建偏好：仅偏好句式才创建，普通提及不建
    if (!isPreferenceExpression) return;

    const type = e1Pleasure > 0 ? 'like' : 'dislike';
    const pref: Preference = {
      name, type, strength: 0.5, mentionCount: 1,
      lastMentioned: new Date().toISOString(), source_entities: [],
    };
    this.manager.addPreference(pref);
  }

  /** 偏好强度衰减（从 M6Config 读取参数） */
  applyDecay(): void {
    const now = Date.now();
    const prefs = this.manager.getPreferences();
    for (const p of prefs) {
      const daysSince = (now - new Date(p.lastMentioned).getTime()) / (1000 * 86400);
      if (daysSince >= M6_CONFIG.preference.decayDays) {
        p.strength *= M6_CONFIG.preference.decayRate;
        if (p.strength < M6_CONFIG.preference.minStrength) {
          this.manager.removePreference(p.name);
          continue;
        }
        this.manager.addPreference(p);
      }
    }
  }

  /** 获取活跃偏好（强度≥minStrength） */
  getActive(): Preference[] {
    return this.manager.getPreferences().filter(p => p.strength >= M6_CONFIG.preference.minStrength);
  }
}
