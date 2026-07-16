/**
 * EmotionCycleTracker.ts — 情绪周期追踪器 (V3.1)
 * ================================================
 * 从 InductionScheduler 的历史归纳数据中分析用户情绪周期。
 * 输出专属情绪节律画像，供 CoreMemory + 情绪调节器使用。
 *
 * 四个维度:
 *   ① 星期几规律 — "周四 pleasure 偏低"
 *   ② 时段规律     — "深夜 22:00-01:00 情绪偏高"
 *   ③ 月度规律     — "冬季 intimacy 偏高"
 *   ④ 近期趋势     — "近2周 pleasure 连续下降"
 *
 * 数据源: data/inductions/*.json (InductionScheduler 的历史输出)
 * 接入: δ 节律 SleepTimeConsolidator 调用 → 结果写入 knowledge_base + CoreMemory
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';

interface InductionRecord {
  period_start: string;
  period_end: string;
  dominant_mood: string;
  avg_calcium: number;
  top_entities: string[];
  created_at: string;
}

interface WeekdayPattern {
  day: number;           // 0=Sun, 1=Mon, ...
  dayName: string;
  avgPleasure: number;
  avgArousal: number;
  sampleCount: number;
  label: string;
}

interface TimeOfDayPattern {
  hour: number;
  hourLabel: string;
  avgPleasure: number;
  avgArousal: number;
  sampleCount: number;
  label: string;
}

interface MonthlyPattern {
  month: number;
  monthName: string;
  avgPleasure: number;
  avgArousal: number;
  sampleCount: number;
  label: string;
}

export interface EmotionCycleProfile {
  weekdayPatterns: WeekdayPattern[];
  timeOfDayPatterns: TimeOfDayPattern[];
  monthlyPatterns: MonthlyPattern[];
  recentTrend: 'rising' | 'declining' | 'stable' | 'insufficient_data';
  recentTrendDetail: string;
  lastAnalyzedAt: string;
}

export class EmotionCycleTracker {
  /**
   * 分析情绪周期
   * @param inductionDir data/inductions/ 目录路径
   * @param recentMemories 最近 memories 记录（用于补充时段数据）
   */
  analyzeCycles(inductionDir: string, recentMemories?: Array<{ created_at: string; perception_json?: string }>): EmotionCycleProfile {
    const profile: EmotionCycleProfile = {
      weekdayPatterns: [],
      timeOfDayPatterns: [],
      monthlyPatterns: [],
      recentTrend: 'insufficient_data',
      recentTrendDetail: '',
      lastAnalyzedAt: new Date().toISOString(),
    };

    try {
      const inductions = this._loadInductions(inductionDir);
      if (inductions.length < 3) return profile;

      // ① 星期几规律
      profile.weekdayPatterns = this._analyzeWeekdays(inductions);

      // ② 时段规律（优先用 memories 的时间戳 + 情绪数据）
      profile.timeOfDayPatterns = this._analyzeTimeOfDay(recentMemories || [], inductions);

      // ③ 月度规律
      profile.monthlyPatterns = this._analyzeMonthly(inductions);

      // ④ 近期趋势
      profile.recentTrend = this._analyzeRecentTrend(inductions);
    } catch (err) {
      console.warn('[EmotionCycle] 分析失败:', err);
    }

    return profile;
  }

  // ── ① 星期几 ──
  private _analyzeWeekdays(inductions: InductionRecord[]): WeekdayPattern[] {
    const dayMap = new Map<number, { pleasures: number[]; arousals: number[] }>();
    const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    for (const ind of inductions) {
      try {
        const d = new Date(ind.created_at);
        const day = d.getDay();
        if (!dayMap.has(day)) dayMap.set(day, { pleasures: [], arousals: [] });

        // 从 dominant_mood 反推近似的 pleasure 值
        const p = this._moodToPleasure(ind.dominant_mood);
        dayMap.get(day)!.pleasures.push(p);
        dayMap.get(day)!.arousals.push(p > 0.3 ? 0.6 : p < -0.3 ? 0.3 : 0.5);
      } catch (e) { console.warn(`[EmotionCycleTracker] 操作失败`, (e as Error)?.message || e); }
    }

    const patterns: WeekdayPattern[] = [];
    for (const [day, data] of dayMap) {
      if (data.pleasures.length < 2) continue;
      const avgP = data.pleasures.reduce((s, v) => s + v, 0) / data.pleasures.length;
      const avgA = data.arousals.reduce((s, v) => s + v, 0) / data.arousals.length;
      const label = avgP < -0.1 ? `${dayNames[day]}低落` : avgP > 0.2 ? `${dayNames[day]}愉快` : `${dayNames[day]}平稳`;
      patterns.push({ day, dayName: dayNames[day], avgPleasure: Math.round(avgP * 100) / 100, avgArousal: Math.round(avgA * 100) / 100, sampleCount: data.pleasures.length, label });
    }
    return patterns.sort((a, b) => a.day - b.day);
  }

  // ── ② 时段 ──
  private _analyzeTimeOfDay(recentMemories: Array<{ created_at: string; perception_json?: string }>, inductions: InductionRecord[]): TimeOfDayPattern[] {
    const hourBuckets = new Map<number, { pleasures: number[]; arousals: number[] }>();

    // 从 memories 时间段取数据
    for (const mem of recentMemories) {
      try {
        const d = new Date(mem.created_at);
        const h = d.getHours();
        const perc = mem.perception_json ? JSON.parse(mem.perception_json) : {};
        if (typeof perc.pleasure !== 'number') continue;
        if (!hourBuckets.has(h)) hourBuckets.set(h, { pleasures: [], arousals: [] });
        hourBuckets.get(h)!.pleasures.push(perc.pleasure);
        hourBuckets.get(h)!.arousals.push(perc.arousal || 0.5);
      } catch (e) { console.warn(`[EmotionCycleTracker] 操作失败`, (e as Error)?.message || e); }
    }

    // 同时从 inductions 的时间段补充
    for (const ind of inductions) {
      try {
        const d = new Date(ind.created_at);
        const h = d.getHours();
        const p = this._moodToPleasure(ind.dominant_mood);
        if (!hourBuckets.has(h)) hourBuckets.set(h, { pleasures: [], arousals: [] });
        hourBuckets.get(h)!.pleasures.push(p);
        hourBuckets.get(h)!.arousals.push(p > 0.3 ? 0.6 : 0.5);
      } catch (e) { console.warn(`[EmotionCycleTracker] 操作失败`, (e as Error)?.message || e); }
    }

    const patterns: TimeOfDayPattern[] = [];
    for (const [hour, data] of hourBuckets) {
      if (data.pleasures.length < 2) continue;
      const avgP = data.pleasures.reduce((s, v) => s + v, 0) / data.pleasures.length;
      const avgA = data.arousals.reduce((s, v) => s + v, 0) / data.arousals.length;
      const label = avgP > 0.2 ? `${hour}时偏活跃` : avgP < -0.1 ? `${hour}时偏低落` : '';
      if (label) patterns.push({ hour, hourLabel: `${hour}:00`, avgPleasure: Math.round(avgP * 100) / 100, avgArousal: Math.round(avgA * 100) / 100, sampleCount: data.pleasures.length, label });
    }
    return patterns.sort((a, b) => a.hour - b.hour);
  }

  // ── ③ 月度 ──
  private _analyzeMonthly(inductions: InductionRecord[]): MonthlyPattern[] {
    const monthMap = new Map<number, { pleasures: number[]; arousals: number[] }>();
    const monthNames = ['', '1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

    for (const ind of inductions) {
      try {
        const m = new Date(ind.created_at).getMonth() + 1;
        if (!monthMap.has(m)) monthMap.set(m, { pleasures: [], arousals: [] });
        const p = this._moodToPleasure(ind.dominant_mood);
        monthMap.get(m)!.pleasures.push(p);
        monthMap.get(m)!.arousals.push(p > 0.3 ? 0.6 : 0.5);
      } catch (e) { console.warn(`[EmotionCycleTracker] 操作失败`, (e as Error)?.message || e); }
    }

    const patterns: MonthlyPattern[] = [];
    for (const [month, data] of monthMap) {
      if (data.pleasures.length < 2) continue;
      const avgP = data.pleasures.reduce((s, v) => s + v, 0) / data.pleasures.length;
      const label = avgP < -0.05 ? `${monthNames[month]}偏低` : avgP > 0.15 ? `${monthNames[month]}偏高` : '';
      if (label) patterns.push({ month, monthName: monthNames[month], avgPleasure: Math.round(avgP * 100) / 100, avgArousal: Math.round(data.arousals.reduce((s, v) => s + v, 0) / data.arousals.length * 100) / 100, sampleCount: data.pleasures.length, label });
    }
    return patterns;
  }

  // ── ④ 趋势 ──
  private _analyzeRecentTrend(inductions: InductionRecord[]): 'rising' | 'declining' | 'stable' | 'insufficient_data' {
    const sorted = [...inductions].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    if (sorted.length < 5) return 'insufficient_data';

    const recent = sorted.slice(-10); // 最近10条
    const firstHalf = recent.slice(0, 5);
    const secondHalf = recent.slice(-5);

    const firstAvg = firstHalf.reduce((s, i) => s + this._moodToPleasure(i.dominant_mood), 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((s, i) => s + this._moodToPleasure(i.dominant_mood), 0) / secondHalf.length;

    if (secondAvg - firstAvg > 0.15) return 'rising';
    if (firstAvg - secondAvg > 0.15) return 'declining';
    return 'stable';
  }

  // ── 工具 ──
  private _moodToPleasure(mood: string): number {
    if (mood.includes('温馨') || mood.includes('积极')) return 0.5;
    if (mood.includes('低落')) return -0.4;
    return 0.1; // 平静中性
  }

  private _loadInductions(dir: string): InductionRecord[] {
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    const records: InductionRecord[] = [];
    for (const f of files.slice(-100)) { // 最近100个
      try {
        records.push(JSON.parse(readFileSync(`${dir}/${f}`, 'utf-8')));
      } catch (e) { console.warn(`[EmotionCycleTracker] 操作失败`, (e as Error)?.message || e); }
    }
    return records;
  }

  /** 将周期画像格式化为可注入 LLM 的文本 */
  formatProfileForContext(profile: EmotionCycleProfile): string | null {
    const parts: string[] = [];

    if (profile.weekdayPatterns.length > 0) {
      parts.push('【情绪周期-周】' + profile.weekdayPatterns.map(p => p.label).join('、'));
    }
    if (profile.timeOfDayPatterns.length > 0) {
      parts.push('【情绪周期-时段】' + profile.timeOfDayPatterns.map(p => p.label).join('、'));
    }
    if (profile.monthlyPatterns.length > 0) {
      parts.push('【情绪周期-月度】' + profile.monthlyPatterns.map(p => p.label).join('、'));
    }
    if (profile.recentTrend !== 'insufficient_data') {
      const trendLabel = profile.recentTrend === 'declining' ? '近2周情绪下降，建议更多关心' : profile.recentTrend === 'rising' ? '近2周情绪上升，状态良好' : '近2周情绪平稳';
      parts.push('【情绪趋势】' + trendLabel);
    }

    return parts.length > 0 ? parts.join('\n') : null;
  }
}
