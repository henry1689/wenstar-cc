/**
 * Dim24to32Migration.ts — 24D → 32D 感知向量迁移 (P3 阶段)
 * ============================================================
 * 适配: 白皮书 V2.0 §4.2 / 蓝皮书 V2.0 §5.2
 *
 * 当前: 24D 过渡方案 (Perception24D)
 *   00-03 (4D) 情绪象限: pleasure/arousal/dominance/aggression
 *   04-09 (6D) 认知象限: sincerity/humor/factual/logical/certainty/abstract/temporal_focus/self_ref
 *   10-15 (6D) 社会象限: intimacy/power_diff/dependency/moral_judgment/etiquette/belonging
 *   16-23 (8D) 本能象限: sexual_attraction/sensory_craving/energy_merge/possessiveness/ecstasy/safety/(+2 padding)
 *
 * 目标: 32D 白皮书格式 (P3 瑶光 + 瑶灵 32 通道上线后切换)
 *   D00-D05 (6D) 感知用户情绪
 *   D06-D10 (5D) 肉身实体 → 新增 5 维
 *   D11-D16 (6D) 精神内核
 *   D17-D22 (6D) 圈层人际
 *   D23-D28 (6D) 时空环境 → 新增 6 维
 *   D29-D31 (3D) 动态生长 → 新增 3 维
 *   D32     (1D) 全身统筹 → 新增 1 维
 *
 * 迁移策略: 24D 的 24 个维度映射到 32D 的对应扇区, 新增 8 维默认值为 0
 *
 * 步骤:
 *   1. 瑶灵 32 通道上线
 *   2. 将此文件中的 MIGRATION_MAP 应用到 computeCalcium()
 *   3. memories.perception_json 从 24 键扩展到 32 键
 *   4. 存量数据: 24D→32D 批量重计算 (P3 迁移脚本)
 */

/** 24D → 32D 维度映射 */
export const DIM_24_TO_32_MAP: ReadonlyArray<{ key24: string; dim32: number; label: string; category: string }> = [
  // ── 情绪象限 (00-03) → 感知用户情绪 (00-05) ──
  { key24: 'pleasure',          dim32: 0,  label: '愉悦-不悦',    category: 'perceive_user_emotion' },
  { key24: 'arousal',           dim32: 1,  label: '唤醒-平静',    category: 'perceive_user_emotion' },
  { key24: 'dominance',         dim32: 2,  label: '亲和-疏离',    category: 'perceive_user_emotion' },
  { key24: 'aggression',        dim32: 3,  label: '紧张-放松',    category: 'perceive_user_emotion' },
  { key24: 'sincerity',         dim32: 4,  label: '专注-分心',    category: 'perceive_user_emotion' },
  { key24: 'humor',             dim32: 5,  label: '攻击-退缩',    category: 'perceive_user_emotion' },
  // ── 认知 + 社会 + 本能 → 肉身体验 + 精神内核 + 圈层人际 ──
  { key24: 'factual',           dim32: 6,  label: '骨骼肌肉',     category: 'physical_body' },
  { key24: 'logical',           dim32: 7,  label: '躯体疼痛',     category: 'physical_body' },
  { key24: 'certainty',         dim32: 8,  label: '神经触觉',     category: 'physical_body' },
  { key24: 'abstract',          dim32: 9,  label: '内分泌激素',   category: 'physical_body' },
  { key24: 'temporal_focus',    dim32: 10, label: '信息素气息',    category: 'physical_body' },
  { key24: 'self_ref',          dim32: 11, label: '自我认知',     category: 'inner_spirit' },
  { key24: 'intimacy',          dim32: 12, label: '成长驱动力',   category: 'inner_spirit' },
  { key24: 'power_diff',        dim32: 13, label: '恐惧倦怠',    category: 'inner_spirit' },
  { key24: 'dependency',        dim32: 14, label: '幸福松弛',    category: 'inner_spirit' },
  { key24: 'moral_judgment',    dim32: 15, label: '共情恻隐',    category: 'inner_spirit' },
  { key24: 'etiquette',         dim32: 16, label: '个体自保',    category: 'inner_spirit' },
  { key24: 'belonging',         dim32: 17, label: '伴侣依恋',    category: 'social_bonds' },
  { key24: 'sexual_attraction', dim32: 18, label: '伴侣守护',    category: 'social_bonds' },
  { key24: 'sensory_craving',   dim32: 19, label: '家庭归属',    category: 'social_bonds' },
  { key24: 'energy_merge',      dim32: 20, label: '家庭守护',    category: 'social_bonds' },
  { key24: 'possessiveness',    dim32: 21, label: '社交适配',    category: 'social_bonds' },
  { key24: 'ecstasy',           dim32: 22, label: '团队保护',    category: 'social_bonds' },
  { key24: 'safety',            dim32: 23, label: '私人居所',    category: 'spatiotemporal' },
  // ── 新增 8 维 (D24-D31): 当前默认值为 0, P3 瑶光上线后真实填充 ──
  // D24-D28 时空环境: 瑶光 5 计算单元
  // D29-D31 动态生长: 瑶灵 D27-D31
  // D32 全身统筹: 加权汇总 (心率/血压/皮质醇/愉悦激素)
];

/**
 * 将当前 24D perception JSON 映射为 32D 数组
 * @param perception24 24维感知对象 (Perception24D)
 * @returns Float32Array(32) — P3 目标格式
 */
export function map24DTo32D(perception24: Record<string, number>): Float32Array {
  const vec32 = new Float32Array(32);

  for (const { key24, dim32 } of DIM_24_TO_32_MAP) {
    vec32[dim32] = perception24[key24] ?? 0;
  }

  // D24-D31 保持 0 (瑶光 P3 填充)
  // D32 保持 0 (全身统筹 P3 加权计算)

  return vec32;
}

/**
 * P3 切换检查清单:
 *   1. 瑶灵 32 通道全部上线 (D1-D32 有真实值)
 *   2. 瑶光 5 计算单元上线 (D24-D28 环境参数)
 *   3. M3/PerceptionAnalyzer.ts 输出从 24D 扩展到 32D
 *   4. chat.ts 的 buildPerceptionJson() 同样扩展
 *   5. computeCalcium() dimCount: 24 → 32
 *   6. 存量数据迁移: memories.perception_json 重计算
 *   7. state_spines 维度数: 24 → 32 (INSERT 新增行)
 *   8. 全量回归测试
 */

export const DIM_COUNT_CURRENT = 24;
export const DIM_COUNT_TARGET = 32;
export const NEW_DIMS_REQUIRED = 8;
