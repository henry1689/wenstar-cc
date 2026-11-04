/**
 * FeatureFlag.ts — 灰度切换开关
 *
 * 【能力】
 *   1. 全局开关：v2_enabled = true/false（一键回滚）
 *   2. 按角色切流：namespace → ratio（0~1，如 诗雨=1.0 全量新，王全芬=0.0 全量旧）
 *   3. 按流量比例切流：global_ratio（0~1，按 messageId 哈希稳定分流）
 *   4. 动态调整：热更新，无需重启
 *   5. 一键回滚：rollback() 立即全部切回旧系统
 *
 * 【决策逻辑（优先级从高到低）】
 *   - 如果 globalKillSwitch = true → 强制走 legacy（旧）
 *   - 如果 namespace 在 forceV2 名单 → 强制走 v2（新）
 *   - 如果 namespace 在 forceLegacy 名单 → 强制走 legacy
 *   - 否则按 namespaceRatio[ns] 比例 + messageId 哈希稳定分流
 *   - namespaceRatio 未配置则用 globalRatio
 */

export type RouteTarget = 'v2' | 'legacy';

export interface FeatureFlagState {
  /** 全局总开关：true = 强制全部回旧（KILL SWITCH） */
  globalKillSwitch: boolean;
  /** 全局流量比例（0~1），未配置 namespace 时用此值 */
  globalRatio: number;
  /** 按命名空间的流量比例覆盖 */
  namespaceRatios: Record<string, number>;
  /** 强制走 v2 的 namespace 白名单（灰度期新角色先上） */
  forceV2: Set<string>;
  /** 强制走 legacy 的 namespace 黑名单（有问题的角色先回退） */
  forceLegacy: Set<string>;
  /** 灰度日志开关（记录每次路由决策，便于排查串台） */
  logRouting: boolean;
}

export interface RoutingDecision {
  target: RouteTarget;
  reason: string;
  namespace: string;
  messageId?: string;
}

/**
 * FeatureFlag — 单例
 *
 * 生产环境：从配置文件 / 环境变量加载，支持 Harness 热更新
 * 测试环境：直接 new 一个实例
 */
export class FeatureFlag {
  private state: FeatureFlagState;
  private listeners: Array<(s: FeatureFlagState) => void> = [];

  constructor(initial?: Partial<FeatureFlagState>) {
    this.state = {
      globalKillSwitch: initial?.globalKillSwitch ?? false,
      globalRatio: initial?.globalRatio ?? 0, // 默认全旧，灰度从 0 开始
      namespaceRatios: initial?.namespaceRatios ?? {},
      forceV2: new Set(initial?.forceV2 ?? []),
      forceLegacy: new Set(initial?.forceLegacy ?? []),
      logRouting: initial?.logRouting ?? true,
    };
  }

  // ============================================================
  // 决策
  // ============================================================

  /**
   * 决定本次调用走新还是旧
   * @param namespace 角色命名空间（必传）
   * @param messageId 业务幂等键（用于稳定哈希分流，不传则每次随机）
   */
  route(namespace: string, messageId?: string): RoutingDecision {
    // 1. KILL SWITCH 最高优先级
    if (this.state.globalKillSwitch) {
      return this.decide('legacy', 'global_kill_switch', namespace, messageId);
    }

    // 2. 强制名单
    if (this.state.forceV2.has(namespace)) {
      return this.decide('v2', 'force_v2_whitelist', namespace, messageId);
    }
    if (this.state.forceLegacy.has(namespace)) {
      return this.decide('legacy', 'force_legacy_blacklist', namespace, messageId);
    }

    // 3. 按比例
    const ratio = this.state.namespaceRatios[namespace] ?? this.state.globalRatio;
    if (ratio <= 0) {
      return this.decide('legacy', `ratio_${ratio}=0`, namespace, messageId);
    }
    if (ratio >= 1) {
      return this.decide('v2', `ratio_${ratio}=1`, namespace, messageId);
    }

    // 4. 哈希稳定分流（同 messageId 永远走同一路，避免同一会话新旧穿插）
    const hashKey = messageId ?? `${namespace}:${Date.now()}`;
    const bucket = stableHash01(hashKey); // 0~1
    const target = bucket < ratio ? 'v2' : 'legacy';
    return this.decide(target, `ratio_${ratio}_bucket_${bucket.toFixed(3)}`, namespace, messageId);
  }

  private decide(target: RouteTarget, reason: string, ns: string, mid?: string): RoutingDecision {
    const decision = { target, reason, namespace: ns, messageId: mid };
    if (this.state.logRouting) {
      // 灰度路由日志 —— Harness 可采集
      // eslint-disable-next-line no-console
      console.log(`[memarch-bridge:route] ${target.toUpperCase().padEnd(6)} ns=${ns} reason=${reason} mid=${mid ?? '-'}`);
    }
    return decision;
  }

  // ============================================================
  // 动态调整（Harness 热更新入口）
  // ============================================================

  /** 一键回滚：全部切回旧系统 */
  rollback(): void {
    this.state.globalKillSwitch = true;
    this.emitChange();
  }

  /** 恢复灰度（关闭 kill switch） */
  unrollback(): void {
    this.state.globalKillSwitch = false;
    this.emitChange();
  }

  /** 全局比例调整（0~100 百分比） */
  setGlobalRatio(percent: number): void {
    this.state.globalRatio = Math.max(0, Math.min(1, percent / 100));
    this.emitChange();
  }

  /** 单角色比例调整 */
  setNamespaceRatio(namespace: string, percent: number): void {
    this.state.namespaceRatios[namespace] = Math.max(0, Math.min(1, percent / 100));
    this.emitChange();
  }

  /** 把某角色加入 v2 白名单（100% 切新） */
  promoteNamespaceToV2(namespace: string): void {
    this.state.forceV2.add(namespace);
    this.state.forceLegacy.delete(namespace);
    this.emitChange();
  }

  /** 把某角色踢出 v2（回旧） */
  demoteNamespaceToLegacy(namespace: string): void {
    this.state.forceLegacy.add(namespace);
    this.state.forceV2.delete(namespace);
    this.emitChange();
  }

  /** 当前状态快照（Harness 监控用） */
  snapshot(): FeatureFlagState {
    return {
      ...this.state,
      forceV2: new Set(this.state.forceV2),
      forceLegacy: new Set(this.state.forceLegacy),
      namespaceRatios: { ...this.state.namespaceRatios },
    };
  }

  onChange(listener: (s: FeatureFlagState) => void): void {
    this.listeners.push(listener);
  }

  private emitChange(): void {
    for (const l of this.listeners) l(this.state);
  }
}

/** 稳定哈希：字符串 → [0,1) */
function stableHash01(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return ((h >>> 0) % 10000) / 10000;
}

// ============================================================
// 全局单例（主系统用这个）
// ============================================================

export const globalFeatureFlag = new FeatureFlag({
  // 默认：全旧，灰度从 0% 开始，由 Harness / 手动逐步调
  globalRatio: 0,
  forceV2: new Set<string>(),
  forceLegacy: new Set<string>(),
});
