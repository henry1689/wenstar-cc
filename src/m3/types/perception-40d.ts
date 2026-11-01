// 40维语义感知坐标系 — M3 输入契约（V2.1 瑶光对齐）
// Ref: 《40D 量纲统一法令》+ 瑶光权威源对齐:
//   - 维度定型：D1-D32（5 大类）+ D33-D40（第 6 大类亲密纹理）；原 32D-MEM 蓝皮书引用已随法令 40D 化
//   - DNA 双螺旋完整编码规范 V2.0 §1.1（海胆 32 根语义刺）
//   - 瑶光 domain_yaoguang/channels/ ObjDimConfig（命名/定义/阈值权威源）
//   - WS-RECTIFY-40D-YAOGUANG-V1.0 整改清单
//
// ╔═══════════════════════════════════════════════════════╗
// ║  perception-40d.ts  v2.1                              ║
// ║  归属: M3 (逻辑决策层)                                ║
// ║  40D = spine.proto D1-D32 + 新增 D33-D40（伴侣纹理）  ║
// ║  编号基准: D1 开头（对齐 spine.proto 存储坐标）       ║
// ║  🔴 命名铁律: D1-D40 裸 key 与瑶光 dim_key 绝对一致   ║
// ║  值域: [0,1] 归一化（D36/37 双极 [-1,1]），            ║
// ║        归一化锚点 = 瑶光 standard_range 中点(baseline) ║
// ╚═══════════════════════════════════════════════════════╝

// ────────────────────────────────────────────────────────
// 第一部分：40D 坐标系总览
// ────────────────────────────────────────────────────────
// 40D = 6 大类（扇区）
//   大类1 肉身实体基底   D01-D08   8D   来源: spine.proto  (瑶灵 D1-D8)
//   大类2 个体内在精神   D09-D14   6D   来源: spine.proto  (瑶灵 D9-D14)
//   大类3 圈层人际       D15-D20   6D   来源: spine.proto  (瑶灵 D15-D20)
//   大类4 时空环境       D21-D26   6D   来源: spine.proto  (瑶灵 D21-D26)
//   大类5 动态成长       D27-D32   6D   来源: spine.proto  (瑶灵 D27-D32)
//   大类6 伴侣情感纹理   D33-D40   8D   ★ 第 6 大类扇区
//                      ─────
//                       40D

/** 40D 感知向量：40 个命名键字段，按 D1-D40 编号（裸 key 与瑶光 dim_key 一致） */
export interface PerceptionV40 {
  // ── 大类1: 肉身实体基底 D01-D08 (spine.proto, 瑶光 ObjDimConfig) ──
  /** D01 骨骼肌肉·体能负荷 (muscle_load): 归一化0(轻松)~1(疲劳), 锚点=血乳酸1.0mmol/L (0.5,1.6) */
  d01_muscle_load: number;
  /** D02 躯体疼痛·不适感知 (pain_level): 归一化0(无痛)~1(剧痛), 锚点=VAS疼痛0分(0-10) (0,2) */
  d02_pain_level: number;
  /** D03 神经瞬时刺激·触觉 (nerve_arousal): 归一化0(迟钝)~1(敏感), 锚点=交感兴奋35% (25,55) */
  d03_nerve_arousal: number;
  /** D04 内分泌·激素波动 (endocrine_hormones): 归一化0(平稳)~1(极端), 锚点=晨间皮质醇14μg/dL (5,25) */
  d04_endocrine_hormones: number;
  /** D05 信息素·气息氛围 (pheromone): 归一化0(无)~1(强烈), 锚点=汗液皮质醇0低/正常/高 (0,1) */
  d05_pheromone: number;
  /** D06 生理周期·代谢生命周期 (metabolic_cycle): 归一化0=基准, 正=偏高, 负=偏低, 锚点=BMR 0%偏移 (-10,10) */
  d06_metabolic_cycle: number;
  /** D07 躯体自愈·修复维度 (self_heal): 归一化0(无)~1(强自愈), 锚点=乳酸清除1.2mmol/h (0.8,1.5) */
  d07_self_heal: number;
  /** D08 五感环境·基础体感 (sensory_env): 归一化0(封闭)~1(丰富), 锚点=环境噪音40dB (25,60) */
  d08_sensory_env: number;

