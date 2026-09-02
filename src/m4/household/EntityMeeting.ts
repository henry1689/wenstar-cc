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
  /** 🆕 V5.0: 会晤开始时 conversationHistory 的索引，用于过滤历史 */
  meetingStartHistoryIndex: number;
}

/** 实体简要信息 */
interface EntityInfo {
  name: string;
  uuid: string;
  category: string;
}

/** 🆕 P1-1: 会晤意图分类 */
export type MessageIntentKind = 'exit' | 'wake' | 'switch' | 'addParticipant' | 'normal';

/** 🆕 P1-1: 意图分类结果 */
export interface MessageIntent {
  kind: MessageIntentKind;
  /** wake: 目标实体列表（多人）；switch/addParticipant: 目标实体；exit/normal: 空 */
  targets: string[];
}

export class EntityMeeting {
  private familyGraph: FamilyGraph;
  private gatekeeper: UUIDGatekeeper | null = null;
  private minutesStore: MeetingMinutesStore | null = null;
  /** 🔴 S2-G1: 持久化存储（engine_store 键值），用于会晤状态跨重启恢复 */
  private _storage: { getSQLite?: () => { queryAll(sql: string, params?: any[]): any[]; writeRaw?(sql: string, ...params: any[]): void; } } | null = null;

  /** 🔴 S2-G1: 会晤状态持久化 key（engine_store） */
  private static LAST_MEETING_KEY = 'entity_meeting_last_entity';

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

  /** 高频泛称词 — 会晤意图检测时排除（妹妹/老婆等不是实体名） */
  private static GENERIC_NAMES = new Set(['妹妹', '老婆', '妈妈', '爸爸', '姐姐', '哥哥', '弟弟']);

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
  // 🔴 S2-G1: 会晤状态持久化 — 跨重启自动恢复上次会晤实体
  // ═══════════════════════════════════════════════════════════════

  /** 注入存储（engine_store 键值）— 由 server.ts 传入 */
  setStorage(storage: any): void {
    this._storage = storage;
  }

  /** 记录当前会晤实体到持久化存储（enter/switchTo 时调用） */
  saveLastMeeting(): void {
    if (!this._meeting || !this._storage?.getSQLite) return;
    try {
      const sqlite = this._storage.getSQLite();
      if (sqlite && typeof sqlite.writeRaw === 'function') {
        sqlite.writeRaw(
          'INSERT OR REPLACE INTO engine_store (key, value, updated_at) VALUES (?, ?, ?)',
          EntityMeeting.LAST_MEETING_KEY,
          JSON.stringify({ entityName: this._meeting.entityName, entityUUID: this._meeting.entityUUID, savedAt: new Date().toISOString() }),
          new Date().toISOString(),
        );
        console.log('[EntityMeeting] 会晤状态已持久化: ' + this._meeting.entityName);
      }
    } catch (e) { console.warn('[EntityMeeting] 持久化失败:', (e as Error)?.message || e); }
  }

  /** 读取上次会晤实体（重启恢复用）。返回 null = 无持久化记录 */
  getLastMeeting(): { entityName: string; entityUUID: string } | null {
    if (!this._storage?.getSQLite) return null;
    try {
      const sqlite = this._storage.getSQLite();
      const rows = sqlite.queryAll('SELECT value FROM engine_store WHERE key = ?', [EntityMeeting.LAST_MEETING_KEY]);
      if (rows && rows.length > 0) {
        const parsed = JSON.parse(String((rows[0] as any).value || '{}'));
        if (parsed?.entityName && parsed?.entityUUID) {
          return { entityName: parsed.entityName, entityUUID: parsed.entityUUID };
        }
      }
    } catch { /* 读取失败返回 null */ }
    return null;
  }

