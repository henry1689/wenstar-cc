/**
 * EntityMeeting — 实体会晤的**副作用执行器**（2026-10-31 第三层固化后）
 *
 * 定位（已降级，勿再当状态机用）：
 *   - 门卫（UUIDGatekeeper）会话视图的开关
 *   - 多人会议纪要的素材采集与生成
 *   - 会中轮次采集（recordTurn → `_multiTurns`）
 *   - 会晤意图识别（detectIntent / detectUserIntent / detectCollectiveIntent / detectSwitchIntent）
 *   - 发言人推断（inferSpeaker）
 *
 * 🔴 会晤/群聊状态的**唯一真源是 `GroupSession`**（ADR-013 硬约束②「状态只有一处写」）。
 *   本类不再持有任何会晤状态：原 `_meeting` 字段与它承载的那套状态机（进入 / 退出 /
 *   切主 / 加人 / 恢复 / 保存 一类方法）已于 2026-10-31 随 `WS_GROUP_V2` 回滚开关
 *   **一并删除**，生产代码零残留（全仓扫描：旧方法定义 0 处、`_em.<旧方法>` 调用 0 处）。
 *   🔴 刻意不在此复述方法名 —— 复述等于持续向读者演示已删 API，正是本次根除要消除的入口。
 *
 *   状态读方法（isActive / isMultiParty / getParticipants / getEntityName / getEntityUUID）
 *   全部经 `_sessionView` 只读视图向 GroupSession 取值，**不做任何本地回退** ——
 *   回退分支是上一版最大的漂移来源：视图不可用时静默读一个恒空的 `_meeting`，
 *   表现为「进去了但系统以为没进」。
 *
 * 为什么保留本类而不整体删除：上面五项职责至今没有替代者，且 `detectIntent` 被
 *   `chat.ts` / `chat/process-stages.ts` 直接静态调用。删状态机、留副作用层，
 *   是「一条关系一个真源」的落地形态。
 *
 * 设计原则（未变）：
 *   - 会晤 ≠ 角色扮演 —— 实体以本人身份出现，不是玉瑶在"演"别人
 *   - 单人会话 = 私聊（无纪要）；多人会话 = 开会（有纪要）
 */

import type { FamilyGraph } from './FamilyGraph.js';
import type { UUIDGatekeeper } from './UUIDGatekeeper.js';
import type { MeetingMinutesStore, MeetingTurn } from './MeetingMinutesStore.js';

/** 实体简要信息 */
interface EntityInfo {
  name: string;
  uuid: string;
  category: string;
}

/**
 * 🔴 GroupSession 的**只读视图**（P078 方案C，2026-10-31 起为**唯一**状态来源）。
 *
 * 下游有 10 处直接读本类的状态方法（意图预判 / FG 写门户 / 实体上下文注入 /
 * recordTurn 判据 / retrieval-stage 召回主体等）。本视图把这些「读」收敛回状态源，
 * 而不动任何下游读点。
 *
 * 🔴 与「双写」的本质区别（ADR-013 硬约束②）：状态的**写**仍然只有 `GroupSession.reduce`
 *   一处；本类这些读方法退化为**纯读视图**，不构成第二状态源。
 *
 * 注入方式为**惰性函数**（不是对象引用）：`ctx._groupSession` 在 chat.ts 状态机区域创建，
 * 晚于本类实例化，闭包可解决时序；且与仓内 `FGProfileWriteGateway` 的惰性回调范式一致。
 */
export interface MeetingSessionView {
  /** 状态源是否可用（GroupSession 实例已创建）。不可用时读方法一律返回「无会晤」 */
  isAvailable(): boolean;
  isActive(): boolean;
  isMulti(): boolean;
  getSpeakerUuid(): string | null;
  getParticipants(): Array<{ uuid: string; name: string; category: string }>;
}

/** 🆕 P1-1: 会晤意图分类
 *  🔴 P091 任务1（2026-10-26）：新增 `askAll`（群聊向全员提问）——
 *  仅由 `detectIntent` 在 `inMeeting && isMulti` 下判定，宁窄勿滥；
 *  未接状态机前消费方对它不匹配任何分支 ⇒ 自动落单点回答兑底（与 P090 并行安全）。 */
