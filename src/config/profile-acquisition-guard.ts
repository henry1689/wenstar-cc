/**
 * 档案自动采集引擎 — 配置常量
 * Profile Acquisition Engine (PAE) Guard Configuration
 *
 * 定位：FG 档案数据的最高安全等级采集配置
 * 与 ingestion-guard.ts 同级，受 fg-kinship-redlines.md 约束
 *
 * V3.3: 户籍登记卡格式重构 — 字段优先级分级 + 待采集主动提级 + 门阀格式验证
 */

export const PAE_CONFIG = {
  // ── 置信度闸门 ──
  /** 置信度 ≥ 此值，直接写入 dossier（绕过 pendingItems） */
  directWriteThreshold: 0.7,

  /** 置信度 ≥ 此值且 < directWriteThreshold，进入 pendingItems */
  pendingThreshold: 0.4,

  /** 置信度 < 此值，丢弃 */
  // （即 pendingThreshold 同时也是 discard 的分界线）

  // ── Token 预算 ──
  /** 传给 LLM 的最大对话文本长度（字符数） */
  maxInputLength: 500,

  /** 已知档案摘要最大长度（字符数），超出截断 */
  maxProfileSummaryLength: 300,

  /** 单次 LLM 调用最多提取的人数 */
  maxPersonsPerCall: 5,

  // ── LLM 参数 ──
  /** 提取用 LLM 温度（低=确定性高） */
  extractionTemperature: 0.1,

  /** LLM 最大输出 token */
  extractionMaxTokens: 2048,

  // ── 限流（成本控制） ──
  /** 每小时最多 LLM 提取调用次数 */
  maxCallsPerHour: 20,

  /** 每日最多 LLM 提取调用次数 */
  maxCallsPerDay: 100,

  // ── 缓存 ──
  /** 提取结果缓存 TTL（毫秒），相同对话文本在此期间复用结果 */
  cacheTTL: 60_000,

  // ── Hook C（AI 回复提取）安全参数 ──
  /** AI 回复提取的置信度阈值更高（AI 可能幻觉） */
  assistantResponseThreshold: 0.8,

  /** AI 回复提取只写 pendingItems（不直接写 dossier） */
  assistantResponseDirectWrite: false,

  // ── 降级 ──
  /** LLM 提取超时（毫秒），超时后降级到正则管道 */
  llmTimeout: 5000,

  // ── V3.3 户籍登记卡采集 ──
  /** 待采集字段的置信度门槛降低幅度（P0: 0.5→0.3, P1: 0.6→0.4, P2-P4: 0.7→0.5） */
  pendingFieldThresholdDrop: 0.2,
} as const;

/** PAE 启动完整性检查项标签 */
export const PAE_INTEGRITY_CHECKS = [
  '无空值污染',
  'pendingItems 质量',
  '无重复 pendingItems',
  'changeHistory 不超限',
  'completeness 合法',
  '无孤儿 dossier',
  '户籍登记卡格式合规',
] as const;

// ═══════════════════════════════════════════════════════════════
// V3.3 户籍登记卡字段定义
// ═══════════════════════════════════════════════════════════════

/** 字段优先级 */
export type FieldPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

/** 登记卡字段定义 */
export interface RegistrationFieldDef {
  /** Dossier 写入路径（null = 存 nodes 列或 edges） */
  path: string | null;
  /** 存储位置 */
  storage: 'nodes' | 'dossier' | 'edges';
  /** 优先级 */
  priority: FieldPriority;
  /** 中文标签 */
  label: string;
  /** 值类型 */
  valueType: 'string' | 'number' | 'string[]' | 'object';
}

/** 优先级 → 默认置信度门槛 */
export const PRIORITY_THRESHOLDS: Record<FieldPriority, number> = {
  P0: 0.5,   // 身份证级：性别/出生年/民族/出生地
  P1: 0.6,   // 户口本级：学历/婚姻/职业/工作单位
  P2: 0.8,   // 联系方式：电话/微信/邮箱/住址
  P3: 0.7,   // 体貌特征：身高/血型/外貌/辨识特征
  P4: 0.7,   // 画像级：性格/喜好/语言习惯/健康
};

/**
 * 太虚境常住人口户籍登记卡 — 完整字段映射表
 *
 * 排序按优先级从高到低，LLM prompt 中照此顺序展示
 */