  /** 重启后自动恢复上次会晤实体（若在玉瑶视角且无活跃会晤） */
  restoreLastMeeting(): boolean {
    if (this._meeting?.active || !this._storage) return false;
    const last = this.getLastMeeting();
    if (!last) return false;
    const entered = this.enter(last.entityName);
    if (entered) {
      console.log('[EntityMeeting] 🔄 重启自动恢复会晤: ' + last.entityName);
      return true;
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════
  // 会晤入口
  // ═══════════════════════════════════════════════════════════════

  /**
   * 开启与指定实体的单人会晤。
   */
  enter(entityName: string, startHistoryIndex: number = 0): MeetingState | null {
    const entity = this._resolveEntity(entityName);
    if (!entity) return null;

    // 🆕 V6.0: 已有会晤但未标记多人 → 自动升级
    if (this._meeting?.active && !this._meeting.isMulti) {
      const existing = this._resolveEntity(this._meeting.entityName);
      const entities: EntityInfo[] = existing ? [existing, entity] : [entity];
      if (existing && entities.length >= 2) {
        this._multiParticipants = entities;
        this._multiTurns = [];
        this._multiMeetingName = `多人会晤: ${entities.map(e => e.name).join('、')}`;
        this._meeting = {
          active: true, entityName: entity.name, entityUUID: entity.uuid,
          startedAt: this._meeting.startedAt, turnCount: 0,
          // P2-2: 会晤=用户+2人及以上实体（原 >=3，2 人错判为单人会晤）
          isMulti: entities.length >= 2,
          meetingStartHistoryIndex: startHistoryIndex || this._meeting.meetingStartHistoryIndex,
        };
        if (this.gatekeeper) {
          this.gatekeeper.startMeeting(this._multiMeetingName, entities.map(e => e.uuid));
        }
        console.log(`[EntityMeeting] 自动升级为多人: ${entities.length}人`);
    this._isFirstTurn = true;
    return this._meeting;
      }
    }

    this._meeting = {
      active: true,
      entityName: entity.name,
      entityUUID: entity.uuid,
      startedAt: new Date().toISOString(),
      turnCount: 0,
      isMulti: false,
      meetingStartHistoryIndex: startHistoryIndex,
    };

    if (this.gatekeeper) {
      this.gatekeeper.addSessionEntity(entity.uuid);
    }

    this._isFirstTurn = true;
    // 🔴 S2-G1: 持久化当前会晤实体（重启后自动恢复）
    this.saveLastMeeting();
    return this._meeting;
  }

  /** 🆕 V5.0: 设置会晤开始时的对话历史索引 */
  setMeetingStartHistoryIndex(index: number): void {
    if (this._meeting) {
      this._meeting.meetingStartHistoryIndex = index;
    }
  }

  /** 🆕 V5.0: 获取会晤开始时的对话历史索引 */
  getMeetingStartHistoryIndex(): number {
    return this._meeting?.meetingStartHistoryIndex ?? 0;
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
    // P2-2: 会晤=用户+2人及以上实体（原 >=3，2 人错判为单人会晤）
    const isMulti = entities.length >= 2;

    this._meeting = {
      active: true,
      entityName: primary.name,
      entityUUID: primary.uuid,
      startedAt: new Date().toISOString(),
      turnCount: 0,
      isMulti,
      meetingStartHistoryIndex: 0,  // V5.0: 多人模式由外部设置
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

    // 🔴 结构修复：清除持久化的会晤实体记录，防止 exit 后被 restoreLastMeeting 自动拉回。
    // enter() 时 saveLastMeeting() 写入 engine_store，exit() 必须对称清除——否则
    // "喊玉瑶退出"→下一轮普通消息→restoreLastMeeting 又恢复上个实体→角色混乱。
    try {
      const sqlite = this._storage?.getSQLite?.();
      if (sqlite && typeof sqlite.writeRaw === 'function') {
        sqlite.writeRaw('DELETE FROM engine_store WHERE key = ?', [EntityMeeting.LAST_MEETING_KEY]);
      }
    } catch (e) { console.warn('[EntityMeeting] 清除会晤持久化失败:', (e as Error)?.message || e); }

    return minutesResult ? { minutes: minutesResult } : null;
  }

  /**
   * 在会晤中切换到另一个实体。
   * 先退出当前会晤，再进入新实体。如果是多人会议则先存档纪要。
   */
  async switchTo(entityName: string): Promise<MeetingState | null> {
    const entity = this._resolveEntity(entityName);
    if (!entity) return null;

    // 🆕 V6.0: 多人模式下叠加参与者，不结束会议
    if (this._meeting?.isMulti) {
      const _already = this._multiParticipants.some(p => p.uuid === entity.uuid);
      if (!_already) {
        this._multiParticipants.push(entity);
        this._multiMeetingName = `多人会晤: ${this._multiParticipants.map(p => p.name).join('、')}`;
        if (this.gatekeeper) this.gatekeeper.addSessionEntity(entity.uuid);
      }
      this._meeting.entityName = entity.name;
      this._meeting.entityUUID = entity.uuid;
      this._isFirstTurn = true;
      return this._meeting;
    }

    // 单人模式：先退出再进入
    const _origStartIndex = this._meeting?.meetingStartHistoryIndex ?? 0;
    if (this._meeting) await this.exit();
    return this.enter(entityName, _origStartIndex);
  }

  /**
   * 记录一轮对话。
   * 在 chat.ts 中每次 LLM 回复后调用。
   */
  recordTurn(role: 'user' | 'assistant', content: string, speakerName?: string): void {
    if (!this._meeting?.isMulti) return;

    const speaker = speakerName ||
      (role === 'user' ? '鸿艺' : this._meeting.entityName);

    this._multiTurns.push({
      speaker,
      role,
      content,
      timestamp: new Date().toISOString(),
    });

    // 🆕 V6.0: 超过 150 轮时裁剪并告警
    if (this._multiTurns.length > 200) {
      console.warn(`[EntityMeeting] 会议轮次超 200，截断前 50 轮`);
      this._multiTurns = this._multiTurns.slice(-150);
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
  /**
   * 🆕 V5.2: 模糊名称匹配 — 支持短名/昵称
   * "诗雨" → 匹配 "徐诗雨"
   * 🆕 UUID 立法: 支持别名（"韵韵"→"徐诗韵"），任意称呼归一到 FG 主名
   */
  private static _fuzzyFindName(input: string, knownNames: string[], aliasMap?: Map<string, string>): string | null {
    if (!input || input.length < 2) return null;
    // 0. 🆕 别名精确匹配（UUID 立法核心）
    if (aliasMap && aliasMap.has(input)) {
      return aliasMap.get(input)!;
    }
    // 1. 精确匹配
    const exact = knownNames.find(n => n === input);
    if (exact) return exact;
    // 2. 包含匹配 (短名 ⊂ 全名, e.g. "诗雨" ⊂ "徐诗雨")
    const sup = knownNames.find(n => n.includes(input));
    if (sup) return sup;
    // 3. 全名 ⊂ 输入 (e.g. input="找徐诗雨聊聊" ⊃ name)
    const sub = knownNames.find(n => input.includes(n));
    if (sub) return sub;
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // 🆕 P1-1: 意图前置校验门卫 — 统一五类指令分类
  // ═══════════════════════════════════════════════════════════════

  /**
   * P1-1: 统一意图分类 — 取代 chat.ts 里三块散落的会晤意图检测。
   * 优先级: exit(结束语) > addParticipant(群聊加人) > switch(显式换主发言) > wake(唤醒/开会) > normal。
   *
   * - exit: 散会/结束/拜拜/切回玉瑶 → 关闭对话组+锚点+清session+回玉瑶
   * - addParticipant: 群聊中"叫XX也来/参加/加入"
   * - switch: "换XX来/吧"（群聊内换主发言）
   * - wake: detectUserIntent 命中（找XX聊聊/开个会/@XX）→ 仅私聊-玉瑶态允许 enter
   * - normal: 普通消息
   */
  static detectIntent(
    message: string,
    knownPersonNames: string[],
    inMeeting: boolean = false,
    aliasMap?: Map<string, string>,
  ): MessageIntent {
    const msg = message.trim();
    // 🆕 UUID 立法: 别名归一化 — 别名映射到主名后加入匹配池，
    //   使"诗韵/韵韵/全芬"等任意称呼都能触发会晤（getUUIDByName 只认主名）。
    const _withAliases: string[] = aliasMap && aliasMap.size > 0
      ? (() => {
          const set = new Set(knownPersonNames);
          for (const [alias, main] of aliasMap.entries()) {
            if (main && main.length >= 2 && !set.has(main)) set.add(main);
          }
          return [...set];
        })()
      : knownPersonNames;

    // 1. 结束语（exit）— 不依赖人名。覆盖"结束吧/不聊了/先这样吧"等口语结束语。
    //    🔴 排除疑问句（"结束了吗/散会了没"不算退出，避免会晤中疑问误终止）。
    const _exit1 = /^(?:散会|不聊了|不开了|今天就到这儿|今天就到这里|先这样|下了|拜拜|再见)\s*(?:吧|了|啦|~|～|!|！)?\s*$/.test(msg)
      || /^结束\s*(?:了|吧|啦)?\s*(?:会议|对话|会晤|话题|我们|聊天)?\s*(?:吧|了|啦|~|～|!|！)?\s*$/.test(msg);
    // 🔴 P2-2: 句尾结束词扩展——"就聊到这，下次再聊""先这样吧""回聊"等自然句尾也算结束
    //   天然排除疑问句（词后可选字符不含"吗/么/？"）
    const _exitTail = /(?:聊到这儿|聊到这|就到这儿|就到这|先这样|不聊了|下了|拜拜|再见|下次再聊|改天聊|回聊|回头聊|下次聊|回头再聊)\s*(?:吧|了|啦|~|～|!|！)?\s*$/.test(msg);
    if (
      _exit1 || _exitTail
      || /^(?:切回|回到|换回|变回)\s*(?:玉瑶|瑶瑶|瑶儿)\s*$/.test(msg)
      || /^(?:和|跟|找|叫|让)?\s*(?:玉瑶|瑶瑶|瑶儿)\s*(?:聊聊|谈谈|说说话|聊一下|聊天)?\s*$/.test(msg)
    ) {
      return { kind: 'exit', targets: [] };
    }

    if (!_withAliases || _withAliases.length === 0) return { kind: 'normal', targets: [] };

    const sorted = [..._withAliases]
      .filter(n => !EntityMeeting.GENERIC_NAMES.has(n) && n !== '玉瑶')  // 🔴 玉瑶=默认本体，不可作唤醒候选（"玉瑶，你现在在哪"→normal，防前缀"玉瑶，"误判 wake 答非所问）
      .sort((a, b) => b.length - a.length);

    // 2. 群聊加人（addParticipant）: "叫XX也来/参加/加入/进来"
    const addMatch = msg.match(/(?:叫|让|喊|把)\s*([一-龥]{2,4})\s*(?:也)?\s*(?:来|过来|参加|加入|进来)/);
    if (addMatch) {
      const name = EntityMeeting._fuzzyFindName(addMatch[1], sorted, aliasMap);
      if (name) return { kind: 'addParticipant', targets: [name] };
    }

    // 3. 显式换主发言（switch）: "换XX来/吧"
    const swMatch = msg.match(/^换\s*([一-龥]{2,4})\s*(?:来|吧)?\s*$/);
    if (swMatch) {
      const name = EntityMeeting._fuzzyFindName(swMatch[1], sorted, aliasMap);
      if (name) return { kind: 'switch', targets: [name] };
    }

    // 4. 唤醒/开会（wake）
    // 🔴 P2-2: 会晤中(inMeeting)用严格模式——只认明确切换句式，跳过确认/寒暄/兜底
    //   （"全芬你还是那么丰满"→normal，不再误判为唤醒王全芬触发门卫拒绝）
    const wake = EntityMeeting.detectUserIntent(msg, sorted, inMeeting, aliasMap);
    if (wake && wake.length > 0) {
      return { kind: 'wake', targets: wake };
    }

    return { kind: 'normal', targets: [] };
  }

  static detectUserIntent(message: string, knownPersonNames: string[], inMeeting: boolean = false, aliasMap?: Map<string, string>): string[] | null {
    if (!message || knownPersonNames.length === 0) return null;
    // P2-2: 会晤中严格模式——确认/寒暄类（你是X吗/XX在吗/消息含名字且短）不算切换意图
    const _strict = inMeeting === true;

    // 🆕 V10.0 P1-5 补充: 所有路径排除高频泛称词
    const sorted = [...knownPersonNames]
      .filter(n => !EntityMeeting.GENERIC_NAMES.has(n) && n !== '玉瑶')  // 🔴 玉瑶=默认本体，不可作唤醒候选（"玉瑶，你现在在哪"→normal，防前缀"玉瑶，"误判 wake 答非所问）
      .sort((a, b) => b.length - a.length);
    const msg = message.trim();

    // 🆕 V6.0: "A、B，都来" / "A B C 都过来一起"
    const duMatch = msg.match(/^(.+?)[，,、\s]*(?:都来|都过来|都过来一下|都来一下|都聊聊|都一起)\s*$/);
    if (duMatch) {
      const found: string[] = [];
      for (const name of sorted) {
        if (duMatch[1].includes(name)) found.push(name);
      }
      if (found.length >= 2) return found;
    }

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
        const name = EntityMeeting._fuzzyFindName(m![0], sorted, aliasMap);
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
      const name = EntityMeeting._fuzzyFindName(atMatch[1], sorted, aliasMap);
      if (name) return [name];
    }

    // name：格式（如 "徐诗雨：" "阿珍，"）
    // 🔴 P2-2: 会晤中跳过——"徐诗雨：" 可能是对当前对象的对话称呼，非切换意图
    const prefixMatch = msg.match(/^([一-龥]{2,8})[：:，,]/);
    if (!_strict && prefixMatch) {
      const name = EntityMeeting._fuzzyFindName(prefixMatch[1], sorted, aliasMap);
      if (name) return [name];
    }

    // 🆕 V9.0: 纯名字（无标点）—— "诗雨" / "梓铭" 单独一句话
    // 🔴 P2-2: 会晤中跳过——"熊勇不在家真好"是 2-8 字纯汉字，会被误当名字并模糊匹配
    const bareMatch = msg.match(/^([一-龥]{2,8})\s*$/);
    if (!_strict && bareMatch) {
      const name = EntityMeeting._fuzzyFindName(bareMatch[1], sorted, aliasMap);
      if (name) return [name];
    }

    // 🆕 间接呼唤（通过玉瑶）: "瑶瑶，叫XX来" / "玉瑶，找XX过来"
    // 匹配: (瑶瑶|玉瑶)[，,]? (叫|找|喊|让|帮.*叫|帮.*找) XX (过来|来|一下)
    const indirectMatch = msg.match(/(?:瑶瑶|玉瑶|瑶儿)\s*[,，]?\s*(?:你?|帮我?)?\s*(?:叫|找|喊|让|把)\s*(.+?)\s*(?:过来|来一下|过来一下|来|一下|出来)\s*(?:[，,].*)?$/);
    if (indirectMatch) {
      const target = indirectMatch[1].trim();
      // 尝试精确匹配
      const exactName = EntityMeeting._fuzzyFindName(target, sorted, aliasMap);
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

    // 🆕 V5.2: 构建模糊名列表（全名 + 短名）用于 regex 匹配
    const _fuzzyNameList: Array<{ full: string; short: string | null }> = sorted.map(name => ({
      full: name,
      short: name.length >= 3 ? name.slice(-2) : null,  // "徐诗雨" → short="诗雨"
    }));
    // 🆕 UUID 立法: 追加别名（"韵韵"→"徐诗韵"），任意称呼都能匹配
    if (aliasMap && aliasMap.size > 0) {
      for (const [alias, main] of aliasMap.entries()) {
        if (!alias || alias.length < 1 || alias === main) continue;
        if (sorted.includes(main) && !_fuzzyNameList.some(nt => nt.full === alias)) {
          _fuzzyNameList.push({ full: alias, short: null });
        }
      }
    }

    // 🆕 自然口语: "我想找XX聊聊" / "我想和XX说说话" / "让XX来跟我说" / "我有事找XX"
    for (const nt of _fuzzyNameList) {
      const rawName = nt.full;
      // 🆕 UUID 立法: 正则用原文（别名）匹配，返回归一到主名（"韵韵"→"徐诗韵"）
      const returnName = (aliasMap && aliasMap.get(rawName) && aliasMap.get(rawName) !== rawName)
        ? aliasMap.get(rawName)!
        : rawName;
      const _nameRe = nt.short ? `(?:${rawName}|${nt.short})` : rawName;
      // "我想找XX聊聊" / "我想和XX说说话" / "想跟XX聊" / "我要找XX"
      // 用 .*? 替代 \s* 解决"想找"/"想和"中间多一个动词的问题
      if (new RegExp(`(?:想|想要|要)${_nameRe}\\s*(?:聊聊|谈谈|说说话|说几句|说点事|聊一下|说话|聊聊天)`).test(msg)) {
        return [returnName];
      }
      // "想(找|跟|和|叫)XX" — 中间动词变体
      if (new RegExp(`(?:想|想要|要)\\s*(?:找|跟|和|叫|喊|让)\\s*${_nameRe}`).test(msg)) {
        return [returnName];
      }
      // "那你以XX的身份和我聊" / "用XX的身份" / "扮演XX"
      if (new RegExp(`(?:以|用|作为)\\s*${_nameRe}\\s*(?:的)?\\s*(?:身份|角色|语气|口吻)`).test(msg)) {
        return [returnName];
      }
      // "叫XX出来" / "让XX来" / "喊XX过来"
      if (new RegExp(`[叫让喊]\\s*${_nameRe}\\s*(?:出来|来|过来)\\s*(?:[，,].*)?$`).test(msg)) {
        return [returnName];
      }
      // "我有事找XX" / "有事找XX谈谈"
      if (new RegExp(`有事(?:情|儿)?\\s*(?:找|和|跟)\\s*${_nameRe}`).test(msg)) {
        return [returnName];
      }
      // "找XX聊聊" / "跟XX聊聊" / "和XX说说话"（句首或句中）
      if (new RegExp(`(?:^|[ .,，。!！?？、])\\s*(?:跟|和|找|喊|叫)\\s*${_nameRe}\\s*(?:聊聊|聊一下|说说话|来一下|过来|出来|说几句)`).test(msg)) {
        return [returnName];
      }
      // 🆕 V10.0: 身份确认 — "你是XX吗"/"你叫XX"等（直接用 includes 避免正则编码问题）
      // 🔴 P2-2: 会晤中严格模式跳过——"全芬你还是那么丰满"是对话不是切换意图
      const _short = nt.short || '';
      const _isIdCheck = /(?:你是|你叫|你就是|你是叫)/.test(msg);
      if (!_strict && _isIdCheck && (msg.includes(rawName) || (_short && msg.includes(_short)))) {
        if (msg.length <= rawName.length + 8) {
          console.log(`[EntityMeeting ID] 身份确认匹配: "${msg}" → name="${_nameRe}" short="${_short}"`);
          return [returnName];
        }
      }
      // 🆕 V10.0: "XX在吗"
      const _isHereCheck = /(?:在吗|在不|在不在)/.test(msg);
      if (!_strict && _isHereCheck && (msg.includes(rawName) || (_short && msg.includes(_short)))) {
        if (msg.length <= rawName.length + 6) return [returnName];
      }
      // 最宽泛兜底：消息中包含XX且结尾有"聊聊/谈谈/说说话/聊一下"
      // 🔴 P2-2: 会晤中跳过（"我们聊聊"可能是对当前对象的对话，非切换）
      if (!_strict && new RegExp(`${_nameRe}.*(?:聊聊|谈谈|说说话|聊一下|说几句)\\s*$`).test(msg)) {
        return [returnName];
      }
      // 简短直接: "找XX" / "叫XX" / "让XX来" 句尾
      if (new RegExp(`(?:^|[ .,，。!！?？、])\\s*(?:找|叫|喊|让)\\s*${_nameRe}\\s*$`).test(msg)) {
        return [returnName];
      }
    }

    // 🆕 V10.0 P1-5: 终极兜底（泛称词已在 sorted 中排除）
    // 🔴 P2-2: 会晤中跳过——"全芬你还是那么丰满"含短名"全芬"且消息短 → 误判为唤醒
    for (const name of sorted) {
      if (!_strict && msg.includes(name) && msg.length <= name.length + 5) return [name];
      // 🆕 V10.0 修复: 消息含短名且消息≤10字也触发（之前≤4字太严，漏掉"你是诗雨吗"等6字消息）
      if (!_strict && msg.length <= 10 && msg.length >= 2 && msg.length < name.length && name.includes(msg)) return [name];
    }

    return null;
  }

  /**
   * 🆕 V6.0: 检测集体呼唤意图（"你们"、"大家"、"都过来"）。
   * 仅在会晤已激活（多人模式）时有效。
   */
  static detectCollectiveIntent(message: string, activeParticipants: string[]): string[] | null {
    if (!message || activeParticipants.length < 2) return null;
    const msg = message.trim();

    // "你们一起回忆一下" / "大家都来聊聊" / "你们几个"
    if (/^(?:你们|大家|诸位)\s*(?:一起|都|几个|各位)?\s*(?:回忆|聊聊|说说|谈谈|看看|讨论|过来|来)/.test(msg)) {
      return [...activeParticipants];
    }
    // "都过来" / "都来" / "一起来"
    if (/^(?:都过来|都来|一起来|一起聊聊|一起回忆)/.test(msg)) {
      return [...activeParticipants];
    }
    // "你们几个回忆一下那天"
    if (/你们(?:几个|俩|仨|几个人)/.test(msg) && /回忆|聊聊|说说|讨论/.test(msg)) {
      return [...activeParticipants];
    }
    return null;
  }

  /** 🆕 V6.0: 向多人会议追加参与者 */
  addParticipant(entityName: string): boolean {
    const entity = this._resolveEntity(entityName);
    if (!entity || !this._meeting?.isMulti) return false;
    if (this._multiParticipants.some(p => p.uuid === entity.uuid)) return false;
    this._multiParticipants.push(entity);
    this._multiMeetingName = `多人会晤: ${this._multiParticipants.map(p => p.name).join('、')}`;
    if (this.gatekeeper) this.gatekeeper.addSessionEntity(entity.uuid);
    if (this._multiParticipants.length >= 3 && !this._meeting.isMulti) {
      this._meeting.isMulti = true;
    }
    return true;
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

    // 退出或无关信号
    if (/^(?:散会|结束.*会议|瑶瑶|玉瑶|瑶儿|拜拜|再见|先这样|下了)\s*$/.test(msg)) return null;

    // 🛡️ V10.0: 明确切换句式（"换XX"类）
    for (const name of sorted) {
      // ✅ "换XX来" / "换XX吧"
      if (new RegExp(`^换\\s*${name}\\s*(?:来|吧|过来)?\\s*$`).test(msg)) return name;
      // ✅ "换XX"（极短消息）
      if (new RegExp(`^换\\s*${name}\\s*$`).test(msg)) return name;
      // ✅ "不聊了/散会/今天就到这，叫/换XX"
      if (new RegExp(`(?:不聊了|先这样吧|今天就到这|今天就到这里|散会)\\s*[,，]?\\s*(?:叫|换|找|让)\\s*${name}`).test(msg)) return name;
    }

    // 🆕 V10.12 修复: 自然语言切换 — 复用 detectUserIntent 的明确切换模式
    // 会晤中用户说"找XX聊聊"/"和XX谈谈"/"叫XX过来"/"让XX也来"等，应切换到该实体。
    // 关键保护: 只认"明确切换意图"句式，排除纯提及（如"阿珍呢"/"看到XX了吗"）。
    const intent = EntityMeeting.detectUserIntent(msg, sorted);
    if (intent && intent.length === 1) {
      const target = intent[0];
      // 明确切换动词（找/和/叫/让/换/想 等）
      const hasExplicitSwitch = /(?:找|和|跟|叫|让|喊|换|想|要|以|用|见)/.test(msg);
      const hasTail = /(?:聊聊|谈谈|说说话|说几句|说点事|聊一下|聊天|聊|来|过来|出来|身份|角色|也来)/.test(msg);
      // "XX在吗/在不" — 用户想确认 XX 在线并切换（如"熊梓铭在吗"）
      const isPresenceCheck = /在吗|在不|在不在/.test(msg) && msg.length <= target.length + 4;
      if ((hasExplicitSwitch && hasTail) || isPresenceCheck) return target;
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
      if (!uuid) { console.warn('[EntityMeeting] _resolveEntity uid miss: ' + name); return null; }
      let category = 'G';
      try { const entity = (this.familyGraph as any).getEntityByUUID?.(uuid); if (entity) category = entity.category || 'G'; } catch { /* non-critical */ }
      // 🔴 结构修复：系统本体（玉瑶，category='S'）不可会晤。
      // "找玉瑶聊聊" = 切回玉瑶本体视角 = 退出会晤，而不是进入"玉瑶会晤"（玉瑶自己扮演自己）。
      // 状态机合法状态集合中不应存在"本体会晤"——本体是回答者，不是可会晤实体。
      if (category === 'S') return null;
      return { name, uuid, category };
    } catch {
      return null;
    }
  }
}

export default EntityMeeting;
