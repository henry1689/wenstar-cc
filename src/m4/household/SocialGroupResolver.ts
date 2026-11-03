/**
 * SocialGroupResolver — 社团判定纯函数层（P113 §2.3 设计 / P123 任务书落地）
 * ================================================================
 * 数据源：nodes.social_group_genes（BFS 全量分配；实测 1109/1109 person 全覆盖）
 * 值形态：单值 `CO01` / `WW`，或规范多值 `A|B`
 *
 * fail-closed 原则（与 FG 户籍管理法一致，宁严勿放）：
 *   无法判定 → null → isSameSocialGroup=false（视为不同社团）→ 走提醒+用户授权。
 *
 * 本文件为纯函数：零 IO、零写入、不依赖 FamilyGraph 实例 ——
 * 节点查找（uuid→node）由 FamilyGraph 的三个薄委托方法承担（见 FamilyGraph.ts）。
 *
 * 与既有 `socialGroupsOf(personName)` 的语义边界（勿混淆）：
 *   · socialGroupsOf：按**人名**返回组结构（gene/type/members/lastSync），服务 dossier 展示，
 *     跳过 WW（自由人不成组）、单人不成组 —— 是「组名单」视角；
 *   · 本模块三接口：按 **UUID** 返回**编码集**判定，WW 参与比较（自由人 vs 自由人 = 同类），
 *     不查成员名单 —— 是「席内/席外」判定视角。两者互补，不重复。
 */

/**
 * 解析原始编码 → 规范化列表。
 * - 非字符串 / 空串 / 全空白 / 仅分隔符 → null（fail-closed：无法判定）
 * - `' CO01 | WW '` → `['CO01', 'WW']`（trim + 去空项，规范多值形态）
 */
export function parseSocialGroups(raw: unknown): string[] | null {
  if (typeof raw !== 'string') return null;
  const list = raw.split('|').map(s => s.trim()).filter(Boolean);
  return list.length > 0 ? list : null;
}

/**
 * 同社团判定：两方编码集交集非空 ⇔ 同社团。
 * 任一方为 null（无法判定）⇒ false —— 视为不同社团（fail-closed，宁严勿放）。
 */
export function sameSocialGroup(a: string[] | null, b: string[] | null): boolean {
  if (!a || !b) return false;
  return a.some(g => b.includes(g));
}

/**
 * 参会者中的社团外人员（P107 提醒路径用）。
 *
 * 判据（对每个参会者 p）：与主会人 host 不同社团或无法判定 ⇒ 入名单：
 *   host === null（host 编码缺失）⇒ 全员入名单（P113 用例 6：fail-closed 方向一致）；
 *   p.groups === null（该成员无法判定）⇒ 入名单；
 *   交集为空 ⇒ 入名单。
 *
 * @param participants 参会者及其编码集（含 host 自身时，host 缺码场景下同样入名单，
 *                     与 P113 用例字面一致；消费方（P107 提醒 UI）自行决定是否展示 host）
 * @param hostGroups   主会人编码集；null = 无法判定
 * @returns 社团外人员 UUID 列表，保持入参顺序
 */
export function findOutsiders(
  participants: Array<{ uuid: string; groups: string[] | null }>,
  hostGroups: string[] | null,
): string[] {
  return participants
    .filter(p => !sameSocialGroup(hostGroups, p.groups))
    .map(p => p.uuid);
}

export default { parseSocialGroups, sameSocialGroup, findOutsiders };