  // ── 大类2: 个体内在精神 D09-D14 (spine.proto) ──
  /** D09 自我认知·人格基底 (self_identity): 归一化0(自我否定)~1(清晰), 锚点=自尊评分32分 (22,40) */
  d09_self_identity: number;
  /** D10 原生欲望·成长驱动力 (desire_drive): 归一化0(无欲)~1(强烈), 锚点=探索递质0%下降 (0,20) */
  d10_desire_drive: number;
  /** D11 恐惧·倦怠·制衡心理 (fear_fatigue): 归一化0(无畏)~1(耗竭), 锚点=SAS焦虑30分 (20,49) */
  d11_fear_fatigue: number;
  /** D12 享受·松弛·幸福感 (enjoyment): 归一化0(痛苦)~1(满足), 锚点=催产素45pg/mL (25,65) */
  d12_enjoyment: number;
  /** D13 共情·恻隐联动 (empathy): 归一化0(冷漠)~1(强烈), 锚点=镜像神经元0.4 (0.2,0.6) */
  d13_empathy: number;
  /** D14 个体自我保护 (self_protection): 归一化0(无边界)~1(高防御), 锚点=戒备基线0.2 (0.1,0.5) */
  d14_self_protection: number;

  // ── 大类3: 圈层人际 D15-D20 (spine.proto) ──
  /** D15 伴侣亲密依恋 (partner_attachment): 归一化0(疏离)~1(附着), 锚点=亲密催产素50pg/mL (35,70) */
  d15_partner_attachment: number;
  /** D16 伴侣专属守护意识 (partner_protection): 归一化0(无)~1(强烈), 锚点=牵挂焦虑皮质醇14μg/dL (5,25) */
  d16_partner_protection: number;
  /** D17 家庭归属·陪伴 (family_belonging): 归一化0(疏离)~1(归属), 锚点=安全感35分 (25,45) */
  d17_family_belonging: number;
  /** D18 家庭整体守护 (family_protection): 归一化0(无)~1(强守护), 锚点=家庭应激皮质醇14μg/dL (5,25) */
  d18_family_protection: number;
  /** D19 社会人际·社交适配 (social_fit): 归一化0(冒犯)~1(适配), 锚点=社交后皮质醇0μg/dL (0,8) */
  d19_social_fit: number;
  /** D20 团队集体保护 (team_protection): 归一化0(无)~1(强防御), 锚点=集体应激0 (0,0.4) */
  d20_team_protection: number;

  // ── 大类4: 时空环境 D21-D26 (spine.proto) ──
  /** D21 私人居所·独处氛围 (private_space): 归一化0(陌生)~1(安全), 锚点=独处皮质醇降5μg/dL (2,10) */
  d21_private_space: number;
  /** D22 家庭布局·共处氛围 (home_environment): 归一化0(紧张)~1(温馨), 锚点=居家情绪恢复80% (60,95) */
  d22_home_environment: number;
  /** D23 职场厂区·工作环境 (workplace): 归一化0(压力)~1(适应), 锚点=工作皮质醇14μg/dL (8,22) */
  d23_workplace: number;
  /** D24 公共场地·人流氛围 (public_space): 归一化0(拥挤压力)~1(从容), 锚点=嘈杂交感35% (25,55) */
  d24_public_space: number;
  /** D25 空间距离·时差流逝 (spatiotemporal): 归一化0(遥远)~1(亲近), 锚点=时间紧迫皮质醇14μg/dL (8,22) */
  d25_spatiotemporal: number;
  /** D26 四季气象·昼夜节律 (seasonal_climate): 归一化0(不适)~1(舒适), 锚点=褪黑素30pg/mL (15,50) */
  d26_seasonal_climate: number;

  // ── 大类5: 动态成长 D27-D32 (spine.proto) ──
  /** D27 人体微观生理细化 (micro_physiology): 归一化0(停滞)~1(活跃), 锚点=微量激素波动0 (0,0.3) */
  d27_micro_physiology: number;
  /** D28 自然世界拓展感知 (nature_expansion): 归一化0(封闭)~1(开放), 锚点=探索多巴胺0%下降 (0,20) */
  d28_nature_expansion: number;
  /** D29 人文社交规则细化 (social_refinement): 归一化0(粗放)~1(精微), 锚点=包容递质0%下降 (0,20) */
  d29_social_refinement: number;
  /** D30 精神文娱·修养成长 (spiritual_growth): 归一化0(停滞)~1(升华), 锚点=精神愉悦血清素0%下降 (0,25) */
  d30_spiritual_growth: number;
  /** D31 主观客观量子耦合 (quantum_coupling): 归一化0(割裂)~1(交融), 锚点=身心协调40分 (30,50) */
  d31_quantum_coupling: number;
  /** D32 全域统筹总控汇总 (global_overview): 归一化0(失衡)~1(健康), 锚点=综合健康75分 (60,90) */
  d32_global_overview: number;

