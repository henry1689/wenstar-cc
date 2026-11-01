/**
 * 🔴 P072 整改批（2026-10-26，管控总纲§四 P2）：原「m2 独立副本」已废——
 *   改为纯 re-export 桩，实现单源自 m3/types/perception-40d.ts（原始定义）。
 *   历史：本副本当初为「避免反向依赖 m3」而复制，但 m2 已多处直接引用 m3 类型
 *   （math.ts / Perception40DCodec / SQLiteAdapter 等），复制反而构成双源漂移风险。
 *   永久执法口径：类型唯一真源 = m3；本文件仅作路径兼容，禁止在此新增任何定义。
 */
export * from '../../m3/types/perception-40d.js';
