/**
 * SessionStore — 群聊会话状态持久化（T013 Phase 2 · ADR-013 R1 单写者）
 *
 * 职责（严格单一）：把 `GroupSession.serialize()` 产物写进 engine_store **单键**，
 * 并在启动时从该键 `restore()`。不新增表、不动 sql.js 库结构、不碰任何旧数据。
 *
 * 🔴 R1 单写者语义（ADR-013 §四 + P051）：
 *   - 唯一键 `group_session_state`；本类是该键的**唯一写者**。
 *   - 过渡期严格单写者：新架构（WS_GROUP_V2 开启的 GroupSession 分支）接管写入后，
 *     旧路径（EntityMeeting）**不写此键**（旧路径本就无此键，天然只读兼容）。
 *   - 一次对话轮结束时由适配层调 `saveSession`，启动时调 `loadSession`。
 *
 * 🔴 restore 整份拒绝语义：GroupSession.restore() 校验失败**返回 false 且状态保持原样**
 * （绝不半恢复 —— 半错状态会让 speakerUuid 指向不存在的参与者 → 检索白名单错 → 串档）。
 *   本函数把该 false **原样上抛**给调用方；调用方据此不得信任本次恢复结果。
 *
 * 🔴 回滚开关 WS_GROUP_V2（默认 false）：关闭时 save/load 均为空操作（no-op），
 *   与改动前逐字一致 —— 回滚 = 关开关，不涉及数据迁移。
 *
 * 数据零写入约束（P051）：仅写本类自有新键，绝不 UPDATE/DELETE 任何既有行。
 */
import { isGroupSessionEnabled, type GroupSession } from './GroupSession.js';

/** 单键名（单一真源；勿与其他键前缀冲突 —— 现有 group* 键数为 0） */
export const GROUP_SESSION_STORE_KEY = 'group_session_state';

/** 最小 sqlite 接口（与 chat.ts 内 dialog_group_snapshot 同型，避免耦合具体适配器） */
export interface EngineStoreSqlite {
  queryAll: (sql: string, params?: any[]) => any[];
  writeRaw: (sql: string, ...params: any[]) => void;
}

/**
 * 开关是否开启。**直接委托 `isGroupSessionEnabled()`**（P062 问题2）——
 *   原本两处各自实现一遍判定逻辑（逐字相同），将来扩展取值（如支持 `yes`）需改两处、易漏改一处。
 *   现委托单一实现，取值规则只有一处真源（GroupSession）。
 */
export function isStoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isGroupSessionEnabled(env);
}

/**
 * 把当前会话状态持久化到单键。**仅在 WS_GROUP_V2 开启时写**；关闭时 no-op（返回 false）。
 *
 * @returns true=已写入；false=开关关闭或写入不可用（sqlite 缺 writeRaw）
 */
export function saveSession(sqlite: EngineStoreSqlite | null | undefined, session: GroupSession): boolean {
  if (!isStoreEnabled()) return false;
  if (!sqlite || typeof sqlite.writeRaw !== 'function') return false;
  try {
    const json = session.serialize();
    sqlite.writeRaw(
      'INSERT OR REPLACE INTO engine_store (key, value, updated_at) VALUES (?, ?, ?)',
      [GROUP_SESSION_STORE_KEY, json, new Date().toISOString()],
    );
    return true;
  } catch (e) {
    // 持久化失败绝不影响主链路（会话仍在内存，仅丢本轮快照）
    console.warn('[SessionStore] 持久化失败（非阻塞）:', (e as Error)?.message || e);
    return false;
  }
}

/**
 * 从单键恢复会话状态。**仅在 WS_GROUP_V2 开启时读**；关闭时 no-op（返回 false）。
 *
 * 🔴 **整份拒绝语义**：键不存在 / sqlite 不可用 / restore 校验失败 → 一律返回 false，
 * 调用方**不得信任**恢复结果。restore 内部已保证失败时状态保持原样（不半恢复）。
 *
 * 🔴 **返回值消费现状（P062 问题3）**：当前唯一调用方 chat.ts **丢弃本返回值**，
 *   只 try/catch 不读 boolean。契约安全依赖的是「失败时 GroupSession 内部保持空状态」，
 *   而**非**返回值 —— 投影会从空状态 WAKE，等价首次运行。返回值留给未来调用方
 *   （如需显式感知恢复失败并告警）使用；当前无消费者不构成缺陷，但契约与消费现状在此对齐。
 *
 * @returns true=恢复成功且状态可信；false=未恢复（键缺失/开关关闭/校验失败）
 */
export function loadSession(sqlite: EngineStoreSqlite | null | undefined, session: GroupSession): boolean {
  if (!isStoreEnabled()) return false;
  if (!sqlite || typeof sqlite.queryAll !== 'function') return false;
  try {
    const rows = sqlite.queryAll('SELECT value FROM engine_store WHERE key = ?', [GROUP_SESSION_STORE_KEY]);
    if (!rows || rows.length === 0) return false;            // 首次运行：无快照，正常
    const json = String((rows[0] as any).value ?? '');
    if (!json) return false;
    const ok = session.restore(json);                        // 校验失败 → restore 内部拒绝 + 返回 false
    if (!ok) console.warn('[SessionStore] 恢复被拒（整份拒绝，状态保持原样）');
    return ok;
  } catch (e) {
    console.warn('[SessionStore] 恢复失败（非阻塞）:', (e as Error)?.message || e);
    return false;
  }
}

/**
 * 清除会话快照（仅在**会话确定结束/需丢弃**时调用；不删任何其他键）。
 * 过渡期单写者原则：只有本键的写者（本类）可清它。
 *
 * 🔴 P062 问题1：**补上与 save/load 一致的 WS_GROUP_V2 门控**（方案A）。
 *   原本无门控 ⇒ 开关关闭时仍会真删键，违反「关闭 = 与改动前逐字一致」的回滚契约
 *   （虽然当前全仓零调用点、未构成事故，但是「将来直接调用就踩」的地雷）。
 *   选补门控而非删除：保留本函数供未来的会话清理路径使用，且与另两个函数门控行为对齐；
 *   门控后即使将来被直接调用，关闭态下也不会误删键。
 */
export function clearSession(sqlite: EngineStoreSqlite | null | undefined): void {
  if (!isStoreEnabled()) return;
  if (!sqlite || typeof sqlite.writeRaw !== 'function') return;
  try {
    sqlite.writeRaw('DELETE FROM engine_store WHERE key = ?', [GROUP_SESSION_STORE_KEY]);
  } catch { /* 非关键 */ }
}