export const REGISTRATION_FIELD_MAP: Record<string, RegistrationFieldDef> = {
  // ── P0 身份证级（必填项，空白即待采集）──
  'name':              { path: null,                              storage: 'nodes',   priority: 'P0', label: '姓名',         valueType: 'string' },
  'gender':            { path: 'basicInfo.gender',               storage: 'dossier',  priority: 'P0', label: '性别',         valueType: 'string' },
  'birthYear':         { path: 'basicInfo.birthYear',            storage: 'dossier',  priority: 'P0', label: '出生年份',     valueType: 'number' },
  'ethnicity':         { path: 'basicInfo.ethnicity',            storage: 'dossier',  priority: 'P0', label: '民族',         valueType: 'string' },
  'birthPlace':        { path: 'basicInfo.birthPlace',           storage: 'dossier',  priority: 'P0', label: '出生地',       valueType: 'string' },

  // ── P1 户口本级 ──
  'education':         { path: 'basicInfo.education',            storage: 'dossier',  priority: 'P1', label: '学历',         valueType: 'string' },
  'maritalStatus':     { path: 'basicInfo.maritalStatus',        storage: 'dossier',  priority: 'P1', label: '婚姻状况',     valueType: 'string' },
  'occupation':        { path: 'socialIdentity.currentOccupation', storage: 'dossier', priority: 'P1', label: '职业',         valueType: 'string' },
  'workplace':         { path: 'socialIdentity.currentWorkplace',  storage: 'dossier', priority: 'P1', label: '工作单位',     valueType: 'string' },
  'relationToUser':    { path: null,                              storage: 'edges',   priority: 'P1', label: '与户主关系',   valueType: 'string' },

  // ── P2 联系方式（受限访问）──
  'phone':             { path: 'contact.phone',                  storage: 'dossier',  priority: 'P2', label: '电话',         valueType: 'string' },
  'wechat':            { path: 'contact.wechat',                 storage: 'dossier',  priority: 'P2', label: '微信',         valueType: 'string' },
  'email':             { path: 'contact.email',                  storage: 'dossier',  priority: 'P2', label: '邮箱',         valueType: 'string' },
  'address':           { path: 'contact.address',                storage: 'dossier',  priority: 'P2', label: '住址',         valueType: 'string' },

  // ── P3 体貌特征 ──
  'height':            { path: 'selfProfile.bodyFeatures',       storage: 'dossier',  priority: 'P3', label: '身高',         valueType: 'string' },
  'bloodType':         { path: 'selfProfile.healthCondition',    storage: 'dossier',  priority: 'P3', label: '血型',         valueType: 'string' },
  'appearance':        { path: 'selfProfile.appearance',         storage: 'dossier',  priority: 'P3', label: '外貌',         valueType: 'string' },
  'bodyFeatures':      { path: 'selfProfile.bodyFeatures',       storage: 'dossier',  priority: 'P3', label: '体型',         valueType: 'string' },
  'distinguishingMarks':{ path: 'selfProfile.distinguishingMarks', storage: 'dossier', priority: 'P3', label: '辨识特征',     valueType: 'string' },

  // ── P4 画像级 ──
  'traits':            { path: 'selfProfile.traits',             storage: 'dossier',  priority: 'P4', label: '性格标签',     valueType: 'string[]' },
  'likes':             { path: 'selfProfile.likes',              storage: 'dossier',  priority: 'P4', label: '喜好',         valueType: 'string[]' },
  'dislikes':          { path: 'selfProfile.dislikes',           storage: 'dossier',  priority: 'P4', label: '排斥',         valueType: 'string[]' },
  'languageHabits':    { path: 'selfProfile.languageHabits',     storage: 'dossier',  priority: 'P4', label: '语言习惯',     valueType: 'string' },
  'taboos':            { path: 'selfProfile.taboos',             storage: 'dossier',  priority: 'P4', label: '禁忌话题',     valueType: 'string[]' },
  'healthCondition':   { path: 'selfProfile.healthCondition',    storage: 'dossier',  priority: 'P4', label: '健康状况',     valueType: 'string' },
  'ancestralHome':     { path: 'misc.ancestralHome',             storage: 'dossier',  priority: 'P4', label: '籍贯',         valueType: 'string' },
  'style':             { path: 'selfProfile.style',              storage: 'dossier',  priority: 'P4', label: '穿着风格',     valueType: 'string' },
  'voice':             { path: 'selfProfile.voice',              storage: 'dossier',  priority: 'P4', label: '声音特征',     valueType: 'string' },
  'scent':             { path: 'selfProfile.scent',              storage: 'dossier',  priority: 'P4', label: '气味/香水',    valueType: 'string' },
};

/** P0 字段列表（用于"待采集"状态速查） */
export const P0_FIELDS = Object.entries(REGISTRATION_FIELD_MAP)
  .filter(([_, def]) => def.priority === 'P0')
  .map(([key]) => key);

/** P1 字段列表 */
export const P1_FIELDS = Object.entries(REGISTRATION_FIELD_MAP)
  .filter(([_, def]) => def.priority === 'P1')
  .map(([key]) => key);

// ═══════════════════════════════════════════════════════════════
// V3.3 门阀格式验证器（登记卡字段的严格格式约束）
// ═══════════════════════════════════════════════════════════════

