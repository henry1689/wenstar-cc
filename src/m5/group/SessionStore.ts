/**
 * SessionStore — 群聊会话状态持久化（T013 Phase 2 · ADR-013 R1 单写者）
 *
 * 职责（严格单一）：把 `GroupSession.serialize()` 产物写进 engine_store **单键**，
 * 并在启动时从该键 `restore()`。不新增表、不动 sql.js 库结构、不碰任何旧数据。
 *
 * 🔴 R1 单写者语义（ADR-013 §四 + P051）：
 *   - 唯一键 `group_session_state`；本类是该键的**唯一写者**。
 *   - 新架构（GroupSession）是唯一状态源，旧路径（EntityMeeting 状态机）已于 2026-10-31
 *     随 `WS_GROUP_V2` 开关一并删除，**不再有任何分支会绕过本类写会话状态**。
 *   - 一次对话轮结束时由适配层调 `saveSession`，启动时调 `loadSession`。
 *
 * 🔴 restore 整份拒绝语义：GroupSession.restore() 校验失败**返回 false 且状态保持原样**
 * （绝不半恢复 —— 半错状态会让 speakerUuid 指向不存在的参与者 → 检索白名单错 → 串档）。
 *   本函数把该 false **原样上抛**给调用方；调用方据此不得信任本次恢复结果。
 *
 * 🔴 2026-10-31 第三层固化：`WS_GROUP_V2` 门控已删除。save/load/clear 无条件生效 ——
 *   不再有「关闭时 no-op」的回滚语义（回滚只能 `git revert`，见 GroupSession.ts 头注释）。
 *
 * 数据零写入约束（P051）：仅写本类自有新键，绝不 UPDATE/DELETE 任何既有行。
 */
import type { GroupSession } from './GroupSession.js';

/** 单键名（单一真源；勿与其他键前缀冲突 —— 现有 group* 键数为 0） */
export const GROUP_SESSION_STORE_KEY = 'group_session_state';

/** 最小 sqlite 接口（与 chat.ts 内 dialog_group_snapshot 同型，避免耦合具体适配器） */
export interface EngineStoreSqlite {
  queryAll: (sql: string, params?: any[]) => any[];
  writeRaw: (sql: string, ...params: any[]) => void;
}

/**
 * 把当前会话状态持久化到单键。
 *
 * @returns true=已写入；false=写入不可用（sqlite 缺 writeRaw）或序列化抛错
 */
export function saveSession(sqlite: EngineStoreSqlite | null | undefined, session: GroupSession): boolean {
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
 * 从单键恢复会话状态。
 *
 * 🔴 **整份拒绝语义**：键不存在 / sqlite 不可用 / restore 校验失败 → 一律返回 false，
 * 调用方**不得信任**恢复结果。restore 内部已保证失败时状态保持原样（不半恢复）。
 *
 * 🔴 **返回值消费现状（P062 问题3）**：当前唯一调用方 chat.ts **丢弃本返回值**，
 *   只 try/catch 不读 boolean。契约安全依赖的是「失败时 GroupSession 内部保持空状态」，
 *   而**非**返回值 —— 失败等价首次运行。返回值留给未来调用方
 *   （如需显式感知恢复失败并告警）使用；当前无消费者不构成缺陷，但契约与消费现状在此对齐。
 *
 * @returns true=恢复成功且状态可信；false=未恢复（键缺失/校验失败/写入不可用）
 */
export function loadSession(sqlite: EngineStoreSqlite | null | undefined, session: GroupSession): boolean {
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
 * 单写者原则：只有本键的写者（本类）可清它。
 */
export function clearSession(sqlite: EngineStoreSqlite | null | undefined): void {
  if (!sqlite || typeof sqlite.writeRaw !== 'function') return;
  try {
    sqlite.writeRaw('DELETE FROM engine_store WHERE key = ?', [GROUP_SESSION_STORE_KEY]);
  } catch { /* 非关键 */ }
}