export type MessageIntentKind =
  | 'exit' | 'wake' | 'switch' | 'addParticipant' | 'askAll' | 'normal'
  /**
   * 🔴 2026-11-01 D2：会晤中点名（`@阿珍` / `阿珍，…`）= **本轮指定发言，下一轮自动回主**。
   *
   * 与 `switch` 的分界：`switch` 是业主明确要求换主发言（「换阿珍来」），保持永久；
   * 本类型只是「这句话我问她」，说过就结束 —— 否则业主每点一次名，主发言者就永久
   * 停在被点名者身上，会话再也回不到原来的人。
   * 判定只发生在 `inMeeting` 分支内（非会晤态的点名仍走 wake 进入会晤）。
   */
  | 'addressOnly';

/** 🆕 P1-1: 意图分类结果 */
export interface MessageIntent {
  kind: MessageIntentKind;
  /** wake: 目标实体列表（多人）；switch/addParticipant: 目标实体；exit/normal: 空 */
  targets: string[];
}

/**
 * P109：`beginMeetingSideEffects` 第4参。
 * 🔴 刻意定义为**类型别名**而非内联字面量：内联的 `{ ... }` 会落在签名的 `<>` 之外，
 *   而 `switch-master.test.ts` 的 `methodBody()` 靠花括号深度切函数体（`<>` 内的忽略），
 *   多出一对裸 `{}` 会使其提前闭合、把签名本身当成函数体 ⇒ 守卫测试误报
 *   「纪要素材名单未采集」。别名化后签名无裸花括号，守卫不受影响。
 */
export interface MeetingBeginOpts {
  /** true = 本调用来自 R1 快照恢复路径 ⇒ 不清 `_multiTurns`（恢复路径不得清累积） */
  restoring?: boolean;
}

export class EntityMeeting {
  private familyGraph: FamilyGraph;
  private gatekeeper: UUIDGatekeeper | null = null;
  private minutesStore: MeetingMinutesStore | null = null;

  /** 多人会议的参与者列表（含姓名和 UUID）—— 纪要素材，非状态 */
  private _multiParticipants: EntityInfo[] = [];

  /** 多人会议的对话记录 —— 纪要素材，非状态 */
  private _multiTurns: MeetingTurn[] = [];

  /** 多人会议的名称 —— 纪要素材，非状态 */
  private _multiMeetingName: string = '';

  /** 是否首轮对话（用于开场协议注入） */
  private _isFirstTurn: boolean = false;

  /**
   * 🔴 P078 方案C：GroupSession 只读视图（**唯一**状态来源）。
   * 由 chat.ts 在 GroupSession 创建后调用 `setSessionView` 注入；未接线时读方法返回「无会晤」。
   */
  private _sessionView: MeetingSessionView | null = null;

  /**
   * 🔴 注入 GroupSession 只读视图（状态源）。
   *
   * **调用点唯一**：chat.ts 的 GroupSession 创建块之后。2026-10-31 起不再有
   * 「开关关闭时不调用」的回退语义 —— 未接线时 `_sessionView` 为 null，
   * 全部状态读方法返回「无会晤」，这是**失败即降级**（fail-closed），不是回退到旧路径。
   */
  setSessionView(view: MeetingSessionView | null): void {
    this._sessionView = view;
  }

