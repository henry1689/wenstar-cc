/**
 * 旧维度键契约（LegacyDim）—— v2.1 与 v3.1 的物理隔离层
 *
 * 🔴 本文件在 `core/` **之外**。`core/` 只处理 v3.1 的 `DimId`（由 LAYOUT 推导的
 * 精确字面量联合），绝不接触旧键；旧键只允许出现在 adapter 一侧。
 *
 * 代际背景（详见协作区《P0切片03-层映射缺口研判》rev2）：
 * - `perception-40d.ts` **v2.1** = 旧定义（双极维只有 D36/D37、D32 为「全域统筹总控」、
 *   D39/D40 为依赖/排他、D27 为微观生理细化）
 * - 白皮书 v3.1 与 S-002 = 现行定义
 * 两套编号**同名不同义**，混用会把旧坐标静默写进新坐标系。
 *
 * 🔴 本包**不实现 adapter**，只固化三条硬约束（adapter 切片落地）：
 * 1. 旧键一律加 `L:` 前缀，与 Field 侧 `DimId` 物理隔离
 * 2. 旧 `physical_body` / `spatiotemporal` / `dynamic_growth` 三个「当前全 0」扇区
 *    一律输出 **π = 0（未知）**，**不是**「值 0 + 正常精度」
 *    （值 0 是确定的中性判断，会当真实印记参与证据计算；π=0 才是未知，
 *     `dimEvidence` 直接返回 0，对应 S-060）
 * 3. 旧表不得用作层归属 / 双极判定 / 维度语义的来源
 *
 * 为什么不新建 `FieldDim`：`DimId` 已经是比 branded string 更严的类型
 * （联合取值恰好是 `'D01'…'D40' | 'Y1'…'Y8'`），再建一份只会制造第二份定义。
 * 两个联合的**交集为空**，编译期赋值必然报错，无需 branded symbol。
 */

/** 旧 perception-40d.ts v2.1 的维度键，一律 `L:` 前缀 */
export type LegacyDim = `L:${string}`;

/** 旧键前缀（唯一定义点，adapter 与校验共用） */
export const LEGACY_PREFIX = 'L:' as const;

/**
 * 把一个裸字符串收窄为 `LegacyDim`，并强制校验前缀。
 *
 * @throws 不以 `L:` 开头时抛错——放行就等于让旧坐标绕过隔离层直接进 Field 侧
 */
export function legacyDim(s: string): LegacyDim {
  if (!s.startsWith(LEGACY_PREFIX)) {
    throw new Error(`LegacyDim 必须以 '${LEGACY_PREFIX}' 开头：${s}`);
  }
  return s as LegacyDim;
}

/**
 * 旧「当前全 0」扇区：物理肉身 / 时空环境 / 动态成长。
 *
 * 这三类信号在现行数据链路里尚未接入（P3 才激活），adapter 读到旧数据时
 * **必须输出 π = 0 表示未知**，绝不能把「没有数据」编码成「值恰为 0」。
 * 逐条确认放到 adapter 切片。
 */
export const LEGACY_ZERO_SECTORS: readonly string[] = Object.freeze([
  'physical_body',
  'spatiotemporal',
  'dynamic_growth',
]);