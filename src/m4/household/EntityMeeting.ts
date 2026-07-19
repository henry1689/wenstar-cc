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

  /** 是否首轮对话（用于开场协议注入） */
  private _isFirstTurn: boolean = false;

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

    this._isFirstTurn = true;
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

    this._isFirstTurn = true;
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
   * 在会晤中切换到另一个实体。
   * 先退出当前会晤，再进入新实体。如果是多人会议则先存档纪要。
   */
  async switchTo(entityName: string): Promise<MeetingState | null> {
    // 先退出当前会晤（多人会议自动存档）
    if (this._meeting) {
      await this.exit();
    }

    // 再进入新会晤
    return this.enter(entityName);
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
    if (this._meeting) {
      this._meeting.turnCount++;
      this._isFirstTurn = false;
    }
  }

  /** 当前是否为首轮对话（用于开场协议注入） */
  isFirstTurn(): boolean {
    return this._isFirstTurn;
  }

  // ═══════════════════════════════════════════════════════════════
  // 会晤意图检测
  // ═══════════════════════════════════════════════════════════════

  /**
   * 从用户消息中检测会晤意图（单人或多人）。
   *
   * V3.0 新增模式:
   *   🆕 间接呼唤（通过玉瑶）:
   *     "瑶瑶，你找XX过来一下" / "玉瑶，叫XX来"
   *     "瑶瑶，帮我把XX叫来" / "玉瑶，让XX过来，我有事找她"
   *   🆕 自然口语:
   *     "我想和XX说几句话" / "我有事找XX谈谈"
   *     "叫XX出来" / "让XX来跟我说" / "让XX也来"
   *
   * 已有模式:
   *   直接呼唤: "跟XX聊聊" / "@XX" / "XX："
   *   多人: "叫上 A 和 B 一起聊" / "开个会，A B C 参加"
   *
   * @returns 检测到的实体名列表（多人模式返回多个），若无意图返回 null
   */
  static detectUserIntent(message: string, knownPersonNames: string[]): string[] | null {
    if (!message || knownPersonNames.length === 0) return null;

    const sorted = [...knownPersonNames].sort((a, b) => b.length - a.length);
    const msg = message.trim();

    // ── 多人模式检测 ──

    // "叫上 A 和 B" / "叫 A、B、C 一起"
    const multiMatch = msg.match(/[叫喊让找]\s*(?:上\s*)?(.+?)\s*(?:一起|都来|过来|开会|聊聊|讨论|聚一聚|碰个头)/);
    if (multiMatch) {
      const found: string[] = [];
      for (const name of sorted) {
        if (multiMatch[1].includes(name)) found.push(name);
      }
      if (found.length >= 2) return found;
    }

    // "开个会，A B C" / "小组讨论，A B C 参加"
    const meetingMatch = msg.match(/(?:开会|小组讨论|群聊|多人|会议)\s*[,，]?\s*(.+?)(?:\s*参加|\s*参与|\s*一起|\s*都|$)/);
    if (meetingMatch) {
      const found: string[] = [];
      for (const name of sorted) {
        if (meetingMatch[1].includes(name)) found.push(name);
      }
      if (found.length >= 2) return found;
    }

    // "A 和 B 和 C" 模式
    const andMatch = msg.match(/([一-龥]{2,4})(?:\s*(?:和|跟|与|、)\s*([一-龥]{2,4}))+/);
    if (andMatch) {
      const allNames = new Set<string>();
      const namePattern = /[一-龥]{2,4}/g;
      let m: RegExpExecArray | null;
      const msgStart = andMatch[0];
      while ((m = namePattern.exec(msgStart)) !== null) {
        const name = sorted.find(n => n === m![0]);
        if (name) allNames.add(name);
      }
      if (allNames.size >= 2 && /一起|都|开会|聊|讨论|聚/.test(msg)) {
        return [...allNames];
      }
    }

    // ── 单人模式检测 ──
    // 优先级: @name > 间接呼唤 > 自然口语 > 直接呼唤

    // @name（最明确的意图）
    const atMatch = msg.match(/^@([一-龥\w]{1,8})(?:\s|$)/);
    if (atMatch) {
      const name = sorted.find(n => n === atMatch[1]);
      if (name) return [name];
    }

    // name：格式（如 "徐诗雨：" "阿珍，"）
    const prefixMatch = msg.match(/^([一-龥]{2,8})[：:，,]/);
    if (prefixMatch) {
      const name = sorted.find(n => n === prefixMatch[1]);
      if (name) return [name];
    }

    // 🆕 间接呼唤（通过玉瑶）: "瑶瑶，叫XX来" / "玉瑶，找XX过来"
    // 匹配: (瑶瑶|玉瑶)[，,]? (叫|找|喊|让|帮.*叫|帮.*找) XX (过来|来|一下)
    const indirectMatch = msg.match(/(?:瑶瑶|玉瑶|瑶儿)\s*[,，]?\s*(?:你?|帮我?)?\s*(?:叫|找|喊|让|把)\s*(.+?)\s*(?:过来|来一下|过来一下|来|一下|出来)\s*(?:[，,].*)?$/);
    if (indirectMatch) {
      const target = indirectMatch[1].trim();
      // 尝试精确匹配
      const exactName = sorted.find(n => n === target);
      if (exactName) return [exactName];
      // 模糊匹配（名字可能带后缀如"徐诗雨过来"）
      for (const name of sorted) {
        if (target.startsWith(name) || target.includes(name)) {
          return [name];
        }
      }
    }

    // 🆕 间接呼唤变体: "瑶瑶/玉瑶，我有事找XX聊聊" / "瑶瑶，我想和XX说说话"
    const indirectV2Match = msg.match(/(?:瑶瑶|玉瑶|瑶儿)\s*[,，]?\s*.+?(?:找|叫|和|跟)\s*(.+?)\s*(?:聊聊|谈谈|说说话|聊一下|说几句|说点事)/);
    if (indirectV2Match) {
      for (const name of sorted) {
        if (indirectV2Match[1].includes(name)) return [name];
      }
    }

    // 🆕 自然口语: "我想找XX聊聊" / "我想和XX说说话" / "让XX来跟我说" / "我有事找XX"
    for (const name of sorted) {
      // "我想找XX聊聊" / "我想和XX说说话" / "想跟XX聊" / "我要找XX"
      // 用 .*? 替代 \s* 解决"想找"/"想和"中间多一个动词的问题
      if (new RegExp(`(?:想|想要|要)${name}\\s*(?:聊聊|谈谈|说说话|说几句|说点事|聊一下|说话|聊聊天)`).test(msg)) {
        return [name];
      }
      // "想(找|跟|和|叫)XX" — 中间动词变体
      if (new RegExp(`(?:想|想要|要)\\s*(?:找|跟|和|叫|喊|让)\\s*${name}`).test(msg)) {
        return [name];
      }
      // "那你以XX的身份和我聊" / "用XX的身份" / "扮演XX"
      if (new RegExp(`(?:以|用|作为)\\s*${name}\\s*(?:的)?\\s*(?:身份|角色|语气|口吻)`).test(msg)) {
        return [name];
      }
      // "叫XX出来" / "让XX来" / "喊XX过来"
      if (new RegExp(`[叫让喊]\\s*${name}\\s*(?:出来|来|过来)\\s*(?:[，,].*)?$`).test(msg)) {
        return [name];
      }
      // "我有事找XX" / "有事找XX谈谈"
      if (new RegExp(`有事(?:情|儿)?\\s*(?:找|和|跟)\\s*${name}`).test(msg)) {
        return [name];
      }
      // "找XX聊聊" / "跟XX聊聊" / "和XX说说话"（句首或句中）
      if (new RegExp(`(?:^|[ .,，。!！?？、])\\s*(?:跟|和|找|喊|叫)\\s*${name}\\s*(?:聊聊|聊一下|说说话|来一下|过来|出来|说几句)`).test(msg)) {
        return [name];
      }
      // 最宽泛兜底：消息中包含XX且结尾有"聊聊/谈谈/说说话/聊一下"
      if (new RegExp(`${name}.*(?:聊聊|谈谈|说说话|聊一下|说几句)\\s*$`).test(msg)) {
        return [name];
      }
      // 简短直接: "找XX" / "叫XX" / "让XX来" 句尾
      if (new RegExp(`(?:^|[ .,，。!！?？、])\\s*(?:找|叫|喊|让)\\s*${name}\\s*$`).test(msg)) {
        return [name];
      }
    }

    return null;
  }

  /**
   * 🆕 V3.0: 检测会中换人意图（会晤已激活时调用）。
   *
   * 模式:
   *   "换XX来" / "让XX也来" / "不聊了，叫XX"
   *   "先这样吧，换XX" / "叫XX过来替一下"
   *
   * @returns 要切换到的实体名，若无换人意图返回 null
   */
  static detectSwitchIntent(message: string, knownPersonNames: string[]): string | null {
    if (!message || knownPersonNames.length === 0) return null;

    const sorted = [...knownPersonNames].sort((a, b) => b.length - a.length);
    const msg = message.trim();

    // 纯退出（不换人）：这些是明确的退出信号
    if (/^(?:散会|结束.*会议|会议.*结束|不开了|今天就到这儿|今天就到这里|先这样|下了|拜拜|再见|先这样吧)\s*$/.test(msg)) {
      return null; // 不是换人，是退出
    }

    for (const name of sorted) {
      // "换XX来" / "换XX吧"
      if (new RegExp(`换\\s*${name}\\s*(?:来|吧|过来)?\\s*$`).test(msg)) return name;
      // "让XX也来" / "让XX来吧"
      if (new RegExp(`让\\s*${name}\\s*(?:也来|来吧|来|过来)`).test(msg)) return name;
      // "不聊了/先这样/散会，叫/换XX"
      if (new RegExp(`(?:不聊了|先这样|先这样吧|今天就到这|今天就到这里|散会)\\s*[,，]?\\s*(?:叫|换|找|让)\\s*${name}`).test(msg)) return name;
      // "叫XX来替一下" / "叫XX过来替"
      if (new RegExp(`叫\\s*${name}\\s*(?:来替|过来替|替一下|替)`).test(msg)) return name;
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