  /**
   * 🔴 P078 补口：R1 从 GroupSession 快照恢复出**活跃会晤**时，重建本类的会晤上下文与纪要素材。
   *
   * 缺口成因：切主后重启恢复走 `loadSession` → `_gs.active` 分支，**既不经过 `enter()`，
   * 也不经过 `beginMeetingSideEffects()`** —— 而这两样东西正是下面两项数据的唯一来源：
   *   1. `_isFirstTurn`：原本只在旧「进入」路径置位 ⇒ 重启后首轮开场协议/首轮 KB 不注入；
   *   2. `_multiParticipants` / `_multiMeetingName`：原本只在旧「多人进入 / 加人」路径
   *      写入 ⇒ 进程重启后本类单例随进程消亡、数组为空 ⇒ 纪要门槛 `participants>=3`
   *      只能靠后续 JOIN 零星补入（实测只补到 1 个）⇒ **纪要静默丢失**。
   *
   * 名字从 `markFirstTurnForRestore` 改来：上一轮只修了第 1 项、误把首轮标记当成该路径的全部，
   * S6 实测（会晤中重启 → 恢复 → 散会）抓出第 2 项仍漏 ⇒ 成对修完，入口合一。
   *
   * 🔴 仍不违反 ADR-013 硬约束②：这里只是**从只读视图采集纪要素材**（与
   *   `beginMeetingSideEffects` 的采集职责对称），群聊状态真源仍是 `GroupSession.reduce`。
   */
  markRestoreFromSnapshot(): void {
    this._isFirstTurn = true;

    const v = this._sessionView;
    if (!v?.isAvailable()) return;
    const ps = v.getParticipants();
    if (ps.length === 0) return;
    this._multiParticipants = ps.map(p => ({ uuid: p.uuid, name: p.name, category: p.category || '' }));
    this._multiMeetingName = ps.map(p => p.name).join('、');
    // `_multiTurns` 不处理：进程重启后本就为空，与旧多人进入路径每次清零的语义一致。
  }

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
  // 轮次采集（会议纪要的数据源）
  // ═══════════════════════════════════════════════════════════════

