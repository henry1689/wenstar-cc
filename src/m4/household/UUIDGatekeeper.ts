/**
 * UUIDGatekeeper — 动态门阀白名单过滤器 V4.0
 *
 * 定位：挂载于天权海马体检索入口的逻辑隔离闸门，是对话的基础结构（非可选插件）。
 * 不与存储层交互——不复制数据、不创建索引——仅在检索结果返回后进行过滤。
 *
 * V4.0 架构升级：
 * - 三层白名单：基础层（用户本人） + 会话层（会晤目标·支持多人） + 临时层（单次授权）
 * - 门阀始终激活，不再有 null/全放行状态
 * - 多人同时对话支持：startMeeting / addToMeeting / endMeeting
 * - 公开级(PUBLIC)数据始终放行，私密级按白名单过滤
 *
 * 安全声明（见 fg-kinship-redlines.md §18.5）：
 * ① 门阀仅拦截检索，不修改存储
 * ② 门阀逻辑不可被任何模块绕过
 * ③ 临时跨 UUID 授权在会话结束时全部失效
 */

import type { FamilyGraph } from './FamilyGraph.js';

/** 会话统计 */
interface SessionStats {
  total: number;
  allowed: number;
  blocked: number;
}

/** FG family/social context 成员结构 */
interface FGMember {
  entity: string;
  relation?: string;
  [key: string]: any;
}

/** 多人会晤状态 */
interface MeetingState {
  active: boolean;
  name: string;
  participants: Set<string>;
  startedAt: string;
}

export class UUIDGatekeeper {
  /** 基础层：始终包含的 UUID（用户"我"的 TXS-ID + 系统级实体）。启动时设定，运行期不变 */
  private baseWhitelist: Set<string> = new Set();

  /** 会话层：当前会话中授予访问权的 UUID（实体会晤目标，支持多人） */
  private sessionEntities: Set<string> = new Set();

  /** 临时层：单次查询的临时授权（本次请求有效，请求结束后自动清除） */
  private tempGrants: Set<string> = new Set();

  /** 多人会晤状态 */
  private meetingState: MeetingState | null = null;

  private familyGraph: FamilyGraph;
  private sessionStats: SessionStats = { total: 0, allowed: 0, blocked: 0 };

  /** 缓存：人名 → UUID，避免反复查库 */
  private nameToUUIDCache = new Map<string, string | null>();

  constructor(familyGraph: FamilyGraph) {
    this.familyGraph = familyGraph;
  }

  // ═══════════════════════════════════════════════════════════════
  // 初始化（启动时调用一次）
  // ═══════════════════════════════════════════════════════════════

