/**
 * belong-uuid — 归属 UUID 的推导与净化（唯一事实源）
 * ============================================================
 * 2026-09-13 建立（②-1 收口 + 举一反三补漏）
 *
 * ## 为什么需要独立模块
 *
 * ① 归属字段的判空在库内散落了 7 处，各自写法不同：
 *      `String(x || null)` / `x || null` / `x ?? null` —— 前一种会**造出**脏值，
 *      后两种**挡不住**已存在的脏值。同一个语义需要单一实现。
 * ② `MemoryAssessor.ts` 已 `import ... from './VaultManager.js'`，反向引用会形成循环依赖，
 *      因此不能把守卫放在这两者任一侧。本模块**零依赖**，任何层都可安全引用。
 *
 * ## 脏值从哪来
 *
 * 历史缺陷：`String(conv.belong_entity_uuid || conv.entity_uuid || null)` ——
 * 两个来源都为空时 `String(null)` 得到**字符串 'null'**，它是**真值**，
 * 能绕过所有 `IS NOT NULL` / `!= ''` 判空写入库中。实测污染（2026-09-13 取证）：
 *   memories 64 条真实对话 / vault_log 38 条 / black_diamond 4 条。
 *
 * ## 为什么下游也必须净化
 *
 * 脏值一旦落库，下游各写入点会「回查已有归属并原样透传」——
 * `x.belong_entity_uuid || null` 只挡 null/undefined，**挡不住字符串 'null'**。
 * 实测传播链：`memories('null')` → addBlackDiamond 回查 → `black_diamond('null')`
 * （清库后重启即重现，因为升级流程再次回查了仍带脏值的源记忆）。
 *
 * ## 语义
 *
 * 无归属 = `undefined`（由调用方落 NULL）。**绝不返回字符串 'null'**。
 * 注意：本模块只做「净化」，**不做归属推断** —— 判不出归属的记录保持无归属，
 * 不猜、不从上下文猜人名。
 */

/**
 * 净化单个归属值：脏值（'null' / 'undefined' / 空串 / 纯空白 / 非字符串）一律视为无归属。
 *
 * @returns 合法 UUID 字符串，或 undefined 表示「无归属」
 */
export function sanitizeBelongUuid(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;   // null / undefined / 0 / false 等原语均视为无归属
  const s = raw.trim();
  if (!s || s === 'null' || s === 'undefined') return undefined;
  return s;
}

/**
 * 从会话/记忆行推导归属 UUID：优先 `belong_entity_uuid`，回退 `entity_uuid`。
 *
 * 原实现散布在 MemoryAssessor 的晋升路径中，为 `String(... || null)`；
 * 现收口为单一入口，并主动拦截历史脏值。签名与返回类型保持不变（返回 undefined 而非 'null'）。
 */
export function deriveBelongUuid(conv: any): string | undefined {
  return sanitizeBelongUuid(conv?.belong_entity_uuid) ?? sanitizeBelongUuid(conv?.entity_uuid);
}
