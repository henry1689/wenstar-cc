/**
 * EntityMeeting — 实体会晤管理器 V2.0
 *
 * 定位：替代旧的"角色扮演"机制。以实体的真实 dossier 档案为唯一输出依据，
 * 由 UUIDGatekeeper 管控隐私边界，支持单人会晤和多人同场。
 *
 * V2.0 新增：
 * - 多人会晤（3人及以上）结束时自动生成会议纪要归档
 * - 会议纪要写入 data/webui/meetings/ + 双向绑定到参与者 dossier
 *
 * 设计原则：
 * - 会晤 ≠ 角色扮演 —— 实体以本人身份出现，不是玉瑶在"演"别人
 * - 单人会话 = 私聊（无纪要）；多人会话 = 开会（有纪要）
 * - 纪要区别于私聊记录——保留会议结构、参与者名单、对话摘要
 */

import type { FamilyGraph } from './FamilyGraph.js';
import type { UUIDGatekeeper } from './UUIDGatekeeper.js';
import type { MeetingMinutesStore, MeetingTurn } from './MeetingMinutesStore.js';

/** 会晤状态 */
export interface MeetingState {
  active: boolean;
  /** 主会晤实体（单人模式）或第一个参与者（多人模式） */
  entityName: string;
  entityUUID: string;
  startedAt: string;
  turnCount: number;
  /** 是否多人模式 */
  isMulti: boolean;
}

/** 实体简要信息 */
interface EntityInfo {
  name: string;
  uuid: string;
  category: string;
}

export class EntityMeeting {
  private familyGraph: FamilyGraph;
  private gatekeeper: UUIDGatekeeper | null = null;
  private minutesStore: MeetingMinutesStore | null = null;

  /** 当前会晤状态。null = 在玉瑶视角（秘书模式） */
  private _meeting: MeetingState | null = null;

  /** 多人会议的参与者列表（含姓名和 UUID） */
  private _multiParticipants: EntityInfo[] = [];

  /** 多人会议的对话记录 */
  private _multiTurns: MeetingTurn[] = [];

  /** 多人会议的名称 */
  private _multiMeetingName: string = '';

  constructor(familyGraph: FamilyGraph) {
    this.familyGraph = familyGraph;
  }

  /** 注入门阀 */
  setGatekeeper(gk: UUIDGatekeeper): void {
    this.gatekeeper = gk;
  }

  /** 注入纪存储引擎 */
  setMinutesStore(store: MeetingMinutesStore): void {
    this.minutesStore = store;
  }

  // ═══════════════════════════════════════════════════════════════
  // 会晤入口
  // ═══════════════════════════════════════════════════════════════

  /**
   * 开启与指定实体的单人会晤。
   */
  enter(entityName: string): MeetingState | null {
    const entity = this._resolveEntity(entityName);
    if (!entity) return null;

    this._meeting = {
      active: true,
      entityName: entity.name,
      entityUUID: entity.uuid,
      startedAt: new Date().toISOString(),
      turnCount: 0,
      isMulti: false,
    };

    if (this.gatekeeper) {
      this.gatekeeper.addSessionEntity(entity.uuid);
    }

    return this._meeting;
  }

  /**
   * 开启多人会晤。
   * 3人及以上 → 自动标记为多人会议，结束时生成纪要。
   */
  enterMulti(entityNames: string[]): MeetingState | null {
    if (!entityNames || entityNames.length === 0) return null;

    const entities: EntityInfo[] = [];
    for (const name of entityNames) {
      const entity = this._resolveEntity(name);
      if (entity) entities.push(entity);
    }
    if (entities.length === 0) return null;

    this._multiParticipants = entities;
    this._multiTurns = [];
    this._multiMeetingName = `多人会晤: ${entityNames.join('、')}`;

    const primary = entities[0];
    const isMulti = entities.length >= 3;

    this._meeting = {
      active: true,
      entityName: primary.name,
      entityUUID: primary.uuid,
      startedAt: new Date().toISOString(),
      turnCount: 0,
      isMulti,
    };

    if (this.gatekeeper) {
      const uuids = entities.map(e => e.uuid);
      this.gatekeeper.startMeeting(this._multiMeetingName, uuids);
    }

    return this._meeting;
  }

  /**
   * 结束当前会晤。
   * 如果是多人会议（3人+），自动生成纪要存档。
   *
   * @returns 会议纪要（仅多人会议时返回，单人返回 null）
   */
  async exit(): Promise<{ minutes?: any; } | null> {
    let minutesResult = null;

    // 多人会议 → 生成纪要
    if (this._meeting?.isMulti && this._multiTurns.length >= 2 && this._multiParticipants.length >= 3) {
      try {
        // 延迟导入避免循环依赖
        if (!this.minutesStore) {
          const { MeetingMinutesStore } = await import('./MeetingMinutesStore.js');
          this.minutesStore = new MeetingMinutesStore(this.familyGraph);
        }

        const participantUUIDs = this._multiParticipants.map(p => p.uuid);
        const summaryName = this._multiMeetingName.replace('多人会晤: ', '');

        minutesResult = this.minutesStore.generateAndStore(
          summaryName,
          participantUUIDs,
          this._multiTurns,
        );

        console.log(
          `[EntityMeeting] 会议结束 → 纪要已生成: ${summaryName} ` +
          `(${this._multiParticipants.length}人, ${this._multiTurns.length}轮)`
        );
      } catch (e) {
        console.warn('[EntityMeeting] 纪要生成失败:', (e as Error)?.message || e);
      }
    }

    // 清理状态
    if (this.gatekeeper) {
      this.gatekeeper.clearSessionEntities();
    }
    this._meeting = null;
    this._multiParticipants = [];
    this._multiTurns = [];
    this._multiMeetingName = '';

    return minutesResult ? { minutes: minutesResult } : null;
  }