  /**
   * 初始化基础白名单。
   * 在 server.ts 启动时调用，填充用户本人的 TXS-ID。
   * 基础层在门阀整个生命周期中不变。
   */
  /**
   * 初始化基础白名单。
   * 接收外部查询好的 UUID 数组直接填充，避免跨实例方法调用问题。
   */
  initBase(uuids: string[]): void {
    if (!uuids || uuids.length === 0) return;
    for (const uuid of uuids) {
      if (uuid) this.baseWhitelist.add(uuid);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 会话管理（支持多人）
  // ═══════════════════════════════════════════════════════════════

  /**
   * 设定当前会话的会晤实体。
   *
   * @param uuids - 单个 UUID 或 UUID 数组（支持多人同时）
   */
  setSessionEntities(uuids: string | string[]): void {
    this.sessionEntities.clear();
    if (!uuids) return;
    const list = Array.isArray(uuids) ? uuids : [uuids];
    for (const uuid of list) {
      if (uuid && !this.baseWhitelist.has(uuid)) {
        this.sessionEntities.add(uuid);
      }
    }
    this.resetSessionStats();
    this.nameToUUIDCache.clear();
  }

  /** 追加一人到当前会话 */
  addSessionEntity(uuid: string): void {
    if (!uuid || this.baseWhitelist.has(uuid)) return;
    this.sessionEntities.add(uuid);
    this.nameToUUIDCache.clear();
  }

  /** 从当前会话移除一人 */
  removeSessionEntity(uuid: string): void {
    this.sessionEntities.delete(uuid);
  }

  /** 清空会话层（基础层不变，门阀回到仅有用户本人的基线状态） */
  clearSessionEntities(): void { const stats = this.getSessionStats(); if (stats.total > 0) console.log("[Gatekeeper] 会话结束: "+stats.total+"次 "+stats.allowed+"放行 "+stats.blocked+"拦截");
    this.sessionEntities.clear();
    this.tempGrants.clear();
    if (this.meetingState) this.meetingState = null;
    this.resetSessionStats();
    this.nameToUUIDCache.clear();
  }

  /** 获取当前会话层白名单 UUID 列表 */
  getSessionEntities(): string[] {
    return [...this.sessionEntities];
  }

  // ═══════════════════════════════════════════════════════════════
  // 多人会晤管理
  // ═══════════════════════════════════════════════════════════════

  /**
   * 开启多人会晤模式。
   *
   * 场景：开会、小组讨论、几人群聊、家庭聚会等
   * 效果：所有参与者加入会话白名单，可互相调取 PUBLIC + INTERNAL 级别档案
   *
   * @param name - 会晤名称（如"项目讨论会"、"家庭聚会"）
   * @param participants - 参与者 UUID 列表
   */
  startMeeting(name: string, participants: string[]): void {
    this.meetingState = {
      active: true,
      name,
      participants: new Set(participants.filter(Boolean)),
      startedAt: new Date().toISOString(),
    };
    // 全部参与者加入会话层
    for (const uuid of participants) {
      if (uuid && !this.baseWhitelist.has(uuid)) {
        this.sessionEntities.add(uuid);
      }
    }
    this.resetSessionStats();
    this.nameToUUIDCache.clear();
  }

  /** 会晤中途加人 */
  addToMeeting(uuid: string): void {
    if (!this.meetingState) return;
    if (!uuid) return;
    this.meetingState.participants.add(uuid);
    this.addSessionEntity(uuid);
  }

  /** 会晤中途移除某人 */
  removeFromMeeting(uuid: string): void {
    if (!this.meetingState) return;
    this.meetingState.participants.delete(uuid);
    this.removeSessionEntity(uuid);
  }

  /** 结束多人会晤，清空会话层（但保留基础层） */
  endMeeting(): void {
    this.meetingState = null;
    this.sessionEntities.clear();
    this.tempGrants.clear();
    this.resetSessionStats();
  }

  /** 获取当前会晤状态 */
  getMeetingState(): MeetingState | null {
    if (!this.meetingState) return null;
    return {
      active: this.meetingState.active,
      name: this.meetingState.name,
      participants: new Set(this.meetingState.participants),
      startedAt: this.meetingState.startedAt,
    };
  }

  /** 是否处于多人会晤模式 */
  isMeetingActive(): boolean {
    return this.meetingState?.active === true;
  }

  // ═══════════════════════════════════════════════════════════════
  // 临时授权
  // ═══════════════════════════════════════════════════════════════

  /** 单次查询临时授权（当前请求结束后自动清除） */
  grantTemp(uuid: string): void {
    if (!uuid) return;
    this.tempGrants.add(uuid);
  }

  /** 撤销临时授权 */
  revokeTemp(uuid: string): void {
    this.tempGrants.delete(uuid);
  }

  /** 清空所有临时授权 */
  clearTempGrants(): void {
    this.tempGrants.clear();
  }

  // ═══════════════════════════════════════════════════════════════
  // 状态查询
  // ═══════════════════════════════════════════════════════════════

  /** 门阀始终激活（V4.0 不再有 null 状态） */
  isActive(): boolean {
    return true;
  }

  /** 获取三层合并后的有效白名单 */
  getEffectiveWhitelist(): Set<string> {
    const merged = new Set<string>();
    for (const uuid of this.baseWhitelist) merged.add(uuid);
    for (const uuid of this.sessionEntities) merged.add(uuid);
    for (const uuid of this.tempGrants) merged.add(uuid);
    return merged;
  }

  /** 获取有效白名单 UUID 数组 */
  getWhitelistArray(): string[] {
    return [...this.getEffectiveWhitelist()];
  }

  /** 检查指定 UUID 是否在白名单中 */
  isInWhitelist(uuid: string): boolean {
    if (!uuid) return false;
    return this.baseWhitelist.has(uuid)
      || this.sessionEntities.has(uuid)
      || this.tempGrants.has(uuid);
  }

  private _checkSecurityLevel(memory: any): boolean { const sl = (memory as any).security_level || 1; return sl <= 1; }

  getSessionStats(): SessionStats {
    return { ...this.sessionStats };
  }

  resetSessionStats(): void {
    this.sessionStats = { total: 0, allowed: 0, blocked: 0 };
  }

  // ═══════════════════════════════════════════════════════════════
  // 核心过滤方法（接口不变，逻辑升级）
  // ═══════════════════════════════════════════════════════════════

  /**
   * 检查逗号分隔的实体名列表中是否有白名单内的 UUID。
   *
   * @param entityNamesStr - fg_entity_names 字段值，如 "徐诗雨,林土锋"
   * @returns 是否应放行
   */
  filterByEntityNames(entityNamesStr: string | null | undefined): boolean {
    if (!entityNamesStr) return true; // 无实体标记的记忆始终放行

    const names = entityNamesStr.split(',').map(s => s.trim()).filter(Boolean);
    if (names.length === 0) return true;

    for (const name of names) {
      const uuid = this._resolveUUID(name);
      if (uuid && this.isInWhitelist(uuid)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 过滤记忆列表（DNA[] 类型）
   */
  filterMemories<T extends { fg_entity_names?: string; entity_genes?: any; raw_input?: string }>(
    memories: T[]
  ): T[] {
    const allowed: T[] = [];
    for (const m of memories) {
      // 先查 fg_entity_names（逗号分隔的人名）
      const fgNames = (m as any).fg_entity_names || '';
      if (this.filterByEntityNames(fgNames)) {
        allowed.push(m);
        this.sessionStats.allowed++;
      } else {
        // 次级检查：entity_genes JSON 中的 entity name
        let entityNames: string[] = [];
        try {
          const genes = typeof (m as any).entity_genes === 'string'
            ? JSON.parse((m as any).entity_genes)
            : (m as any).entity_genes;
          if (Array.isArray(genes)) {
            entityNames = genes.map((g: any) => g.name).filter(Boolean);
          }
        } catch { /* 解析失败不影响过滤 */ }

        const hasMatch = entityNames.some(name => {
          const uuid = this._resolveUUID(name);
          return uuid && this.isInWhitelist(uuid);
        });

        if (hasMatch) {
          allowed.push(m);
          this.sessionStats.allowed++;
        } else {
          this.sessionStats.blocked++;
        }
      }
    }
    return allowed;
  }

  /**
   * 过滤 FG 成员列表（family_context / social_context 中的 {entity: string} 数组）
   */
  filterFGMembers<T extends { entity: string }>(members: T[]): T[] {
    return members.filter(m => {
      const uuid = this._resolveUUID(m.entity);
      const allowed = !uuid || this.isInWhitelist(uuid);
      if (allowed) this.sessionStats.allowed++;
      else this.sessionStats.blocked++;
      return allowed;
    });
  }

  /**
   * 限制实体名列表为白名单内的人物。
   * 用于 KnowledgeContextBuilder 的 entity overlap 搜索。
   * 无实体 UUID 映射的人物（陌生人/未登记）始终放行。
   */
  restrictEntityNames(entityNames: string[]): string[] {
    if (!entityNames || entityNames.length === 0) return [];

    return entityNames.filter(name => {
      const uuid = this._resolveUUID(name);
      return !uuid || this.isInWhitelist(uuid);
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // 内部
  // ═══════════════════════════════════════════════════════════════

  /** 人名 → UUID（带缓存） */
  private _resolveUUID(name: string): string | null {
    if (!name) return null;
    const cached = this.nameToUUIDCache.get(name);
    if (cached !== undefined) return cached;

    let uuid: string | null = null;
    try {
      uuid = (this.familyGraph as any).getUUIDByName?.(name) || null;
    } catch {
      uuid = null;
    }
    this.nameToUUIDCache.set(name, uuid);
    return uuid;
  }
}

export default UUIDGatekeeper;