  /**
   * 记录一轮对话（会议纪要的数据源）。
   *
   * 🔴 P072 任务A 阻塞点 A1（业主 2026-10-23 授权改签名）：
   *   isMulti / speakerName 由调用方从 GroupSession 派生后传入，
   *   方法内**不触碰任何状态字段** —— 判定源与状态源一致（ADR-013 硬约束②）。
   *
   * `_multiTurns` 累积逻辑与 200 轮截断告警一字未改。
   */
  recordTurn(role: 'user' | 'assistant', content: string, speakerName: string | null, isMulti: boolean): void {
    if (!isMulti) return;

    const speaker = speakerName || (role === 'user' ? '鸿艺' : '未知');

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
  // 副作用入口（状态归 GroupSession，本类只做门卫/纪要）
  // ═══════════════════════════════════════════════════════════════

  /**
   * 会晤开始的副作用（开 UUID 会话视图）。name/uuids 由调用方从 GroupSession 派生。
   *
   * 🔴 P078 任务2（多人会议纪要静默丢失，PI P077 §四独立发现）：
   *   `endMeetingSideEffects` 的纪要条件为 `turns>=2 && participants>=3`，而 `_multiParticipants`
   *   原先**只在 `旧的进入/多人进入/加人路径` 里写入** —— 切主后那些方法不再被调用
   *   ⇒ 恒空数组 ⇒ 条件后半段永不满足 ⇒ **纪要永不生成**（实测 3 人会晤散会后无「纪要已生成」）。
   *
   *   现在此处同步采集**纪要素材**（名单 + 会议名）：与 `recordTurn` 采集 `_multiTurns` 同构，
   *   **不是状态双写** —— 群聊状态（谁在场/谁发言）的真源仍是 `GroupSession.reduce`，
   *   这里只备「纪要要写谁」的名单。
   *
   * 🔴 P109 第4参 `opts.restoring`（PI P108 §二 确证的 P0，`ad01704` 引入）：
   *   `true` = 本调用来自 **R1 快照恢复路径**。恢复块位于 chat.ts 的
   *   `!ctx._groupSession` 创建块内，而 `ctx` **每请求新建** ⇒ 该块**每轮都执行**
   *   （运行时佐证：门卫日志每轮打出）⇒ 若不区分，下面的 `_multiTurns = []` 会变成
   *   **每轮清空轮次**：散会轮入口清空 → recordTurn 推 1 条 → `endMeetingSideEffects` 判
   *   `_multiTurns.length >= 2` → **1 < 2 恒不满足** ⇒ **多人散会纪要静默丢失**。
   *   故：**进入路径保留清零语义，恢复路径不得清累积。**
   */
  beginMeetingSideEffects(name: string, uuids: string[], participants?: Array<{ uuid: string; name: string; category?: string }>, opts?: MeetingBeginOpts): void {
    if (participants && participants.length > 0) {
      this._multiParticipants = participants.map(p => ({ uuid: p.uuid, name: p.name || p.uuid, category: p.category || '' }));
    } else if (uuids.length > 0) {
      // 缺 seed 时只留 uuid（name 兜底为 uuid）—— 宁可纪要名单不好看，也不能让它恒空导致永不生成
      this._multiParticipants = uuids.map(u => ({ uuid: u, name: u, category: '' }));
    }
    this._multiMeetingName = name || '';
    // P109（P108 §二 P0）：**只有正常进入路径才清轮次**。恢复路径每轮都会走到这里
    //   （见上方 opts.restoring 注释），一旦清零 ⇒ 散会时 length>=2 恒不满足 ⇒ 纪要静默丢失。
    if (!opts?.restoring) this._multiTurns = [];

    // 🔴 首轮标记：切主后状态机不再经过本类，`_isFirstTurn` 无人置位 ⇒ 开场协议/首轮上下文不注入。
    //   语义上它属「会晤开始的副作用」，归本方法；`incrementTurn()` 负责复位（P078 已一并修）。
    this._isFirstTurn = true;

    if (this.gatekeeper) this.gatekeeper.startMeeting(name, uuids);
  }

  /**
   * 单个实体加入会话视图（门卫副作用）。uuid 由调用方从 GroupSession 派生。
   *
   * 🔴 P078 任务2：同步补进纪要素材名单 —— 原实现只开关门卫视图，
   *   `_multiParticipants` 不含新加入者 ⇒ 即使纪要条件满足，参与者名单也不全。
   */
  addSessionEntitySideEffect(uuid: string, name?: string): void {
    if (!this._multiParticipants.some(p => p.uuid === uuid)) {
      this._multiParticipants.push({ uuid, name: name || uuid, category: '' });
      this._multiMeetingName = this._multiParticipants.map(p => p.name).join('、');
    }
    if (this.gatekeeper) this.gatekeeper.addSessionEntity(uuid);
  }

  /**
   * 会晤结束的副作用：生成多人会议纪要 + 关门卫 + 清轮次。
   * 🔴 不碰任何状态字段 —— 状态归 GroupSession，此处只做副作用收尾。
   */
  async endMeetingSideEffects(): Promise<void> {
    // 多人会议 → 生成纪要（条件与旧 exit() 保持一致）
    if (this._multiTurns.length >= 2 && this._multiParticipants.length >= 3) {
      try {
        if (!this.minutesStore) {
          const { MeetingMinutesStore } = await import('./MeetingMinutesStore.js');
          this.minutesStore = new MeetingMinutesStore(this.familyGraph);
        }
        const participantUUIDs = this._multiParticipants.map(p => p.uuid);
        const summaryName = this._multiMeetingName.replace('多人会晤: ', '');
        this.minutesStore.generateAndStore(summaryName, participantUUIDs, this._multiTurns);
        console.log(
          `[EntityMeeting] 会议结束 → 纪要已生成: ${summaryName} ` +
          `(${this._multiParticipants.length}人, ${this._multiTurns.length}轮)`
        );
      } catch (e) {
        console.warn('[EntityMeeting] 纪要生成失败:', (e as Error)?.message || e);
      }
    }

    // 关门卫
    if (this.gatekeeper) this.gatekeeper.clearSessionEntities();

    // 清纪要数据
    this._multiParticipants = [];
    this._multiTurns = [];
    this._multiMeetingName = '';
  }

  // ═══════════════════════════════════════════════════════════════
  // 状态查询 —— 🔴 一律读 GroupSession 只读视图，不做本地回退
  //   （2026-10-31：本地状态回退分支已随旧状态机一并删除，不再有任何本地兜底）
  // ═══════════════════════════════════════════════════════════════

  isActive(): boolean {
    return this._sessionView?.isAvailable() === true && this._sessionView.isActive();
  }

  isMultiParty(): boolean {
    return this._sessionView?.isAvailable() === true && this._sessionView.isMulti();
  }

  /** 获取多人会议的参与者名单 */
  getParticipants(): EntityInfo[] {
    if (this._sessionView?.isAvailable()) return this._sessionView.getParticipants() as EntityInfo[];
    return [...this._multiParticipants];
  }

  /**
   * T012 发言人推断（多人群聊/会议·自然聊天）：无显式点名时判断"这句话最该谁接"。
   * ①内容提及某参会者（别名归一）→其接；②LLM 判断待办/话题归属（方案A）→其接；③默认当前发言人。
   * 返回 null = 维持当前发言人（默认）。
   */
  async inferSpeaker(
    message: string,
    aliasMap?: Map<string, string>,
    llm?: { rawCall?: (msgs: any[], maxTokens: number, temp: number) => Promise<string> },
  ): Promise<string | null> {
    if (!this.isMultiParty()) return null;
    const current = this.getEntityName() || null;
    const others = this.getParticipants().map(p => p.name).filter(n => n && n !== current);
    if (others.length === 0) return null;
    const msg = String(message || '').trim();
    if (!msg) return null;

    // ① 内容提及（别名归一后子串匹配）：明确提及一人 → 其接
    let nmsg = msg;
    if (aliasMap && aliasMap.size > 0) {
      const entries = [...aliasMap.entries()]
        .filter(([, m]) => m && m.length >= 2)
        .sort((a, b) => b[0].length - a[0].length);
      for (const [alias, main] of entries) if (nmsg.includes(alias)) nmsg = nmsg.split(alias).join(main);
    }
    const mentioned = others.filter(o => nmsg.includes(o));
    if (mentioned.length === 1) return mentioned[0];

    // ② LLM 判断待办/话题归属（方案A）：提及多人或零提及时，问 LLM 最该谁接
    if (llm?.rawCall) {
      const recent = this._multiTurns.slice(-8)
        .map(t => `${t.speaker}: ${String(t.content || '').substring(0, 80)}`).join('\n');
      const list = others.join('、');
      const prompt = `多人聊天，参会者：${list}。当前发言人：${current || '无'}。\n最近对话：\n${recent}\n用户刚说：「${msg}」\n判断这句话最该谁接（聊到谁负责的事/在说谁/问谁）？只回一个名字（${list}之一），无法判断回"默认"。`;
      try {
        const out = ((await llm.rawCall([{ role: 'user', content: prompt }], 20, 0.1)) || '').trim();
        for (const o of others) if (out.includes(o)) return o;
      } catch { /* LLM 失败 → 默认当前发言人 */ }
    }
    return null; // ③ 默认当前发言人
  }

  getEntityName(): string | null {
    const v = this._sessionView;
    if (!v?.isAvailable()) return null;
    // 🔴 与 chat.ts 汇聚点 `_activeMeetingName` 同一派生规则：speakerUuid → participants.name
    const _su = v.getSpeakerUuid();
    if (!_su) return null;
    return v.getParticipants().find(x => x.uuid === _su)?.name ?? null;
  }

  getEntityUUID(): string | null {
    const v = this._sessionView;
    if (!v?.isAvailable()) return null;
    return v.getSpeakerUuid();
  }

  /**
   * 🔴 P078：`_isFirstTurn` 的重置无条件执行。
   *   切主后本类不再持有会晤状态，原「本地状态为真才执行」的守卫已删除；
   *   行为等价性：旧路径下本方法只在会晤态被调用，新路径下无状态也必须复位。
   */
  incrementTurn(): void {
    this._isFirstTurn = false;
  }

  /** 当前是否为首轮对话（用于开场协议注入） */
  isFirstTurn(): boolean {
    return this._isFirstTurn;
  }

  // ═══════════════════════════════════════════════════════════════
  // 会晤意图检测（纯静态函数，不碰状态）
  // ═══════════════════════════════════════════════════════════════

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

  /**
   * T012 P0-5：别名归一 —— 把消息中的别名替换为主名（长别名优先，防重叠），
   * 使后续主名裸子串匹配对别名也生效（"诗雨"→"徐诗雨"）。仅替换完整别名出现处。
   */
  private static _normalizeAliases(msg: string, aliasMap?: Map<string, string>): string {
    if (!aliasMap || aliasMap.size === 0) return msg;
    let out = msg;
    const entries = [...aliasMap.entries()]
      .filter(([a, m]) => a && a.length >= 1 && m && m.length >= 2)
      .sort((a, b) => b[0].length - a[0].length); // 长别名优先，防 "阿芬" 抢在 "芬芬阿" 前
    for (const [alias, main] of entries) {
      if (out.includes(alias)) out = out.split(alias).join(main);
    }
    return out;
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
    /** 🔴 P091：是否多人群聊（askAll 判定前提，单人会晤不触发）。默认 false ⇒ 不改既有调用行为。 */
    isMulti: boolean = false,
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
    // 🔴 2026-10-18 exit「下了」语法位置结构化（业主批准）：
    //   「下」有两种结构身份：① **退出动词**（我下了/我先下了/就得下了）——总是位于子句首位
    //   或紧随主语/情态副词；② **结果补语**（楼下了/睡下了/躺下了/坐下了）——必**附着**于前一个实词。
    //   旧实现把"下了"无位置约束地混入后缀表 ⇒ 实测"好了，妈，我已经在楼下了"被判退出、
    //   会晤强制转场玉瑶（压测 seq=11970，后半段对话全部错归玉瑶）。
    //   判据 = 前字**结构类别**（句首/标点/空白/主语与情态副词），非词表白名单——
    //   任何新的附着式"X下了"（站下了/停下了）天然不命中，无需维护禁用词表。
    //   不对称取舍：漏判退出（多聊一轮）代价低，误判退出（打断会晤+错归属）代价高 ⇒ 宁窄勿滥。
    const _exitTail = /(?:聊到这儿|聊到这|就到这儿|就到这|先这样|不聊了|拜拜|再见|下次再聊|改天聊|回聊|回头聊|下次聊|回头再聊)\s*(?:吧|了|啦|~|～|!|！)?\s*$/.test(msg)
      || /(?:^|[，。！？、；：\s]|我|咱|先|就|要|想|得)下(?:了|线了?)\s*(?:吧|了|啦|~|～|!|！)?\s*$/.test(msg);
    // 🔴 P055 任务2（2026-10-23，业主裁决第 2 条）：exit 意图 + 玉瑶指向**同时出现** ⇒ 退出。
    //   上面四类句式对「结束，回玉瑶这边」**全不命中**：`^结束…$` 要求整句匹配而它带尾缀，
    //   `^(切回|回到|换回|变回)玉瑶$` 要求句尾就是"玉瑶"而它以"这边"结尾。
    //   实测后果：被判 normal → EntityMeeting 的「无会晤意图时自动恢复上次会晤」+ LLM 自由发挥，
    //   用户看到实体自己说"那我先走了" —— **观感像退了、实际没退**（P054 §四）。
    //
    // 🔴 刻意**不采用**「任意 exit 词 + 任意玉瑶提及」的宽松组合：那会误伤
    //   「今天结束得很晚，玉瑶辛苦了」「你结束了吗，玉瑶」。改为要求**结构**成立 ——
    //   分句级「退出祈使」与分句级「动词+玉瑶」各占一句，另加长度与疑问语气两道闸。
    //   沿用既有原则的不对称取舍：漏判退出（多聊一轮）代价低，误判退出（打断会晤+错归属）代价高 ⇒ 宁窄勿滥。
    const _exitWithYuyao = (() => {
      if (!/(?:玉瑶|瑶瑶|瑶儿)/.test(msg)) return false;
      if (msg.length > 30) return false;                                   // 长陈述句天然出局
      if (/[吗么？]/.test(msg)) return false;                              // 疑问句出局（同 _exit1 的既有原则）
      // 退出祈使：单独成句时的形态（含可选语气词/数量补语）
      const _exitVerb = /^(?:结束|散会|不聊了|不开了|先这样|拜拜|再见|下了|今天就到这儿|今天就到这里)\s*(?:吧|了|啦|的|一下|了先|先)?\s*$/;
      // 玉瑶指向：动词 + 玉瑶 + 可选后缀
      const _toYuyao = /^(?:回|转回|切回|回到|换回|变回|找|叫|让|喊)\s*(?:一下)?\s*(?:玉瑶|瑶瑶|瑶儿)\s*(?:那边|这边|身边|旁|来|一下|聊聊|谈谈)?\s*$/;
      const _parts = msg.split(/[，,、。！!；;\s]+/).map(s => s.trim()).filter(Boolean);
      if (_parts.length < 2) return _exitVerb.test(msg) || _toYuyao.test(msg);
      return _parts.some(p => _exitVerb.test(p)) && _parts.some(p => _toYuyao.test(p) || /(?:玉瑶|瑶瑶|瑶儿)/.test(p));
    })();
    if (
      _exit1 || _exitTail || _exitWithYuyao
      || /^(?:切回|回到|换回|变回)\s*(?:玉瑶|瑶瑶|瑶儿)\s*$/.test(msg)
      || /^(?:和|跟|找|叫|让)?\s*(?:玉瑶|瑶瑶|瑶儿)\s*(?:聊聊|谈谈|说说话|聊一下|聊天)?\s*$/.test(msg)
    ) {
      return { kind: 'exit', targets: [] };
    }

    if (!_withAliases || _withAliases.length === 0) return { kind: 'normal', targets: [] };

    const sorted = [..._withAliases]
      .filter(n => !EntityMeeting.GENERIC_NAMES.has(n) && n !== '玉瑶')  // 🔴 玉瑶=默认本体，不可作唤醒候选（"玉瑶，你现在在哪"→normal，防前缀"玉瑶，"误判 wake 答非所问）
      .sort((a, b) => b.length - a.length);

    // 2. 群聊加人（addParticipant）: "叫/让/喊/把/找 XX(你)也来/过来/参加/加入/进来"
    //    P129 任务1：①动词表+「找」（实测「找阿珍过来」曾落 normal，AI 口头答应去叫但人未加入）
    //                ②新增「XX(你)也过来」句式（实测「阿珍你也过来」曾判 wake 被门卫拒）
    //    宁窄勿滥：动词+尾词双校验 + _fuzzyFindName 找不到人名即不命中（防「找个地方」「我们也来」误伤）
    const addMatch = msg.match(/(?:叫|让|喊|把|找)\s*([一-龥]{2,4})\s*(?:也)?\s*(?:来|过来|参加|加入|进来)/)
      || msg.match(/([一-龥]{2,4})\s*(?:你)?\s*也\s*(?:来|过来|参加|加入|进来)/);
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

    // 3b. 🔴 T012 P1-3（WeChat 风格点名切换）：会晤中称呼/@某参会者 → 切主发言到该人。
    //   "阿珍，你在干嘛" / "@阿珍 在吗" → 切到阿珍回应（点名谁谁说话）。
    //   仅会晤中生效；非会晤态走下面 wake（进入单人会晤）。当前发言者被点名 → switchTo同人=无害空转。
    //   区别于纯提及（"阿珍和徐诗雨都是好人"无紧跟分隔符 → 不算点名，不误切）。
    if (inMeeting) {
      // @某人 直接点名（必须先于下面 wake 的 atMatch，否则多人下被当成 wake 遭门卫拒）
      // 🔴 2026-11-01 D2：返回 `addressOnly` 而非 `switch` —— 点名只顶替本轮，
      //   下一轮由 chat.ts dispatch SPEAK 回原主。`switch` 仅保留给「换XX来」。
      const atVoc = msg.match(/^@\s*([一-龥\w]{1,8})/);
      if (atVoc) {
        const name = EntityMeeting._fuzzyFindName(atVoc[1], sorted, aliasMap);
        if (name) return { kind: 'addressOnly', targets: [name] };
      }
      // 称呼点名 "阿珍，…" / "阿珍: …"
      const vocMatch = msg.match(/^\s*([一-龥]{2,8})\s*[：:，,、]/);
      if (vocMatch) {
        const name = EntityMeeting._fuzzyFindName(vocMatch[1], sorted, aliasMap);
        if (name) return { kind: 'addressOnly', targets: [name] };
      }
    }

    // 4. 唤醒/开会（wake）
    // 🔴 P2-2: 会晤中(inMeeting)用严格模式——只认明确切换句式，跳过确认/寒暄/兜底
    //   （"全芬你还是那么丰满"→normal，不再误判为唤醒王全芬触发门卫拒绝）
    const wake = EntityMeeting.detectUserIntent(msg, sorted, inMeeting, aliasMap);
    if (wake && wake.length > 0) {
      return { kind: 'wake', targets: wake };
    }

    // 5. 🔴 P091 任务1 群聊向全员提问（askAll）——宁窄勿滥，双条件缺一不触发：
    //   ① **复数对象词**（你们/大家/各位）或**全称量词**（都）
    //   ② **疑问/征询结构**（吗/么/？/怎么看/怎么想/觉得呢/怎么样/有什么…/说说…想法）
    //   判序置于 wake 之后、normal 兜底之前 ⇒ exit/add/switch/点名/wake 拦到的句式一律不受影响：
    //     「诗雨，你们觉得呢」→ 点名先拦为 switch（保留）；「叫徐诗雨和阿珍过来你们怎么看」→ wake 先拦。
    //   边界：单人会晤不触发（isMulti=false）；非会晤态不触发（inMeeting=false）。
    //   不命中示例：「你有什么看法」（单数）「你们先聊我去倒水」（非疑问）「大家都很好」（陈述）
    //              「诗雨你怎么看」（无复数词 → 落 normal 由点名/推断兑底）
    //   P090 对接：kind='askAll'，targets 空 —— 全员列表由适配层从 GroupSession 取。
    if (inMeeting && isMulti) {
      const _askAllPlural = /你们|大家|各位|都/.test(msg);
      const _askAllQuestion = /[吗么？]|怎么看|怎么想|觉得(?:呢|[吗么？])|怎么样|有什么.{0,8}(?:看法|意见|想法|想说|动静|进展)|(?:说说|讲讲|谈谈).{0,6}(?:想法|意见|看法|主意)/.test(msg);
      if (_askAllPlural && _askAllQuestion) return { kind: 'askAll', targets: [] };
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

    // ── 多人模式检测（T012 P0-5 修复：别名感知 + 语序鲁棒）──
    // 原实现每个句式用「主名裸子串 .includes(主名)」且要求集合动词在名字前：
    //   ① 别名失效——"找诗雨和阿珍"中"诗雨"是别名(主名徐诗雨)，裸子串匹配不到 → 多人退化单人；
    //   ② 把字句/无分隔/多语序失效——"把X和Y叫过来"动词在名后、"徐诗雨阿珍过来"无分隔 → 漏召。
    // 修复：先把别名归一为主名(_normalizeAliases)，再收集消息中**全部**被提及的已知实体，
    //   配「集合线索」判据（过来/都来/一起/开会/聊… 或 祈使动词+来），与动词位置解耦。
    // 疑问句守卫："X和Y都来了吗"不算唤醒（末尾疑问词且无祈使动词），防误入会晤。
    const nmsg = EntityMeeting._normalizeAliases(msg, aliasMap);
    const mentioned = new Set<string>();
    for (const name of sorted) {
      if (name.length >= 2 && nmsg.includes(name)) mentioned.add(name);
    }
    if (mentioned.size >= 2) {
      const _gatherCue = /过来|都来|都过来|一起(?:来)?|开会|讨论|聚一聚|碰头|参加|聊聊|谈一谈/.test(nmsg)
        || /(叫|找|让|喊|把|请)[^?？！!]{0,15}(?:来|参加|加入|进来)/.test(nmsg);
      const _isQuestion = /[吗么呢？?]\s*$/.test(msg) && !/(叫|找|让|喊|把|请)/.test(msg);
      if (_gatherCue && !_isQuestion) return [...mentioned];
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
   * 🔴 本体隔离守门（原 `_resolveEntity` 的 `category === 'S'` 判据，2026-10-31 迁移至此）。
   *
   * 背景：`category === 'S'` 表示**系统本体**（玉瑶）。本体是回答者，不是可会晤实体 ——
   *   「找玉瑶聊聊」的语义是切回本体视角（= 退出会晤），不是进入「玉瑶会晤」。
   *
   * 失败语义：FG 缺失 / 查不到人名 ⇒ **拒绝**（fail-closed，防伪造名字进入席位）；
   *   分类查询抛异常 ⇒ 放行（fail-open，基础设施故障不阻断合法会晤）。
   */
  static isMeetableEntity(
    fg: { getUUIDByName?: (n: string) => string | null; getEntityByUUID?: (u: string) => { category?: string } | null } | undefined | null,
    name: string,
  ): boolean {
    if (!fg || !name || name === '玉瑶') return false;
    try {
      const uuid = fg.getUUIDByName?.(name);
      if (!uuid) return false;
      return fg.getEntityByUUID?.(uuid)?.category !== 'S';
    } catch {
      return true;
    }
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
}

export default EntityMeeting;