  /**
   * 记录一轮对话。
   * 在 chat.ts 中每次 LLM 回复后调用。
   */
  recordTurn(role: 'user' | 'assistant', content: string, speakerName?: string): void {
    if (!this._meeting?.isMulti) return;

    this._multiTurns.push({
      speaker: speakerName || (role === 'user' ? '我' : '玉瑶'),
      role,
      content,
      timestamp: new Date().toISOString(),
    });

    // 控制会议纪要中保存的轮次上限（最近 200 轮）
    if (this._multiTurns.length > 200) {
      this._multiTurns = this._multiTurns.slice(-200);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 状态查询
  // ═══════════════════════════════════════════════════════════════

  isActive(): boolean {
    return this._meeting?.active === true;
  }

  isMultiParty(): boolean {
    return this._meeting?.isMulti === true;
  }

  /** 获取当前会晤参与者数量 */
  getParticipantCount(): number {
    return this._multiParticipants.length;
  }

  /** 获取多人会议的参与者名单 */
  getParticipants(): EntityInfo[] {
    return [...this._multiParticipants];
  }

  getState(): MeetingState | null {
    return this._meeting ? { ...this._meeting } : null;
  }

  getEntityName(): string | null {
    return this._meeting?.entityName || null;
  }

  getEntityUUID(): string | null {
    return this._meeting?.entityUUID || null;
  }

  incrementTurn(): void {
    if (this._meeting) this._meeting.turnCount++;
  }

  // ═══════════════════════════════════════════════════════════════
  // 会晤意图检测
  // ═══════════════════════════════════════════════════════════════

  /**
   * 从用户消息中检测会晤意图（单人或多人）。
   *
   * 单人模式:
   *   "跟 [人名] 聊聊" / "[人名]：" / "@[人名]" / "找 [人名]"
   *
   * 多人模式（返回多个名字）:
   *   "叫上 [A] 和 [B] 一起聊" / "让 [A]、[B]、[C] 都来"
   *   "开个会，[A] [B] [C] 参加" / "小组讨论"
   *
   * @returns 检测到的实体名列表（多人模式返回多个），若无意图返回 null
   */
  static detectUserIntent(message: string, knownPersonNames: string[]): string[] | null {
    if (!message || knownPersonNames.length === 0) return null;

    const sorted = [...knownPersonNames].sort((a, b) => b.length - a.length);

    // ── 多人模式检测 ──

    // "叫上 A 和 B" / "叫 A、B、C 一起"
    const multiMatch = message.match(/[叫喊让找]\s*(?:上\s*)?(.+?)\s*(?:一起|都来|过来|开会|聊聊|讨论|聚一聚|碰个头)/);
    if (multiMatch) {
      const namesInMsg = multiMatch[1];
      const found: string[] = [];
      for (const name of sorted) {
        if (namesInMsg.includes(name)) found.push(name);
      }
      if (found.length >= 2) return found;
    }

    // "开个会，A B C" / "小组讨论，A B C 参加"
    const meetingMatch = message.match(/(?:开会|小组讨论|群聊|多人|会议)\s*[,，]?\s*(.+?)(?:\s*参加|\s*参与|\s*一起|\s*都|$)/);
    if (meetingMatch) {
      const found: string[] = [];
      for (const name of sorted) {
        if (meetingMatch[1].includes(name)) found.push(name);
      }
      if (found.length >= 2) return found;
    }

    // "A 和 B 和 C" 模式
    const andMatch = message.match(/([一-龥]{2,4})(?:\s*(?:和|跟|与|、)\s*([一-龥]{2,4}))+/);
    if (andMatch) {
      const allNames = new Set<string>();
      const namePattern = /[一-龥]{2,4}/g;
      let m: RegExpExecArray | null;
      const msgStart = andMatch[0];
      while ((m = namePattern.exec(msgStart)) !== null) {
        const name = sorted.find(n => n === m![0]);
        if (name) allNames.add(name);
      }
      if (allNames.size >= 2 && /一起|都|开会|聊|讨论|聚/.test(message)) {
        return [...allNames];
      }
    }

    // ── 单人模式检测 ──

    const atMatch = message.match(/^@([一-龥\w]{1,8})(?:\s|$)/);
    if (atMatch) {
      const name = sorted.find(n => n === atMatch[1]);
      if (name) return [name];
    }

    const prefixMatch = message.match(/^([一-龥]{2,8})[：:，,]/);
    if (prefixMatch) {
      const name = sorted.find(n => n === prefixMatch[1]);
      if (name) return [name];
    }

    for (const name of sorted) {
      if (new RegExp(`[跟和找喊叫]\\s*${name}\\s*(聊聊|聊一下|说说话|来一下|过来|出来)`).test(message)) {
        return [name];
      }
    }

    for (const name of sorted) {
      if (new RegExp(`[想想要要]\\s*[跟和]\\s*${name}`).test(message)) {
        return [name];
      }
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // 内部
  // ═══════════════════════════════════════════════════════════════

  private _resolveEntity(name: string): EntityInfo | null {
    if (!name || name === '我') return null;
    try {
      const uuid = (this.familyGraph as any).getUUIDByName?.(name);
      if (!uuid) return null;
      const node = (this.familyGraph as any).query?.(
        "SELECT name, uuid, category FROM nodes WHERE uuid = ?",
        [uuid]
      );
      if (!node || node.length === 0) return null;
      return {
        name: node[0].name || name,
        uuid: node[0].uuid || uuid,
        category: node[0].category || 'G',
      };
    } catch {
      return null;
    }
  }
}

export default EntityMeeting;