  // ── 大类6: 伴侣情感纹理 D33-D40 ★ 新增扇区 ──
  /** D33 性吸引力 (sexual_attraction): 0(无)~1(强烈生理冲动) */
  d33_sexual_attraction: number;
  /** D34 能量交融 (energy_merge): 0(无感)~1(灵魂共鸣合一) */
  d34_energy_merge: number;
  /** D35 真诚度 (sincerity): 0(虚伪)~1(本心流露) */
  d35_sincerity: number;
  /** D36 支配感 (dominance): -1(被控)~0(平等)~1(掌控) */
  d36_dominance: number;
  /** D37 道德审判 (moral_judgment): -1(谴责)~0(中性)~1(赞扬) */
  d37_moral_judgment: number;
  /** D38 幽默感 (humor): 0(严肃)~1(玩笑/双关) */
  d38_humor: number;
  /** D39 依赖度 (dependency): 0(独立)~1(强烈需要对方) */
  d39_dependency: number;
  /** D40 占有排他 (possessiveness): 0(无)~1(强独占/吃醋) */
  d40_possessiveness: number;
}

// ────────────────────────────────────────────────────────
// 第二部分：扇区定义与常量
// ────────────────────────────────────────────────────────

/** 扇区定义：编号范围 + 名称 + 来源 + 当前填充状态 */
export const PERCEPTION_40D_SECTORS = [
  { key: 'physical_body',        label: '肉身实体基底', start: 1,  end: 8,  source: 'spine.proto' },
  { key: 'inner_spirit',         label: '个体内在精神', start: 9,  end: 14, source: 'spine.proto' },
  { key: 'social_bonds',         label: '圈层人际',     start: 15, end: 20, source: 'spine.proto' },
  { key: 'spatiotemporal',       label: '时空环境',     start: 21, end: 26, source: 'spine.proto' },
  { key: 'dynamic_growth',       label: '动态成长',     start: 27, end: 32, source: 'spine.proto' },
  { key: 'intimate_texture',     label: '伴侣情感纹理', start: 33, end: 40, source: '新增扇区' },
] as const;

/** 扇区检索权重（P3 前：肉身体验/时空/成长无数据源，权重降 0；伴侣纹理最高） */
export const PERCEPTION_40D_SECTOR_WEIGHTS: Record<string, number> = {
  physical_body:   0.0,   // D01-D08: 当前全 0，P3 瑶灵通道上线后激活
  inner_spirit:    0.15,  // D09-D14: 当前部分由中间层派生（P074 后直产）
  social_bonds:    0.15,  // D15-D20: 当前部分由中间层派生（P074 后直产）
  spatiotemporal:  0.0,   // D21-D26: 当前全 0，P3 瑶光通道上线后激活
  dynamic_growth:  0.0,   // D27-D32: 当前全 0，P3 激活
  intimate_texture: 0.30, // D33-D40: ★ 伴侣情感信号，检索权重最高
};

/** 维度总数 */
export const PERCEPTION_40D_DIM = 40;

// 🔴 P072 业主立法级裁决（2026-10-23）：「除 40D 外其它都是违法」
// 原 PERCEPTION_40D_RESONANCE_DIMS（14 维共振切片，零使用空壳）已删除——
// 全系统禁止任何 40D 以下的子维度切片量纲。

/** 40D 维度键序（固定，用于编解码对齐）—— 裸 key 与瑶光 dim_key 一致 */
export const PERCEPTION_40D_KEYS: (keyof PerceptionV40)[] = [
  'd01_muscle_load', 'd02_pain_level', 'd03_nerve_arousal', 'd04_endocrine_hormones',
  'd05_pheromone', 'd06_metabolic_cycle', 'd07_self_heal', 'd08_sensory_env',
  'd09_self_identity', 'd10_desire_drive', 'd11_fear_fatigue', 'd12_enjoyment',
  'd13_empathy', 'd14_self_protection', 'd15_partner_attachment', 'd16_partner_protection',
  'd17_family_belonging', 'd18_family_protection', 'd19_social_fit', 'd20_team_protection',
  'd21_private_space', 'd22_home_environment', 'd23_workplace', 'd24_public_space',
  'd25_spatiotemporal', 'd26_seasonal_climate', 'd27_micro_physiology', 'd28_nature_expansion',
  'd29_social_refinement', 'd30_spiritual_growth', 'd31_quantum_coupling', 'd32_global_overview',
  'd33_sexual_attraction', 'd34_energy_merge', 'd35_sincerity', 'd36_dominance',
  'd37_moral_judgment', 'd38_humor', 'd39_dependency', 'd40_possessiveness',
];

/** 创建全 0 的 PerceptionV40 */
export function createEmptyPerceptionV40(): PerceptionV40 {
  const p = {} as PerceptionV40;
  for (const k of PERCEPTION_40D_KEYS) p[k] = 0;
  return p;
}
