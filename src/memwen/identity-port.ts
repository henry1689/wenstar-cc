/**
 * MemWen OS · MwIdentityPort —— 身份链接驳接口（纯类型 · 零实现）
 *
 * 🔴 签名冻结（豆包 P182 裁定③）：
 *   1. 本接口一经发布即**冻结**；任何变更（改名/增减参数/改返回结构）必须先在
 *      协作区公告，防实现侧按旧签名实现；
 *   2. **零实现**：本文件只含 interface / type，不得出现 default 实现、
 *      样例函数体、可执行导出；
 *   3. **逐字对齐 P181 §4.1**：
 *        resolve(text)      → { uuid, confidence, src }
 *        canAttend(uuid)    → boolean
 *        viewFor(uuid)      → ContextView | null
 *        render(uuid)       → { canonicalName, aliases }
 *
 * 🔴 依赖单向（ADR-024）：本文件不 import 任何业务模块。
 *   `MwContextView` 结构对齐 `src/m5/space/types.ts` 的 `ContextView`
 *   （seatUuid / readable / metaOnly / addressed），但事件以 **id（string）** 表示 ——
 *   memwen 不得 import m5，事件对象到 id 的映射由**实现侧适配器**负责。
 *
 * 接驳时序（P181 §4.3）：
 *   用户文本 → 适配器 resolve（名字→UUID，FG 只读）→ canAttend → viewFor
 *            → MemWen 六层只认 UUID → 渲 render（UUID→主名，回查不冗余存）
 */

/** resolve 成功结果（P181 §4.1 逐字） */
export interface MwResolveResult {
  /** 归一后的实体 UUID（身份唯一键，L1 铁律） */
  readonly uuid: string;
  /** 归置置信度 [0,1]；每次 resolve 必须记录，失败禁止静默返回 null（P181 §6 可观测） */
  readonly confidence: number;
  /** 归置来源标识（如 fg / alias / whitelist / unassigned —— 由实现侧登记） */
  readonly src: string;
}

/**
 * 该身份可见视图（结构对齐 m5 ContextView，事件用 id 表示）。
 * 适配器把 SpaceEvent[] 映射为 id[]（readable/metaOnly/addressed 三集合语义不变）。
 */
export interface MwContextView {
  /** 席位身份 UUID */
  readonly seatUuid: string;
  /** 能读到正文的事件 id */
  readonly readable: readonly string[];
  /** 读不到正文但知道发生过的事件 id（仅 publicMeta） */
  readonly metaOnly: readonly string[];
  /** readable 中指向本席位的事件 id（address.kind==='seat' 且 uuid 匹配） */
  readonly addressed: readonly string[];
}

/** 主名渲染结果（P181 §4.1 逐字） */
export interface MwRenderResult {
  /** 规范主名（FG canonical name） */
  readonly canonicalName: string;
  /** 别名集合（FG aliases，回查所得，不冗余存入记忆 —— L2 铁律） */
  readonly aliases: readonly string[];
}

/**
 * 身链接驳端口（SpaceRouter ↔ MemWen OS，P181 §4.1 —— 接驳面 = 4 函数，不许超过）。
 *
 * MemWen 六层接法（P181 §4.1 表）：
 *   MW-Gateway    → resolve    文本 → UUID，写 belong_entity_uuid
 *   MW-Store      → —          只存 UUID，不存名字
 *   MW-Read       → viewFor    按身份过滤
 *   MW-Consolidate→ render     摘要时 UUID → 名字
 *   MW-Express    → resolve + render
 *   MW-Govern     → canAttend  席位准入
 *
 * 实现侧归属：SpaceRouter 适配器（kernel / 业务侧）；memwen 只声明不实现。
 */
export interface MwIdentityPort {
  /** 名字归约（写侧）：文本 → UUID。FG 只读接口 + 拒绝前缀切片；失败显式告警，禁止静默 null */
  resolve(text: string): MwResolveResult;

  /** 准入判定（席位 / 落库）：canonical 实体 true，垃圾名/未过闸 false */
  canAttend(uuid: string): boolean;

  /** 该身份可见视图（读侧）；身份不可用返回 null（调用方按 L3 降级为 UUID 短码渲染） */
  viewFor(uuid: string): MwContextView | null;

  /** 主名渲染（输出侧）：UUID → 主名+别名（回查，不冗余存） */
  render(uuid: string): MwRenderResult;
}
