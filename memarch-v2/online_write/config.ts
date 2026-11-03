/**
 * MemArch-v2.0.0 / M2-OnlineWrite / config
 *
 * 配置基线（严格遵循主设计文档第十六章 16.3 节）
 * 所有阈值集中在此文件，禁止在业务代码中硬编码
 * 门控阈值调整需模块负责人 + Harness 备案
 */

export const M2_CONFIG = {
  // ===== 编码门控（16.3 encoding） =====
  encoding: {
    kappa: 0.6,                  // c₀ = κ · S（初始巩固度系数）
    write_threshold: 0.45,       // WRITE 门控显著性阈值
    salience_weights: {
      importance: 0.30,          // imp_rule：计划/决定/首次/身体情绪事件
      self: 0.25,                // self_rule：第一人称经历、关系词
      arousal: 0.20,             // arousal：VAD 唤醒度输出
      novelty: 0.15,             // nov_rule：与近期痕迹反向相似度
      entity: 0.10,              // ent：是否有有意义实体
    },
  },

  // ===== 事件分割（16.3 segmentation） =====
  segmentation: {
    threshold: 0.55,              // 边界分数阈值
    hard_gap_min: 120,            // 硬时间间隔（分钟），超过必切
    max_turns: 40,                // 单 episode 最大轮次
    window_turns: 3,              // 滑动窗口取最近 N 轮均值
    gap_normalize_min: 30,        // gap 归一化基准（分钟）
    weights: {
      semantic: 0.40,             // 语义余弦距离权重
      gap: 0.25,                  // 时间间隔权重
      arousal: 0.20,              // 唤醒度变化权重
      cue: 0.15,                  // 显式转场词权重
    },
  },

  // ===== 门控分布健康区间（Harness 监管用） =====
  gate_distribution: {
    write_min: 0.15,
    write_max: 0.35,
    discard_min: 0.30,
    discard_max: 0.50,
  },

  // ===== 工作记忆缓冲 =====
  working_memory: {
    sweep_retention_ms: 3_600_000,  // 已完成条目保留 1 小时后清理
    recover_batch_size: 50,          // 崩溃恢复批量大小
  },

  // ===== 前瞻记忆正则库 =====
  prospective: {
    min_confidence: 0.6,            // 最小置信度阈值
  },
} as const;

export type M2Config = typeof M2_CONFIG;