/** 中国 56 个民族列表 */
const CN_ETHNICITIES = new Set([
  '汉族','蒙古族','回族','藏族','维吾尔族','苗族','彝族','壮族','布依族',
  '朝鲜族','满族','侗族','瑶族','白族','土家族','哈尼族','哈萨克族','傣族',
  '黎族','傈僳族','佤族','畲族','高山族','拉祜族','水族','东乡族','纳西族',
  '景颇族','柯尔克孜族','土族','达斡尔族','仫佬族','羌族','布朗族','撒拉族',
  '毛南族','仡佬族','锡伯族','阿昌族','普米族','塔吉克族','怒族','乌孜别克族',
  '俄罗斯族','鄂温克族','德昂族','保安族','裕固族','京族','塔塔尔族','独龙族',
  '鄂伦春族','赫哲族','门巴族','珞巴族','基诺族',
]);

/** 标准学历列表 */
const CN_EDUCATIONS = new Set([
  '小学','初中','高中','中专','中技','大专','本科','硕士','博士','博士后',
  '文盲','私塾','肄业',
]);

/** 标准婚姻状况 */
const CN_MARITAL_STATUS = new Set(['未婚','已婚','离异','丧偶','再婚','分居']);

/** 登记卡字段格式验证器（比 FIELD_VALIDATORS 更严格） */
export const FORMAT_VALIDATORS: Record<string, (value: any) => { valid: boolean; reason?: string }> = {
  'gender': (v) => {
    const s = String(v).trim();
    if (s === '男' || s === '女') return { valid: true };
    return { valid: false, reason: `性别必须为"男"或"女"，收到: "${s}"` };
  },
  'birthYear': (v) => {
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    if (isNaN(n)) return { valid: false, reason: '出生年份必须为数字' };
    const currentYear = new Date().getFullYear();
    if (n < 1900 || n > currentYear) return { valid: false, reason: `出生年份必须在 1900-${currentYear} 之间，收到: ${n}` };
    return { valid: true };
  },
  'ethnicity': (v) => {
    const s = String(v).trim();
    if (CN_ETHNICITIES.has(s)) return { valid: true };
    return { valid: false, reason: `"${s}" 不在中国56个民族列表中，请核实` };
  },
  'birthPlace': (v) => {
    const s = String(v).trim();
    if (s.length < 2) return { valid: false, reason: '出生地至少2个字符' };
    // 至少包含省/市级关键词
    if (!/[省市县区州]/.test(s)) return { valid: false, reason: `出生地应包含省/市/县级地名，收到: "${s}"` };
    return { valid: true };
  },
  'education': (v) => {
    const s = String(v).trim();
    if (CN_EDUCATIONS.has(s)) return { valid: true };
    // 模糊匹配：含有关键词
    if (/^(小学|初中|高中|中专|大专|本科|硕士|博士|大学)/.test(s)) return { valid: true };
    return { valid: false, reason: `"${s}" 不在标准学历列表中` };
  },
  'maritalStatus': (v) => {
    const s = String(v).trim();
    if (CN_MARITAL_STATUS.has(s)) return { valid: true };
    return { valid: false, reason: `婚姻状况必须为: ${[...CN_MARITAL_STATUS].join('/')}，收到: "${s}"` };
  },
  'phone': (v) => {
    const s = String(v).replace(/\s|-/g, '');
    if (/^1[3-9]\d{9}$/.test(s)) return { valid: true };
    return { valid: false, reason: `手机号格式不正确: "${String(v).substring(0, 15)}"` };
  },
  'height': (v) => {
    const s = String(v).trim();
    if (/^\d{2,3}(cm|厘米)?$/.test(s)) return { valid: true };
    if (/^\d{2,3}[-~]\d{2,3}(cm|厘米)?$/.test(s)) return { valid: true };
    return { valid: false, reason: `身高格式应为"165cm"或"165-168cm"，收到: "${s}"` };
  },
};

/**
 * 判断字段是否为登记卡字段，返回其定义（用于查找 priority）
 */
export function getRegistrationFieldDef(fieldKey: string): RegistrationFieldDef | undefined {
  return REGISTRATION_FIELD_MAP[fieldKey];
}

/**
 * 获取登记卡字段在给定 fieldPath 下的定义（支持完整路径匹配和简短 key 匹配）
 */
export function resolveRegistrationDef(fieldPath: string): { key: string; def: RegistrationFieldDef } | undefined {
  // 精确匹配 key
  if (REGISTRATION_FIELD_MAP[fieldPath]) {
    return { key: fieldPath, def: REGISTRATION_FIELD_MAP[fieldPath] };
  }
  // 尝试匹配完整路径
  for (const [key, def] of Object.entries(REGISTRATION_FIELD_MAP)) {
    if (def.path === fieldPath) {
      return { key, def };
    }
  }
  return undefined;
}
