// FamilyGraph — SQLite 图结构家族知识库
// Ref: M4-design-v1.md §3
//
// ╔═══════════════════════════════════════════════════════╗
// ║  FamilyGraph.ts  v1.0                                 ║
// ║  归属: M4 (知识融合层)                               ║
// ║  职责: 家族关系图谱的存储与自动推断                    ║
// ║  日期: 2026-06-02                                    ║
// ╚═══════════════════════════════════════════════════════╝

// @ts-ignore - sql.js ships its own types via dist/sql-wasm.js
import initSqlJs from 'sql.js';
import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EntityGene } from '../m1/types/dna.js';
import { validatePersonName, validateRelationType } from './EntityValidator.js';
import type {
  FamilyGraph as FamilyGraphInterface,
  GraphNode,
  GraphEdge,
  GraphQueryResult,
  GraphPath,
  InferenceResult,
  FamilySummary,
  RelationCandidate,
  CircleLevel,
  RelationWeights,
  NodeType,
} from './types/graph.js';
import { DEFAULT_BASE_INTIMACY } from './types/graph.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_DB_PATH = join(__dirname, '..', '..', 'data', 'webui', 'knowledge', 'family_graph.db');

/**
 * P1: 人物画像 — 从"名字"到"完整的人"
 * 存储在 node.properties JSON 中，每次对话逐步丰富。
 *
 * v1.1 升级: 新增 PersonDossier 6 模块结构化档案体系
 *  - 基础信息卡、人生履历、形象特质、性格偏好、关系定位、记忆锚点
 *  - 原有 flat 字段保持兼容
 *  - 新增字段通过 dossier 子对象存储
 */
export interface PersonProfile {
  // ── 基础 ──
  name: string;
  age?: number;        // 🏛️ @deprecated: 请用 birthYear，年龄由 getCalculatedAge() 实时计算
  birthYear?: number;  // 🏛️ §十三: 出生年份（年龄唯一来源）
  relation_to_user: string;
  /** 首次提及日期 */
  first_mentioned?: string;
  /** 最近提及日期 */
  last_mentioned: string;
  /** 累计提及次数 */
  mention_count: number;

  // ── 人物全方位档案（用户说的所有信息累计） ──
  /** 外貌长相：身高、脸型、五官、皮肤、发型等 */
  appearance?: string;
  /** 身体特征：身材、胸、臀、腰、腿等 */
  body_features?: string;
  /** 穿着风格 */
  style?: string;
  /** 性格特征：开朗/幽默/热心 等 */
  traits?: string[];
  /** 性格自由描述 */
  personality?: string;
  /** 职业 */
  occupation?: string;
  /** 兴趣爱好 */
  interests?: string[];
  /** 习惯 */
  habits?: string;
  /** 心理/内心特征 */
  psychology?: string;
  /** 声音特征 */
  voice?: string;
  /** 自由文本描述（累计所有说过的话） */
  description?: string;

  /** 重要事件时间线 */
  timeline?: Array<{
    date: string;
    summary: string;
    emotion?: string;
  }>;
  /** 玉瑶已问过的问题（去重用） */
  asked_questions?: string[];
  /** 画像完整度（0-1，自动计算） */
  completeness?: number;

  // ── v1.1 新增: 6 模块结构化档案 + 辅助字段 ──
  /** 结构化人事档案（6 模块） */
  dossier?: PersonDossier;
  /** 待确认条目（30 天 TTL） */
  pendingItems?: PendingItem[];
  /** 已记录的冲突历史 */
  conflicts?: Array<{ field: string; oldValue: string; newValue: string; timestamp: string }>;
  /** 是否标记为有冲突 */
  conflict?: boolean;
  /** 🏛️ §十三: 档案变更时间向量 */
  _changeHistory?: Array<{ field: string; oldValue: any; newValue: any; timestamp: string }>;
}

/**
 * 6 模块人事档案结构化定义
 * 所有档案字段统一走 EntityValidator 校验
 *
 * v1.2 升级: 扩展为完整人事档案体系
 * - 新增 联系方式、健康状况、人生里程碑、家庭关系网、社会资本 模块
 * - 原6模块扩展为10模块
 */
export interface PersonDossier {
  /** 模块① 基础信息卡 */
  basicInfo: {
    gender?: string;
    birthYear?: number;
    birthPlace?: string;
    education?: string;
    maritalStatus?: string;
    /** 生肖 */
    zodiac?: string;
    /** 民族 */
    ethnicity?: string;
  };
  /** 模块② 联系方式 */
  contact: {
    phone?: string;
    wechat?: string;
    address?: string;
    email?: string;
    workplace?: string;
  };
  /** 模块③ 人生履历 */
  lifeResume: {
    timeline: Array<{ date: string; summary: string; emotion?: string }>;
    careerHistory?: string;
    notableEvents?: string[];
  };
  /** 模块④ 形象特质 — 含女性详细体征描述 */
  imageTraits: {
    looks?: string;        // 外貌长相（脸型、五官、皮肤等）
    bodyFeatures?: string;  // 身材特征（身高、体型、曲线等）
    style?: string;         // 穿着风格
    voice?: string;         // 声音特征
    distinguishingMarks?: string;  // 辨识特征（痣、纹身、疤痕等）
    /** 香水/气味标签 */
    scent?: string;
    /** 🧬 女性详细体征（非家人女性专用 — 详细到像活生生站在眼前） */
    feminineDetails?: {
      /** 整体印象 — 看到她的第一感觉、气质类型 */
      firstImpression?: string;
      /** 身高体型 */
      stature?: string;
      /** 三围/身材数据（胸围/腰围/臀围/腿长等描述） */
      measurements?: string;
      /** 胸部特征（大小/形状/手感/乳晕等） */
      breasts?: string;
      /** 臀部特征（大小/形状/手感/弹性） */
      buttocks?: string;
      /** 腰/腹部特征 */
      waist?: string;
      /** 腿部特征 */
      legs?: string;
      /** 皮肤（颜色/质感/光滑度/温度） */
      skin?: string;
      /** 手部特征 */
      hands?: string;
      /** 唇部特征 */
      lips?: string;
      /** 眼神/眼睛特征 */
      eyes?: string;
      /** 秀发特征 */
      hair?: string;
      /** 性感度/魅惑力描述 */
      allure?: string;
      /** 私密体味/体香 */
      bodyScent?: string;
      /** 触感描述（皮肤手感、身体温度等） */
      touch?: string;
      /** 亲密时的反应特征 */
      intimateReaction?: string;
      /** 特殊记忆点（最让人怀念的独特之处） */
      memorableTraits?: string;
    };
  };
  /** 模块⑤ 性格偏好 */
  personalityPrefs: {
    traits: string[];       // 标签化性格（开朗/幽默等）
    description?: string;   // 性格自由描述
    interests: string[];    // 兴趣爱好
    habits?: string;        // 习惯
    psychology?: string;    // 心理/内心特征
  };
  /** 模块⑥ 关系定位 — 与用户的关系定位 + 交集记录 */
  relationMap: {
    relationToUser: string; // 与用户的关系
    /** 交集与共同经历 — 用户与此人的工作、生活、情感、社交等所有互动记录 */
    intersections?: {
      /** 结识时间/场景 */
      metWhen?: string;
      /** 共事记录（怎么认识的、一起做过什么项目/业务） */
      workTogether?: string;
      /** 生活交集（一起做过的事、去过的地方、共同的社交圈） */
      lifeIntersection?: string;
      /** 情感评价（用户对此人的真实情感倾向：信任/依赖/亲密/敌视/疏远等） */
      emotionalAssessment?: string;
      /** 利益关系（合伙人/上下游/竞争/雇佣等） */
      interestRelation?: string;
      /** 重要共同事件 */
      sharedEvents?: Array<{
        date: string;
        event: string;
        type: 'work' | 'life' | 'family' | 'business';
      }>;
    };
    notes?: string;          // 自由备注
  };
  /** 模块⑦ 家庭关系网 */
  familyNetwork: {
    /** 父母 */
    parents?: string[];
    /** 配偶 */
    spouse?: string;
    /** 子女 */
    children?: string[];
    /** 兄弟姐妹 */
    siblings?: string[];
    /** 其他亲属关系描述 */
    extended?: string;
  };
  /** 模块⑧ 健康状况 */
  health: {
    /** 身体状况描述 */
    condition?: string;
    /** 病史/疾病 */
    medicalHistory?: string;
    /** 过敏信息 */
    allergies?: string;
    /** 生活习惯（烟酒茶等） */
    lifestyle?: string;
  };
  /** 模块⑨ 人生里程碑 */
  lifeMilestones: Array<{
    date: string;
    event: string;
    type: 'birth' | 'marriage' | 'childbirth' | 'death' | 'career' | 'education' | 'other';
    detail?: string;
  }>;
  /** 模块⑩ 社会资本 */
  socialCapital: {
    /** 同事/合作伙伴 */
    colleagues?: string[];
    /** 朋友 */
    friends?: string[];
    /** 客户 */
    clients?: string[];
    /** 重要社交关系描述 */
    description?: string;
  };
  /** 记忆锚点（Top-5，满5自动淘汰最旧） */
  memoryAnchors: {
    diamondIds: string[];   // 最多 5 条，存黑钻记忆 ID
  };
  /** V2.0 兜底字段：自由格式JSON，存放无固定归档字段的零散补充信息 */
  misc?: Record<string, any>;
  /** V2.0 典籍双向绑定：关联的TXJ典籍户籍清单 */
  boundDocuments?: Array<{
    docId: string;
    title: string;
    type: 'knowledge' | 'task' | 'note' | 'setting';
    boundAt: string;
  }>;
  /** V6: 固有完整人设档案（替代 imageTraits + personalityPrefs + health + 散落flat字段） */
  selfProfile?: {
    traits?: string[]; appearance?: string; bodyFeatures?: string;
    style?: string; voice?: string; scent?: string; distinguishingMarks?: string;
    likes?: string[]; dislikes?: string[]; languageHabits?: string; taboos?: string[];
    healthCondition?: string; feminineDetails?: any; pendingItems?: any[];
  };
  /** V6: 社会身份时间线（替代 relationMap 时序 + occupation 散落） */
  socialIdentity?: {
    timeline?: Array<{ period: string; role: string; detail?: string; sourceRef?: string }>;
    currentOccupation?: string; currentWorkplace?: string;
    maritalTimeline?: Array<{ date: string; event: string }>;
  };
  /** V6: 归档旧模块（卷宗只增不删） */
  _deprecated?: Record<string, any>;
}

/** 待确认条目（30 天 TTL） */
export interface PendingItem {
  field: string;            // 对应的模块字段名
  value: string;            // 待确认的值
  source: string;           // 来源（对话摘要）
  timestamp: string;        // 创建时间
  confirmed: boolean;       // 是否已确认
  occurrences?: number;     // 累计被重复观察到的次数
}

interface UpdatePersonProfileOptions {
  countMention?: boolean;
}

// ─── 亲属称谓 → 关系映射（自动推断核心词表）───
// Ref: M4-design-v1.md §3.5
const KINSHIP_MAP: Record<string, string> = {
  '妈妈': 'mother_of', '妈': 'mother_of', '母亲': 'mother_of',
  '爸爸': 'father_of', '爸': 'father_of', '父亲': 'father_of',
  '老公': 'spouse_of', '老婆': 'spouse_of',
  '丈夫': 'spouse_of', '妻子': 'spouse_of',
  '哥哥': 'sibling_of', '弟弟': 'sibling_of',
  '姐姐': 'sibling_of', '妹妹': 'sibling_of',
  '爷爷': 'grandfather_of', '奶奶': 'grandmother_of',
  '外公': 'grandfather_of', '外婆': 'grandmother_of',
  // FIX-2: 补充缺失的亲属称谓
  '儿子': 'child_of', '女儿': 'child_of', '孩子': 'child_of', '子女': 'child_of',
  '孙子': 'grandchild_of', '孙女': 'grandchild_of',
};

// ─── 社交关系 → 关系映射（与 KINSHIP_MAP 互补——同一人可同时拥有家族边和社交边）───
// Ref: STRATEGIC_BLUEPRINT.md — 人际关系图谱
const SOCIAL_MAP: Record<string, string> = {
  '同事': 'colleague_of', '同学': 'classmate_of', '室友': 'roommate_of',
  '老板': 'boss_of', '上司': 'boss_of', '领导': 'boss_of',
  '下属': 'subordinate_of', '部下': 'subordinate_of', '手下': 'subordinate_of',
  '客户': 'client_of', '顾客': 'client_of',
  '朋友': 'friend_of', '好友': 'friend_of',
  '合伙人': 'partner_of', '搭档': 'partner_of',
  '邻居': 'neighbor_of',
  '老师': 'teacher_of', '师父': 'teacher_of', '师傅': 'teacher_of',
  '学生': 'student_of', '徒弟': 'student_of',
  '医生': 'doctor_of',
  '顾问': 'consultant_of',
};

const SOCIAL_REVERSE: Record<string, string> = {
  colleague_of: 'colleague_of', classmate_of: 'classmate_of', roommate_of: 'roommate_of',
  boss_of: 'subordinate_of', subordinate_of: 'boss_of',
  client_of: 'server_of', friend_of: 'friend_of',
  partner_of: 'partner_of', neighbor_of: 'neighbor_of',
  teacher_of: 'student_of', student_of: 'teacher_of',
  doctor_of: 'patient_of', consultant_of: 'client_of',
  server_of: 'client_of', acquaintance_of: 'acquaintance_of',
  comrade_of: 'comrade_of', fellow_of: 'fellow_of',
  vendor_of: 'vendor_of', competitor_of: 'competitor_of',
  stranger_of: 'stranger_of',
};

/** 🏛️ 社会关系 → 中文称谓 */
const SOCIAL_LABEL_CN: Record<string, string> = {
  colleague_of: '同事', classmate_of: '同学', roommate_of: '室友',
  boss_of: '上级', subordinate_of: '下属', client_of: '客户',
  friend_of: '朋友', partner_of: '合伙人', neighbor_of: '邻居',
  teacher_of: '老师', student_of: '学生', doctor_of: '医生',
  consultant_of: '顾问', server_of: '服务方', acquaintance_of: '认识的人',
  comrade_of: '战友', fellow_of: '会友', vendor_of: '供应商',
  competitor_of: '竞争对手', stranger_of: '陌生人',
  employer_of: '雇主', employee_of: '雇员',
  investor_of: '投资人', supplier_of: '供应商',
  _reverse_boss_of: '下属', _reverse_subordinate_of: '上级',
  _reverse_client_of: '服务方', _reverse_server_of: '客户',
  _reverse_teacher_of: '学生', _reverse_student_of: '老师',
  _reverse_acquaintance_of: '认识的人', _reverse_friend_of: '朋友',
  _reverse_colleague_of: '同事', _reverse_classmate_of: '同学',
};

const REVERSE_RELATION: Record<string, string> = {
  parent_of: 'child_of',
  mother_of: 'child_of', father_of: 'child_of',
  spouse_of: 'spouse_of',
  sibling_of: 'sibling_of',
  grandfather_of: 'grandchild_of', grandmother_of: 'grandchild_of',
  child_of: 'parent_of',
  grandchild_of: 'grandfather_of',
  lives_in: 'residence_of',
  close_to: 'close_to',
};

/** 🏛️ §十五: 统一反向映射表（家族+社交，同等对待） */const ALL_REVERSE: Record<string, string> = { ...REVERSE_RELATION, ...SOCIAL_REVERSE };
const KINSHIP_TERMS = Object.keys(KINSHIP_MAP).sort((a, b) => b.length - a.length);
const PENDING_PROMOTION_THRESHOLD = 3;
const SPECIFIC_KINSHIP_LABEL: Record<string, string> = {
  '妈妈': '妈妈', '妈': '妈妈', '母亲': '妈妈',
  '爸爸': '爸爸', '爸': '爸爸', '父亲': '爸爸',
  '姐姐': '姐姐', '妹妹': '妹妹', '哥哥': '哥哥', '弟弟': '弟弟',
  '老公': '老公', '老婆': '老婆', '丈夫': '老公', '妻子': '老婆',
  '爷爷': '爷爷', '奶奶': '奶奶', '外公': '外公', '外婆': '外婆',
  '儿子': '儿子', '女儿': '女儿', '孩子': '孩子', '子女': '孩子',
  '孙子': '孙子', '孙女': '孙女',
};

// ─── v2.0 商业组织关系映射（人物↔组织、组织↔组织） ───
const ORG_MAP: Record<string, string> = {
  '公司': 'org_of', '企业': 'org_of', '工厂': 'org_of',
  '部门': 'dept_of', '研发部': 'dept_of', '生产部': 'dept_of',
  '总经理': 'ceo_of', '老板': 'owner_of', '大股东': 'owner_of',
};
const ORG_REVERSE: Record<string, string> = {
  org_of: 'member_of', dept_of: 'parent_dept_of',
  ceo_of: 'subordinate_of', owner_of: 'subordinate_of',
  member_of: 'org_of', parent_dept_of: 'dept_of',
};

// ─── v2.0 实体从属关系映射（人物↔物、物↔空间） ───
const ENTITY_REL_MAP: Record<string, string> = {
  '属于': 'belongs_to', '位于': 'located_in', '在': 'located_in',
  '操作': 'operated_by', '使用': 'operated_by',
  '考察': 'inspected_by', '检查': 'inspected_by', '审核': 'inspected_by',
};

/**
 * 生成简单 UUID
 */
/** 🏛️ 边类型 → 中文关系标签 */
const RELATION_LABEL_CN: Record<string, string> = {
  mother_of: '妈妈', father_of: '爸爸', parent_of: '父母', child_of: '子女',
  elder_sister_of: '姐姐', younger_sister_of: '妹妹', sister_of: '姐妹',
  elder_brother_of: '哥哥', younger_brother_of: '弟弟', brother_of: '兄弟',
  sibling_of: '手足', spouse_of: '配偶',
  grandfather_of: '爷爷', grandmother_of: '奶奶', grandchild_of: '孙辈',
  aunt_of: '阿姨/姑姑', uncle_of: '叔叔/舅舅',
  niece_of: '侄女/甥女', nephew_of: '侄子/甥子', cousin_of: '堂表亲',
  _reverse_mother_of: '子女', _reverse_father_of: '子女',
  _reverse_elder_sister_of: '妹妹', _reverse_younger_sister_of: '姐姐',
  _reverse_elder_brother_of: '弟弟', _reverse_younger_brother_of: '哥哥',
};

function uid(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `${ts}-${rand}`;
}

function parseAliases(raw: unknown): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
      : [];
  } catch {
    return [];
  }
}

function isLikelyPlaceName(value: string): boolean {
  return /^(北京|上海|深圳|广州|杭州|苏州|成都|武汉|南京|天津|重庆|西安|长沙|青岛|厦门|宁波|无锡|佛山|东莞|珠海|绍兴|福州|合肥|昆明|郑州|济南|沈阳|大连|南昌|嘉兴|常州)$/.test(value);
}

function isInvalidProfileSnippet(value: string): boolean {
  return /^(叫|什么|哪|哪里|哪儿|谁)/.test(value) || /什么|哪上班|哪里上班|是谁/.test(value);
}

function isSpecificRelationLabel(value?: string): boolean {
  return !!value && /^(妈妈|爸爸|姐姐|妹妹|哥哥|弟弟|老公|老婆|爷爷|奶奶|外公|外婆|儿子|女儿|孩子|孙子|孙女)$/.test(value);
}

function normalizePendingKey(field: string, value: string): string {
  return `${field}::${value.trim().replace(/\s+/g, ' ')}`;
}

/**
 * FamilyGraph — SQLite 图结构家族知识库
 *
 * 使用 sql.js（纯 JS 的 SQLite 实现）存储图数据库。
 * 节点表 (nodes) + 边表 (edges)，SQL 递归查询。
 *
 * v1.0 聚焦：自动提取 + 关系推断
 */

// ─── V4.0 Phase 7: 亲属称谓类型 ───

interface PersonNodeInfo {
  id: string; name: string;
  gender: string | null; age: number | null; surname: string;
}

interface KinshipStep {
  fromId: string; targetId: string; relation: string;
  targetName: string; targetGender: string | null;
}

interface RelationPattern {
  category: 'self' | 'parent' | 'child' | 'sibling' | 'aunt_uncle' | 'niece_nephew'
    | 'cousin' | 'grandparent' | 'grandchild' | 'great_grandparent' | 'great_grandchild'
    | 'grand_aunt_uncle' | 'grand_niece_nephew' | 'second_cousin'
    | 'spouse' | 'inlaw_parent' | 'inlaw_sibling' | 'inlaw_sibling_spouse'
    | 'inlaw_child_spouse' | 'spouse_sibling' | 'social' | 'relative';
  sub?: string;
  lineage?: 'paternal' | 'maternal' | 'unknown';
}

interface KinshipTerm {
  term: string;       // fromPerson 称呼 toPerson 的方式
  reverse: string;    // toPerson 称呼 fromPerson 的方式
  category: string;
  generation: number; // 0=同辈, 1=长一辈, -1=小一辈, 2=祖辈
}

interface ConflictItem { field: string; oldValue: string; newValue: string; timestamp: string; resolved?: boolean; }
interface ConflictReport { hasConflict: boolean; items: ConflictItem[]; }

/** 🏛️ §12.2: 拦截LLM生成的对话文本混入pendingItems */
function _isValidPendingValue(value: string): boolean {
  if (!value || typeof value !== 'string') return false;
  if (/^\s*[\n\r：:玉]/.test(value)) return false;
  if (/（.*?）/.test(value) && value.length < 20) return false;
  if (/^\d+$/.test(value) && parseInt(value) > 120) return false;
  if (/\n玉瑶|\n我|\n用户/.test(value)) return false;
  return value.trim().length >= 2 && value.trim().length <= 100;
}

export class FamilyGraph implements FamilyGraphInterface {
  private db: any | null = null;
  private dbPath: string;
  private userNodeId: string | null = null;
  /** P4: 批量落盘 — 减少IO */
  private _dirty = false;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  private ready = false;
  /** 🛡️ 隐私 — 仅调试模式输出人名/关系到日志 */
  private _verbose = false;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? DEFAULT_DB_PATH;
  }

  async initialize(): Promise<void> {
    const SQL = await initSqlJs();
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (existsSync(this.dbPath)) {
      const buffer = readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }

    this.run(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        aliases TEXT DEFAULT '[]',
        properties TEXT DEFAULT '{}',
        uuid TEXT,
        category CHAR(1),
        security_level INTEGER DEFAULT 1,
        entity_source TEXT DEFAULT 'placeholder',
        status TEXT DEFAULT 'active',
        legacy_ids TEXT DEFAULT '[]',
        family_gene TEXT,
        social_group_genes TEXT DEFAULT 'WW',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.run(`
      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        properties TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (source_id) REFERENCES nodes(id),
        FOREIGN KEY (target_id) REFERENCES nodes(id)
      )
    `);
    this.run('CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type)');
    this.run('CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name)');
    this.run('CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id)');
    this.run('CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id)');
    this.run('CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation)');

    // v2.0: 先升级存量数据（创建新列），再建索引
    this.migrateToV2();
    // V3.2: UUID 户籍编号体系迁移
    this.migrateToV3();
    // V3.3: 户籍管理法 V1.1 列级补齐
    this.migrateToV4();
    // V2.0: UUID去前缀 + name清洗 + 卷宗永久
    this._migrateToV5();
    try { this.run('CREATE INDEX IF NOT EXISTS idx_nodes_circle ON nodes(circle_level)'); } catch (e) { console.warn(`[FamilyGraph] 操作失败`, (e as Error)?.message || e); }
    try { this.run('CREATE INDEX IF NOT EXISTS idx_edges_source_rel ON edges(source_id, relation)'); } catch (e) { console.warn(`[FamilyGraph] 操作失败`, (e as Error)?.message || e); }
    try { this.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_uuid ON nodes(uuid) WHERE uuid IS NOT NULL'); } catch (e) { console.warn(`[FamilyGraph] 操作失败`, (e as Error)?.message || e); }
    try { this.run('CREATE INDEX IF NOT EXISTS idx_nodes_family_gene ON nodes(family_gene)'); } catch (e) { console.warn(`[FamilyGraph] 操作失败`, (e as Error)?.message || e); }
    try { this.run('CREATE INDEX IF NOT EXISTS idx_nodes_social_genes ON nodes(social_group_genes)'); } catch (e) { console.warn(`[FamilyGraph] 操作失败`, (e as Error)?.message || e); }
    try { this.run('CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status)'); } catch (e) { console.warn(`[FamilyGraph] 操作失败`, (e as Error)?.message || e); }

    this.markDirty();
    this.ready = true;

    // 🛡️ 备份仅在 initialize() 时执行（户籍制度 §7.1）
    this._ensureBackup();
    this._ensureSelfNode();
  }

  /**
   * FG基建加固：自动备份到 data/webui/backups/family_graph/
   */
  private _ensureBackup(): void {
    try {
      const backupDir = join(dirname(this.dbPath), '..', 'backups', 'family_graph');
      if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const backupPath = join(backupDir, 'family_graph_backup_' + ts + '.db');
      if (existsSync(this.dbPath)) {
        copyFileSync(this.dbPath, backupPath);
        console.log('[FG Shield] 自动备份完成: backup_' + ts + '.db');
      }
    } catch (e) {
      console.warn('[FG Shield] 自动备份失败:', e);
    }
    // V4.0 Phase 3: 异步清理旧备份（不阻塞主流程）
    setImmediate(() => this._cleanupOldBackups());
  }

  /** V4.0 Phase 3: 备份分级清理 — 7天内每天1份/30天内每周1份/30天+每月1份 */
  private _cleanupOldBackups(): void {
    try {
      const backupDir = join(dirname(this.dbPath), '..', 'backups', 'family_graph');
      if (!existsSync(backupDir)) return;
      const files = readdirSync(backupDir)
        .filter((f: string) => f.startsWith('family_graph_backup_') && f.endsWith('.db'));
      if (files.length < 15) return; // 不足15份不触发清理（户籍制度 §7.2）

      const now = Date.now(); const oneDay = 86400000;
      const byDay = new Map<string, { path: string; mtime: number }[]>();
      for (const f of files) {
        const fp = join(backupDir, f); const st = statSync(fp);
        const dk = new Date(st.mtimeMs).toISOString().substring(0, 10);
        if (!byDay.has(dk)) byDay.set(dk, []);
        byDay.get(dk)!.push({ path: fp, mtime: st.mtimeMs });
      }

      const toKeep = new Set<string>();
      for (const [i, day] of [...byDay.keys()].sort().entries()) {
        const dfs = byDay.get(day)!.sort((a, b) => b.mtime - a.mtime);
        const age = (now - dfs[0].mtime) / oneDay;
        if (age <= 7) { toKeep.add(dfs[0].path); }
        else if (age <= 30) { if (new Date(dfs[0].mtime).getDay() === 1) toKeep.add(dfs[0].path); }
        else { if (new Date(dfs[0].mtime).getDate() <= 7) toKeep.add(dfs[0].path); }
      }

      let deleted = 0;
      for (const f of files) {
        const fp = join(backupDir, f);
        if (!toKeep.has(fp)) { unlinkSync(fp); deleted++; }
      }
      if (deleted > 0) console.log('[FG Shield] 备份清理: 删除 ' + deleted + '/' + files.length + ' 份, 保留 ' + toKeep.size + ' 份');
    } catch { /* 清理失败不影响主功能 */ }
  }

  /**
   * FG基建加固：确保"我"节点存在（家族图谱的基石）
   */
  private _ensureSelfNode(): void {
    try {
      const existing = this.query("SELECT id FROM nodes WHERE name = ? AND type = ?", ['我', 'person']);
      if (existing.length === 0) {
        const meId = uid();
        const now = new Date().toISOString();
        const meProps = JSON.stringify({ name: '我', type: 'self', relation_to_user: '自己' });
        this.run("INSERT INTO nodes (id, type, name, properties, uuid, category, security_level, entity_source, status, legacy_ids, family_gene, social_group_genes, created_at, updated_at) VALUES (?, 'person', '我', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [meId, meProps, 'S-00001', 'S', 3, 'ai', 'active', '[]', null, 'WW', now, now]);
        this.userNodeId = meId;
        console.log('[FG Shield] "我"节点丢失！已重建 id=' + meId);
        this.markDirty(true);
      } else {
        this.userNodeId = existing[0].id;
        // V2.0: 确保"我"节点的 category 永远正确（不再硬编码 UUID 格式）
        const currentInfo = this.query('SELECT category, security_level FROM nodes WHERE id = ?', [this.userNodeId]);
        if (currentInfo.length > 0) {
          const r = currentInfo[0] as any;
          if (r.category !== 'S') {
            this.run('UPDATE nodes SET category = ?, security_level = ? WHERE id = ?', ['S', 3, this.userNodeId]);
          }
        }
      }
    } catch (e) {
      console.error('[FG Shield] "我"节点检查失败:', e);
    }
  }

  /**
   * v2.0: 将存量数据升级到 EntityGraph v2 结构
   * - 新增 circle_level 列
   * - 为 edges 初始化权重默认值
   */
  migrateToV2(): void {
    // 节点：新增 circle_level 列（若不存在）
    try { this.run('ALTER TABLE nodes ADD COLUMN circle_level INTEGER DEFAULT 0'); } catch (e) { console.warn(`[FamilyGraph] 操作失败`, (e as Error)?.message || e); }
    try { this.run('ALTER TABLE nodes ADD COLUMN tags TEXT DEFAULT "[]"'); } catch (e) { console.warn(`[FamilyGraph] 操作失败`, (e as Error)?.message || e); }

    // 边：为新兼容字段准备 properties 默认值
    const rows = this.query('SELECT id, properties FROM edges WHERE properties = ? OR properties IS NULL', ['{}']);
    for (const r of rows) {
      const props = { ...JSON.parse(r.properties || '{}'), _v2: true };
      this.run('UPDATE edges SET properties = ? WHERE id = ?', [JSON.stringify(props), r.id]);
    }
  }

  /**
   * V3.2 户籍制 UUID 迁移：给所有节点分配 UUID 编号
   * - 新增 uuid、category 列
   * - 存量节点自动生成 UUID（按 relation_to_user 推断分类）
   * - 后续新增节点在 addNode() 时自动分配 UUID
   */
  migrateToV3(): void {
    // Step 1: 新增列（幂等，已存在则跳过）
    try { this.run('ALTER TABLE nodes ADD COLUMN uuid TEXT'); } catch (e) { /* 列已存在 */ }
    try { this.run('ALTER TABLE nodes ADD COLUMN category CHAR(1)'); } catch (e) { /* 列已存在 */ }
    try { this.run('ALTER TABLE nodes ADD COLUMN security_level INTEGER DEFAULT 1'); } catch (e) { /* 列已存在 */ }

    // Step 2: 为无 UUID 的存量 person 节点生成编号
    const orphanRows = this.query(
      "SELECT id, name, properties FROM nodes WHERE type = 'person' AND (uuid IS NULL OR uuid = '')"
    );
    if (orphanRows.length > 0) {
      // 获取各分类当前最大流水号
      const seqMap = new Map<string, number>();
      const existing = this.query("SELECT category, uuid FROM nodes WHERE type = 'person' AND uuid IS NOT NULL") as Array<{ category: string; uuid: string }>;
      for (const row of existing) {
        const cat = row.category || 'G';
        const num = parseInt((row.uuid || '').split('-')[1] || '0', 10);
        if (!isNaN(num) && num > (seqMap.get(cat) || 0)) {
          seqMap.set(cat, num);
        }
      }

      let migrated = 0;
      for (const row of orphanRows) {
        const props = JSON.parse(row.properties || '{}');
        const category = this._inferCategory(props.relation_to_user || '', row.name, row.id);
        const nextSeq = (seqMap.get(category) || 0) + 1;
        seqMap.set(category, nextSeq);
        const uuid = this._formatUUID(category, nextSeq);

        this.run('UPDATE nodes SET uuid = ?, category = ? WHERE id = ?', [uuid, category, row.id]);
        migrated++;
      }

      if (migrated > 0 && this._verbose) {
        console.log(`[FamilyGraph] V3.2 UUID 迁移: ${migrated} 个节点已分配户籍编号`);
      }
    }

    // Step 3: 修复已分配但分类可能错误的节点（多源推断器升级后的回溯修正）
    // 🔴 必须在 early return 之后执行——因为即使没有新孤儿节点，旧节点的分类也可能需要修正
    this._repairCategoryMismatches();
  }

  /**
   * V3.2.1: 系统性分类复核
   * 对已分配 UUID 的节点重新运行多源推断器，修正因旧版单源推断器导致的分类错误。
   * 仅修正 category 和 uuid（保留其他字段不变）。
   */
  private _repairCategoryMismatches(): void {
    const allPersons = this.query(
      "SELECT id, name, properties, uuid, category FROM nodes WHERE type = 'person' AND uuid IS NOT NULL"
    ) as Array<{ id: string; name: string; properties: string; uuid: string; category: string }>;

    let repaired = 0;
    for (const row of allPersons) {
      const props = JSON.parse(row.properties || '{}');
      const newCategory = this._inferCategory(props.relation_to_user || '', row.name, row.id);

      if (newCategory !== row.category) {
        // V2.0: UUID 是纯流水号，分类变更只改 category 列，不动 UUID
        this.run('UPDATE nodes SET category = ? WHERE id = ?',
          [newCategory, row.id]);
        repaired++;
        if (this._verbose) {
          console.log(`[FamilyGraph] 分类修正: ${row.name} ${row.category}→${newCategory}`);
        }
      }
    }

    if (repaired > 0) {
      console.log(`[FamilyGraph] V3.2.1 分类复核: ${repaired} 个节点已修正`);
    }
  }

  /**
   * V3.3 户籍管理法 V1.1 列级补齐：
   * 新增 entity_source / status / legacy_ids / family_gene / social_group_genes
   * 存量迁移 + 双轮 BFS 分配基因码
   */
  migrateToV4(): void {
    // Step 1: 新增列（幂等）
    try { this.run('ALTER TABLE nodes ADD COLUMN entity_source TEXT DEFAULT "placeholder"'); } catch (e) { /* 列已存在 */ }
    try { this.run('ALTER TABLE nodes ADD COLUMN status TEXT DEFAULT "active"'); } catch (e) { /* 列已存在 */ }
    try { this.run('ALTER TABLE nodes ADD COLUMN legacy_ids TEXT DEFAULT "[]"'); } catch (e) { /* 列已存在 */ }
    try { this.run('ALTER TABLE nodes ADD COLUMN family_gene TEXT'); } catch (e) { /* 列已存在 */ }
    try { this.run('ALTER TABLE nodes ADD COLUMN social_group_genes TEXT DEFAULT "WW"'); } catch (e) { /* 列已存在 */ }

    // Step 2: entity_source 存量推断
    const needSource = this.query(
      "SELECT id, name, properties FROM nodes WHERE type = 'person' AND (entity_source IS NULL OR entity_source = '' OR entity_source = 'placeholder')"
    );
    let sourceFixed = 0;
    for (const row of needSource) {
      const props = JSON.parse(row.properties || '{}');
      const source = this._inferEntitySource(row.name, props.relation_to_user || '');
      this.run('UPDATE nodes SET entity_source = ? WHERE id = ?', [source, row.id]);
      sourceFixed++;
    }

    // Step 3: status 存量补齐
    this.run("UPDATE nodes SET status = 'active' WHERE type = 'person' AND (status IS NULL OR status = '')");

    // Step 4: legacy_ids 存量补齐
    this.run("UPDATE nodes SET legacy_ids = '[]' WHERE type = 'person' AND legacy_ids IS NULL");

    // Step 5: family_gene + social_group_genes → BFS 全量分配
    const rebuilt = this._rebuildGroupGenes();

    if (sourceFixed > 0 || rebuilt.familyGenes > 0 || rebuilt.socialGenes > 0) {
      console.log(`[FamilyGraph] V4 迁移: entity_source ${sourceFixed} + family_gene ${rebuilt.familyGenes}人/${rebuilt.familyClusters}族 + social_group ${rebuilt.socialGenes}人/${rebuilt.socialClusters}社`);
    }
    // V5: UUID去前缀 + name清洗 + 卷宗永久
    this._migrateToV5();
  }

  /**
   * V2.0 UUID 纯流水号迁移
   */
  private _migrateToV5(): void {
    // 全量重编号：按 created_at 排序，分配 TXS-000000001 ~ TXS-0000000XX
    const allP = this.query("SELECT id, uuid FROM nodes WHERE type = 'person' ORDER BY created_at");
    let seq = 0; let uuidChanged = 0;
    for (const r of allP) {
      seq++;
      const newUUID = `TXS-${String(seq).padStart(9, '0')}`;
      if (r.uuid !== newUUID) {
        // 旧 UUID → legacy_ids 归档
        let legacyIds: string[] = [];
        try {
          const cur = this.query("SELECT legacy_ids FROM nodes WHERE id = ?", [r.id]);
          legacyIds = JSON.parse((cur[0] as any)?.legacy_ids || '[]');
        } catch {}
        if (r.uuid && !r.uuid.startsWith('TXS-') && !legacyIds.includes(r.uuid)) {
          legacyIds.push(r.uuid);
        }
        this.run("UPDATE nodes SET uuid = ?, legacy_ids = ? WHERE id = ?",
          [newUUID, JSON.stringify(legacyIds), r.id]);
        uuidChanged++;
      }
    }

    if (uuidChanged > 0) {
      console.log(`[FamilyGraph] V5 迁移: UUID重编号${uuidChanged}人(共${seq}人)`);
    }
  }

  /** entity_source 存量推断 */
  private _inferEntitySource(name: string, relation: string): string {
    if (name === '玉瑶') return 'ai';
    if (name === '我') return 'ai';
    if (/^(同事|客户|老板|朋友|同学|经理|主管|工程师|前台|供应商|合作方)$/.test(name)) return 'placeholder';
    if (relation && /^(同事|下属|上司|老板|员工|领导|部属|搭档|助理|秘书|前台|主管|客户|合作|合伙|供应商|友商)/.test(relation) && !/母|父|妈|爸|哥|弟|姐|妹|儿|女|配偶|夫|妻|老公|老婆|伴侣|爱人/.test(relation)) {
      // 有职场/商业标签但无亲属标签 → real（现实同事）
      return 'real';
    }
    if (!relation || relation === '') return 'placeholder';
    return 'real';
  }

  /**
   * 双轮 BFS 全量重建 family_gene 和 social_group_genes
   * 返回统计信息
   */
  _rebuildGroupGenes(): { familyGenes: number; familyClusters: number; socialGenes: number; socialClusters: number } {
    const result = { familyGenes: 0, familyClusters: 0, socialGenes: 0, socialClusters: 0 };

    // ── Round 1: 家族血脉码 (FA) ──
    const allPersons = this.query("SELECT id, name FROM nodes WHERE type = 'person'") as Array<{ id: string; name: string }>;
    const visited = new Set<string>();
    const familyEdges = this.query(
      `SELECT source_id, target_id, relation FROM edges WHERE relation IN ('mother_of','father_of','child_of','sibling_of','spouse_of','parent_of','grandparent_of','grandchild_of','elder_sister_of','younger_sister_of','elder_brother_of','younger_brother_of','aunt_of','uncle_of','niece_of','nephew_of')`
    ) as Array<{ source_id: string; target_id: string; relation: string }>;

    // 建立无向邻接表
    const adj = new Map<string, Set<string>>();
    for (const e of familyEdges) {
      if (!adj.has(e.source_id)) adj.set(e.source_id, new Set());
      if (!adj.has(e.target_id)) adj.set(e.target_id, new Set());
      adj.get(e.source_id)!.add(e.target_id);
      adj.get(e.target_id)!.add(e.source_id);
    }

    let faSeq = 1;
    for (const p of allPersons) {
      if (visited.has(p.id)) continue;
      if (!adj.has(p.id)) continue; // 孤立的节点不分配 FA

      // BFS 找连通分量
      const component: string[] = [];
      const queue = [p.id];
      visited.add(p.id);
      while (queue.length > 0) {
        const cur = queue.shift()!;
        component.push(cur);
        const neighbors = adj.get(cur);
        if (neighbors) {
          for (const nb of neighbors) {
            if (!visited.has(nb)) {
              visited.add(nb);
              queue.push(nb);
            }
          }
        }
      }

      // 为该连通分量生成家族码
      const gene = `FA${String(faSeq).padStart(2, '0')}`;
      faSeq++;
      const ids = component.map(id => `'${id}'`).join(',');
      this.run(`UPDATE nodes SET family_gene = ? WHERE id IN (${ids})`, [gene]);
      result.familyGenes += component.length;
      result.familyClusters++;
    }

    // ── 清空 social_group_genes → 重新计算 ──
    this.run("UPDATE nodes SET social_group_genes = 'WW' WHERE type = 'person'");

    // ── Round 2: 社会社团码 ──
    const socialTypes = [
      { edges: ['colleague_of','boss_of','subordinate_of','partner_of'], prefix: 'CO' },
      { edges: ['classmate_of'], prefix: 'SC' },
      { edges: ['client_of','operated_by'], prefix: 'BU' },
    ];

    let globalSeq = 1;
    for (const st of socialTypes) {
      const sEdges = this.query(
        `SELECT source_id, target_id FROM edges WHERE relation IN (${st.edges.map(e => `'${e}'`).join(',')})`
      ) as Array<{ source_id: string; target_id: string }>;
      if (sEdges.length === 0) continue;

      const sAdj = new Map<string, Set<string>>();
      for (const e of sEdges) {
        if (!sAdj.has(e.source_id)) sAdj.set(e.source_id, new Set());
        if (!sAdj.has(e.target_id)) sAdj.set(e.target_id, new Set());
        sAdj.get(e.source_id)!.add(e.target_id);
        sAdj.get(e.target_id)!.add(e.source_id);
      }

      const sVisited = new Set<string>();
      for (const p of allPersons) {
        if (sVisited.has(p.id)) continue;
        if (!sAdj.has(p.id)) continue;

        const component: string[] = [];
        const queue = [p.id];
        sVisited.add(p.id);
        while (queue.length > 0) {
          const cur = queue.shift()!;
          component.push(cur);
          const neighbors = sAdj.get(cur);
          if (neighbors) {
            for (const nb of neighbors) {
              if (!sVisited.has(nb)) {
                sVisited.add(nb);
                queue.push(nb);
              }
            }
          }
        }

        const gene = `${st.prefix}${String(globalSeq).padStart(2, '0')}`;
        globalSeq++;
        for (const id of component) {
          // 追加到已有 social_group_genes（不覆盖）
          const current = this.query('SELECT social_group_genes FROM nodes WHERE id = ?', [id]);
          const curVal = (current[0]?.social_group_genes || 'WW');
          const newVal = curVal === 'WW' ? gene : `${curVal}|${gene}`;
          this.run('UPDATE nodes SET social_group_genes = ? WHERE id = ?', [newVal, id]);
        }
        result.socialGenes += component.length;
        result.socialClusters++;
      }
    }

    return result;
  }

  /**
   * 户籍分类推断 — 多源融合决策器
   *
   * 🔴 铁律：A-亲属 必须相对于"我"（用户）。不是我的亲属，一律不是 A。
   *      "徐诗雨的姑姑" → 相对于徐诗雨，不是我的姑姑 → 不是 A
   *      "妈妈" → 相对于我 → A
   *
   * 决策优先级（从高到低）：
   *   ① name === '我' → S（系统实体）
   *   ② edges 表：此人与"我"之间有家族边（mother_of 等）→ A
   *   ③ relation_to_user：直接亲属标签（不含他人名字的短标签）→ A
   *   ④ relation_to_user：社交标签 → B/D/E/F/C
   *   ⑤ 兜底 → G
   */
  private _inferCategory(relation: string, name: string, nodeId?: string): string {
    // ── 第零层: "我"自身 → S ──
    if (name === '我') return 'S';

    // ── 第一层: edges 表（最高权威——关系边是客观事实）──
    if (nodeId) {
      // 检查与"我"的家族边
      const familyEdges = this.query(
        `SELECT e.relation FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE ((n1.name = '我' AND n2.id = ?) OR (n1.id = ? AND n2.name = '我'))
           AND e.relation IN ('mother_of','father_of','spouse_of','sibling_of','child_of',
              'parent_of','grandparent_of','grandchild_of','elder_sister_of','younger_sister_of',
              'elder_brother_of','younger_brother_of','aunt_of','uncle_of','niece_of','nephew_of')
         LIMIT 1`,
        [nodeId, nodeId]
      );
      if (familyEdges.length > 0) return 'A';

      // 社交边 → 按边类型映射
      const socialEdges = this.query(
        `SELECT e.relation FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE ((n1.name = '我' AND n2.id = ?) OR (n1.id = ? AND n2.name = '我'))
           AND e.relation NOT IN ('acquaintance_of','认识的人','belongs_to','located_in','lives_in','residence_of')
         LIMIT 1`,
        [nodeId, nodeId]
      );
      if (socialEdges.length > 0) {
        const rel = socialEdges[0].relation as string;
        if (/colleague|boss|subordinate/.test(rel)) return 'B';
        if (/classmate|teacher|student/.test(rel)) return 'D';
        if (/client|partner/.test(rel)) return 'E';
        if (/friend|roommate|neighbor/.test(rel)) return 'C';
      }
    }

    // ── 第二层: relation_to_user 字符串 ──
    // 🔴 铁律：A 类不从此层产出。edges（Layer 1）是 A 的唯一入口。
    //      text 只能分出 X(情人) / B-F(社交) / G(陌生人)。
    if (relation) {
      // "/"复合标签 → 逐段判断（"伴侣/爱人" → 看 "伴侣" 和 "爱人"）
      const parts = relation.includes('/') ? relation.split('/').map((s: string) => s.trim()) : [relation.trim()];

      // ── X-情人: 浪漫/亲密伴侣关系（与 A-亲属严格区分）──
      if (parts.some((p: string) => /^(伴侣|爱人|情人|男朋友|女朋友|未婚夫|未婚妻|对象|亲爱的|宝贝)$/.test(p))) return 'X';

      // ── B-同事 ──
      if (/同事|下属|上司|老板|员工|领导|部属|搭档|助理|秘书|前台|主管/.test(relation)) return 'B';
      // ── D-同学 ──
      if (/同学|校友|老师|学生|导师|教授/.test(relation)) return 'D';
      // ── E-友商 ──
      if (/客户|合作|合伙|供应商|友商|乙方|甲方/.test(relation)) return 'E';
      // ── F-敌对 ──
      if (/敌|仇|对手|讨厌/.test(relation)) return 'F';
      // ── C-朋友 ──
      if (/朋友|闺蜜|知己|兄弟|好友|死党|发小|玩伴/.test(relation)) return 'C';
    }

    // ── 默认 G ──
    return 'G';
  }

  /** 获取所有 person 节点名称（缓存 30s） */
  private _allPersonNamesCache: { names: string[]; ts: number } | null = null;
  private _getAllPersonNames(): string[] {
    if (this._allPersonNamesCache && Date.now() - this._allPersonNamesCache.ts < 30000) {
      return this._allPersonNamesCache.names;
    }
    const rows = this.query("SELECT name FROM nodes WHERE type = 'person'") as Array<{ name: string }>;
    const names = rows.map(r => r.name);
    this._allPersonNamesCache = { names, ts: Date.now() };
    return names;
  }

  /** 格式化 UUID — V2.0 纯流水号 */
  private _formatUUID(_category: string, seq: number): string {
    return `TXS-${String(seq).padStart(9, '0')}`;
  }

  /** 生成下一个 TXS-ID（全局自增，不分类别） */
  _generateUUID(_category: string): string {
    const rows = this.query(
      "SELECT uuid FROM nodes WHERE type = 'person' AND uuid LIKE 'TXS-%'"
    );
    let maxSeq = 0;
    for (const row of rows) {
      const num = parseInt((row.uuid || '').replace('TXS-', ''), 10);
      if (!isNaN(num) && num > maxSeq) maxSeq = num;
    }
    return this._formatUUID('', maxSeq + 1);
  }

  /** 按 UUID 查找人物节点（兼容旧编号重定向） */
  getEntityByUUID(uuid: string): any | null {
    // 先精确匹配
    const rows = this.query('SELECT id, uuid, category, name, type, aliases, legacy_ids, properties FROM nodes WHERE uuid = ?', [uuid]);
    if (rows.length > 0) return rows[0];
    // 旧编号重定向 → 遍历 legacy_ids
    const legacyHits = this.query(
      "SELECT id, uuid, category, name, type, aliases, legacy_ids, properties FROM nodes WHERE type = 'person' AND legacy_ids IS NOT NULL AND legacy_ids != '[]'"
    );
    for (const row of legacyHits) {
      try {
        const ids = JSON.parse(row.legacy_ids || '[]');
        if (ids.includes(uuid)) return row;
      } catch {}
    }
    return null;
  }

  /** 按人名查 UUID */
  getUUIDByName(name: string): string | null {
    const node = this.findPersonNodeByNameOrAlias(name);
    if (!node) return null;
    return (node as any).uuid || null;
  }

  /** 获取全部分类统计 */
  getUUIDCategoryStats(): Record<string, number> {
    const rows = this.query("SELECT category, COUNT(*) as cnt FROM nodes WHERE type = 'person' AND category IS NOT NULL GROUP BY category") as Array<{ category: string; cnt: number }>;
    const stats: Record<string, number> = {};
    for (const row of rows) { stats[row.category] = row.cnt; }
    return stats;
  }

  async addNode(node: GraphNode): Promise<void> {
    const aliases = [...new Set((node.aliases ?? []).map((alias) => alias.trim()).filter(Boolean))];

    // V3.2: person 节点自动分配户籍 UUID
    let uuid: string | null = null;
    let category: string | null = null;
    if (node.type === 'person') {
      const existingUUID = this.getUUIDByName(node.name);
      if (existingUUID) {
        // 人名已存在 → 复用已有 UUID（合并场景）
        uuid = existingUUID;
        const existingNode = this.query('SELECT category FROM nodes WHERE uuid = ?', [existingUUID]);
        if (existingNode.length > 0) category = (existingNode[0] as any).category;
      } else {
        // 新人 → 多源推断分类并分配
        const props = (node.properties as any) || {};
        category = this._inferCategory(props.relation_to_user || '', node.name, node.id);
        uuid = this._generateUUID(category);
      }
    }

    // 🔴 V3.2 防重复: name 无 UNIQUE 约束，需要手动检查是否已存在
    if (node.type === 'person') {
      const existing = this.findPersonNodeByNameOrAlias(node.name);
      if (existing) {
        // 人名已存在 → UPDATE 而非 INSERT（合并属性，保护已有 UUID）
        const existingProps = JSON.parse(existing.properties || '{}');
        const mergedProps = { ...(node.properties ?? {}), ...existingProps, name: node.name };
        if (uuid) mergedProps._uuid = uuid;  // 保留新分配的 UUID 备查
        // 如果调用方的 node.id 与已存在的 id 不同，更新 id（防止后续 addEdge 引用无效 id）
        const targetId = (node.id !== existing.id) ? node.id : existing.id;
        if (node.id !== existing.id) {
          // 更新 edges 表中引用旧 id 的外键 → 新 id
          this.run('UPDATE edges SET source_id = ? WHERE source_id = ?', [node.id, existing.id]);
          this.run('UPDATE edges SET target_id = ? WHERE target_id = ?', [node.id, existing.id]);
          // 同步更新 userNodeId（如果指向"我"节点）
          if (this.userNodeId === existing.id) this.userNodeId = node.id;
        }
        this.run(
          'UPDATE nodes SET id = ?, aliases = ?, properties = ?, updated_at = ? WHERE id = ?',
          [targetId, JSON.stringify(aliases), JSON.stringify(mergedProps), new Date().toISOString(), existing.id]
        );
        this.markDirty(true);
        return;
      }
    }

    this.run(
      'INSERT OR IGNORE INTO nodes (id, type, name, aliases, properties, uuid, category, security_level, entity_source, status, legacy_ids, family_gene, social_group_genes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        node.id,
        node.type,
        node.name,
        JSON.stringify(aliases),
        JSON.stringify(node.properties ?? {}),
        uuid,
        category,
        1,  // V3.2: security_level 默认 1（公开级）
        (node.properties as any)?.entity_source || 'real',  // V3.3
        'active',   // V3.3: 新节点默认活跃
        '[]',       // V3.3: 新节点无历史 ID
        null,       // V3.3: family_gene 由 BFS 分配
        'WW',       // V3.3: 新节点默认自由人
        new Date().toISOString(),
        new Date().toISOString(),
      ]
    );
    this.markDirty(true);
  }

  async addEdge(edge: GraphEdge): Promise<void> {
    // 🔴 V3.3 自指边拦截: 禁止 source = target
    if (edge.source_id === edge.target_id) return;
    this.run(
      'INSERT OR IGNORE INTO edges (id, source_id, target_id, relation, properties, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        edge.id ?? uid(),
        edge.source_id,
        edge.target_id,
        edge.relation,
        JSON.stringify(edge.properties ?? {}),
        new Date().toISOString(),
        new Date().toISOString(),
      ]
    );
    // ── V3.3 基因码自动同步 ──
    this._syncGenesOnNewEdge(edge.source_id, edge.target_id, edge.relation);
    this.markDirty(true);
  }

  /** V3.3: 建边时自动同步 family_gene / social_group_genes */
  private _syncGenesOnNewEdge(sourceId: string, targetId: string, relation: string): void {
    const familyRelations = ['mother_of','father_of','child_of','sibling_of','spouse_of',
      'parent_of','grandparent_of','grandchild_of','elder_sister_of','younger_sister_of',
      'elder_brother_of','younger_brother_of','aunt_of','uncle_of','niece_of','nephew_of'];
    const socialRelations: Record<string, string> = {
      'colleague_of':'CO', 'boss_of':'CO', 'subordinate_of':'CO', 'partner_of':'CO',
      'classmate_of':'SC',
      'client_of':'BU', 'operated_by':'BU',
    };

    if (familyRelations.includes(relation)) {
      // 家族边 → 继承 family_gene
      const sGene = this.query('SELECT family_gene FROM nodes WHERE id = ?', [sourceId]);
      const tGene = this.query('SELECT family_gene FROM nodes WHERE id = ?', [targetId]);
      const gene = (sGene[0]?.family_gene) || (tGene[0]?.family_gene);
      if (gene) {
        this.run('UPDATE nodes SET family_gene = ? WHERE id = ? AND family_gene IS NULL', [gene, sourceId]);
        this.run('UPDATE nodes SET family_gene = ? WHERE id = ? AND family_gene IS NULL', [gene, targetId]);
      }
    }

    const socialPrefix = socialRelations[relation];
    if (socialPrefix) {
      // 社交边 → 追加 social_group_genes
      const existing = this.query(
        `SELECT id, social_group_genes FROM nodes WHERE (id = ? OR id = ?) AND social_group_genes IS NOT NULL AND social_group_genes != 'WW' AND social_group_genes LIKE ?`,
        [sourceId, targetId, `%${socialPrefix}%`]
      );
      if (existing.length === 0) {
        // 双方都没有该前缀的社团码 → 分配新码
        const maxSeq = this._getMaxSocialSeq(socialPrefix);
        const newGene = `${socialPrefix}${String(maxSeq + 1).padStart(2, '0')}`;
        for (const id of [sourceId, targetId]) {
          const cur = this.query('SELECT social_group_genes FROM nodes WHERE id = ?', [id]);
          const curVal = (cur[0]?.social_group_genes || 'WW');
          const newVal = curVal === 'WW' ? newGene : `${curVal}|${newGene}`;
          this.run('UPDATE nodes SET social_group_genes = ? WHERE id = ?', [newVal, id]);
        }
      }
    }
  }

  private _getMaxSocialSeq(prefix: string): number {
    const rows = this.query(
      "SELECT social_group_genes FROM nodes WHERE type = 'person' AND social_group_genes IS NOT NULL AND social_group_genes LIKE ?",
      [`%${prefix}%`]
    );
    let maxSeq = 0;
    for (const r of rows) {
      const genes = (r.social_group_genes || '').split('|');
      for (const g of genes) {
        if (g.startsWith(prefix)) {
          const num = parseInt(g.substring(2), 10);
          if (!isNaN(num) && num > maxSeq) maxSeq = num;
        }
      }
    }
    return maxSeq;
  }

  async findRelated(entityName: string, relation?: string): Promise<GraphQueryResult[]> {
    const results: GraphQueryResult[] = [];

    // 查找节点
    let sql = 'SELECT * FROM nodes WHERE name = ?';
    if (entityName.includes('%')) {
      sql = 'SELECT * FROM nodes WHERE name LIKE ?';
    }
    const nodes = this.query(sql, [entityName]);
    if (nodes.length === 0) return results;

    for (const node of nodes) {
      const relationships: GraphQueryResult['relationships'] = [];

      // 出边
      let edgeSql = 'SELECT e.*, n.id as nid, n.type as ntype, n.name as nname FROM edges e JOIN nodes n ON e.target_id = n.id WHERE e.source_id = ?';
      const params: string[] = [node.id];
      if (relation) {
        edgeSql += ' AND e.relation = ?';
        params.push(relation);
      }
      const outgoing = this.query(edgeSql, params);
      for (const e of outgoing) {
        relationships.push({
          relation: e.relation,
          direction: 'outgoing',
          targetNode: this.rowToNode(e),
        });
      }

      // 入边
      edgeSql = 'SELECT e.*, n.id as nid, n.type as ntype, n.name as nname FROM edges e JOIN nodes n ON e.source_id = n.id WHERE e.target_id = ?';
      const inParams: string[] = [node.id];
      if (relation) {
        edgeSql += ' AND e.relation = ?';
        inParams.push(relation);
      }
      const incoming = this.query(edgeSql, inParams);
      for (const e of incoming) {
        relationships.push({
          relation: e.relation,
          direction: 'incoming',
          targetNode: this.rowToNode(e),
        });
      }

      results.push({ node: this.rowToNode(node), relationships });
    }

    return results;
  }

  async findPath(sourceName: string, targetName: string): Promise<GraphPath | null> {
    // 简单 BFS（限于深度 ≤4）
    const sourceNodes = this.query('SELECT id FROM nodes WHERE name = ?', [sourceName]);
    const targetNodes = this.query('SELECT id FROM nodes WHERE name = ?', [targetName]);
    if (sourceNodes.length === 0 || targetNodes.length === 0) return null;

    const startId = sourceNodes[0].id;
    const endId = targetNodes[0].id;

    const visited = new Set<string>();
    const queue: Array<{ nodeId: string; path: GraphNode[]; edgePath: GraphEdge[] }> = [
      { nodeId: startId, path: [], edgePath: [] },
    ];
    visited.add(startId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.nodeId === endId) {
        return { nodes: current.path, edges: current.edgePath };
      }
      if (current.path.length >= 4) continue;

      const neighbors = this.query(
        `SELECT e.id as eid, e.relation, e.source_id, e.target_id, n.*
         FROM edges e JOIN nodes n ON (e.target_id = n.id OR e.source_id = n.id)
         WHERE (e.source_id = ? OR e.target_id = ?) AND n.id != ?`,
        [current.nodeId, current.nodeId, current.nodeId]
      );

      for (const nb of neighbors) {
        const nextId = nb.source_id === current.nodeId ? nb.target_id : nb.source_id;
        if (!visited.has(nextId)) {
          visited.add(nextId);
          queue.push({
            nodeId: nextId,
            path: [...current.path, this.rowToNode(nb)],
            edgePath: [
              ...current.edgePath,
              { id: nb.eid, source_id: nb.source_id, target_id: nb.target_id, relation: nb.relation },
            ],
          });
        }
      }
    }

    return null;
  }

  private findPersonNodeByNameOrAlias(name: string): any | null {
    const exact = this.query('SELECT id, name, aliases, properties FROM nodes WHERE name = ? AND type = ?', [name, 'person']);
    if (exact.length > 0) return exact[0];
    const aliasHit = this.query('SELECT id, name, aliases, properties FROM nodes WHERE type = ? AND aliases LIKE ?', ['person', `%"${name}"%`]);
    return aliasHit.length > 0 ? aliasHit[0] : null;
  }

  private async ensurePersonAliases(nodeId: string, aliases: string[]): Promise<void> {
    if (aliases.length === 0) return;
    const rows = this.query('SELECT aliases FROM nodes WHERE id = ?', [nodeId]);
    if (rows.length === 0) return;
    const existing = new Set(parseAliases(rows[0].aliases));
    let changed = false;
    for (const alias of aliases) {
      const normalized = alias.trim();
      if (!normalized || existing.has(normalized)) continue;
      existing.add(normalized);
      changed = true;
    }
    if (!changed) return;
    this.run('UPDATE nodes SET aliases = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify([...existing]),
      new Date().toISOString(),
      nodeId,
    ]);
    this.markDirty(true);
  }

  private dedupePendingItems(items: PendingItem[]): PendingItem[] {
    const deduped = new Map<string, PendingItem>();
    for (const item of items) {
      if (!item?.field || !item?.value) continue;
      const key = normalizePendingKey(item.field, item.value);
      const existing = deduped.get(key);
      if (!existing) {
        deduped.set(key, { ...item, occurrences: item.occurrences || 1 });
        continue;
      }
      const merged: PendingItem = {
        ...existing,
        ...item,
        confirmed: !!existing.confirmed || !!item.confirmed,
        occurrences: (existing.occurrences || 1) + (item.occurrences || 1),
      };
      if ((existing.timestamp || '') > (item.timestamp || '')) {
        merged.timestamp = existing.timestamp;
        merged.source = existing.source || item.source;
      } else {
        merged.timestamp = item.timestamp;
        merged.source = item.source || existing.source;
      }
      deduped.set(key, merged);
    }
    return [...deduped.values()].sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  }

  private ensureDossier(profile: Partial<PersonProfile>): PersonDossier {
    if (!profile.dossier) {
      profile.dossier = this.buildDossierFromFlat(profile, profile);
    }
    return profile.dossier;
  }

  private setIntersectionField(dossier: PersonDossier, key: 'metWhen' | 'workTogether' | 'lifeIntersection' | 'emotionalAssessment' | 'interestRelation', value: string): boolean {
    dossier.relationMap.intersections = dossier.relationMap.intersections || {};
    const current = dossier.relationMap.intersections[key];
    if (current && current !== value) return false;
    dossier.relationMap.intersections[key] = value;
    return true;
  }

  /**
   * V3.2 PAE: 通用 dossier 字段路径设置器
   * 将点分路径（如 "basicInfo.gender"、"health.lifestyle"）导航到 dossier 中并设置值。
   * 支持嵌套到 3 层深（如 "imageTraits.feminineDetails.firstImpression"）。
   */
  private _setNestedDossierField(dossier: PersonDossier, fieldPath: string, value: string): boolean {
    const parts = fieldPath.split('.');
    let target: any = dossier;

    // 导航到倒数第二层
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (!target[key] || typeof target[key] !== 'object') {
        target[key] = {};
      }
      target = target[key];
    }

    const lastKey = parts[parts.length - 1];

    // 特殊处理：数组类型字段（追加而非覆盖）
    if (['traits', 'interests', 'parents', 'children', 'siblings', 'colleagues', 'friends', 'clients'].includes(lastKey)) {
      if (!Array.isArray(target[lastKey])) target[lastKey] = [];
      const arr = target[lastKey] as string[];
      if (!arr.includes(value)) {
        arr.push(value);
        return true;
      }
      return false; // 已存在，不算 promoted
    }

    // 特殊处理：lifeMilestones 是对象数组，不通过此路径设置
    if (lastKey === 'lifeMilestones') {
      return false;
    }

    // 普通字段：无值或相同值时设置
    const current = target[lastKey];
    if (!current || current === value) {
      target[lastKey] = value;
      return true;
    }

    return false; // 有冲突，保留旧值
  }

  private promotePendingItems(profile: Partial<PersonProfile>): void {
    if (!profile.pendingItems || profile.pendingItems.length === 0) return;
    const keep: PendingItem[] = [];
    const dossier = this.ensureDossier(profile);

    for (const item of profile.pendingItems) {
      const occurrences = item.occurrences || 1;
      if (item.confirmed || occurrences < PENDING_PROMOTION_THRESHOLD) {
        keep.push(item);
        continue;
      }

      let promoted = false;
      switch (item.field) {
        case 'contact.workplace':
          if (!dossier.contact.workplace || dossier.contact.workplace === item.value) {
            dossier.contact.workplace = item.value;
            promoted = true;
          }
          break;
        case 'relationMap.relationToUser':
          if (!profile.relation_to_user || profile.relation_to_user === item.value) {
            profile.relation_to_user = item.value;
            dossier.relationMap.relationToUser = item.value;
            promoted = true;
          }
          break;
        case 'basicInfo.birthYear': {
          const year = Number.parseInt(item.value, 10);
          if (Number.isFinite(year) && (!dossier.basicInfo.birthYear || dossier.basicInfo.birthYear === year)) {
            dossier.basicInfo.birthYear = year;
            promoted = true;
          }
          break;
        }
        case 'contact.wechat':
          if (!dossier.contact.wechat || dossier.contact.wechat === item.value) {
            dossier.contact.wechat = item.value;
            promoted = true;
          }
          break;
        case 'health.condition':
          if (!dossier.health.condition || dossier.health.condition === item.value) {
            dossier.health.condition = item.value;
            promoted = true;
          }
          break;
        case 'relationMap.intersections.metWhen':
          promoted = this.setIntersectionField(dossier, 'metWhen', item.value);
          break;
        case 'relationMap.intersections.workTogether':
          promoted = this.setIntersectionField(dossier, 'workTogether', item.value);
          break;
        case 'relationMap.intersections.lifeIntersection':
          promoted = this.setIntersectionField(dossier, 'lifeIntersection', item.value);
          break;
        case 'relationMap.intersections.emotionalAssessment':
          promoted = this.setIntersectionField(dossier, 'emotionalAssessment', item.value);
          break;
        case 'relationMap.intersections.interestRelation':
          promoted = this.setIntersectionField(dossier, 'interestRelation', item.value);
          break;
        // ── V3.2 PAE 扩展：通用 dossier 子字段路径自动提升 ──
        // 不再列举每个字段，而是通过路径导航自动定位到 dossier 中的目标
        default:
          promoted = this._setNestedDossierField(dossier, item.field, item.value);
          break;
      }

      if (!promoted) keep.push(item);
    }

    profile.pendingItems = keep;
  }

  private extractNamedKinshipMentions(rawInput: string): Array<{ kinship: string; name: string }> {
    const mentions: Array<{ kinship: string; name: string }> = [];
    for (const kinship of KINSHIP_TERMS) {
      const match = rawInput.match(new RegExp(`我${kinship}叫([^，。！？\\s]{2,12})`));
      const candidate = match?.[1]?.trim();
      if (!candidate) continue;
      if (!validatePersonName(candidate)) continue;
      mentions.push({ kinship, name: candidate });
    }
    return mentions;
  }

  private mergePersonProfiles(targetName: string, targetRaw: any, sourceName: string, sourceRaw: any): Partial<PersonProfile> {
    const targetProfile: Partial<PersonProfile> = targetRaw?.properties ? JSON.parse(targetRaw.properties) : {};
    const sourceProfile: Partial<PersonProfile> = sourceRaw?.properties ? JSON.parse(sourceRaw.properties) : {};
    const merged: Partial<PersonProfile> = { ...sourceProfile, ...targetProfile };
    const sourceIsKinshipPlaceholder = KINSHIP_TERMS.includes(sourceName) && sourceName !== targetName;

    merged.name = targetName;
    merged.relation_to_user = isSpecificRelationLabel(targetProfile.relation_to_user)
      ? targetProfile.relation_to_user
      : isSpecificRelationLabel(sourceProfile.relation_to_user)
        ? sourceProfile.relation_to_user
        : targetProfile.relation_to_user || sourceProfile.relation_to_user || '';
    merged.first_mentioned = targetProfile.first_mentioned || (sourceIsKinshipPlaceholder ? undefined : sourceProfile.first_mentioned);
    merged.last_mentioned = targetProfile.last_mentioned || (sourceIsKinshipPlaceholder ? undefined : sourceProfile.last_mentioned) || new Date().toISOString();
    merged.mention_count = (targetProfile.mention_count || 0) + (sourceIsKinshipPlaceholder ? 0 : (sourceProfile.mention_count || 0));
    if (merged.dossier?.relationMap) {
      merged.dossier.relationMap.relationToUser = merged.relation_to_user || merged.dossier.relationMap.relationToUser || '';
    }
    return merged;
  }

  private async mergePersonNodes(targetName: string, sourceName: string, extraAliases: string[] = []): Promise<void> {
    if (targetName === sourceName) return;
    const targetNode = this.findPersonNodeByNameOrAlias(targetName);
    const sourceNode = this.findPersonNodeByNameOrAlias(sourceName);
    if (!targetNode || !sourceNode || targetNode.id === sourceNode.id) {
      if (targetNode) await this.ensurePersonAliases(targetNode.id, [sourceName, ...extraAliases].filter((alias) => alias !== targetName));
      return;
    }

    const targetAliases = parseAliases(targetNode.aliases);
    const sourceAliases = parseAliases(sourceNode.aliases);
    await this.ensurePersonAliases(targetNode.id, [sourceName, ...sourceAliases, ...targetAliases, ...extraAliases].filter((alias) => alias !== targetName));

    const mergedProfile = this.mergePersonProfiles(targetName, targetNode, sourceName, sourceNode);
    this.run('UPDATE nodes SET properties = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(mergedProfile),
      new Date().toISOString(),
      targetNode.id,
    ]);

    const sourceEdges = this.query('SELECT id, source_id, target_id, relation, properties FROM edges WHERE source_id = ? OR target_id = ?', [sourceNode.id, sourceNode.id]);
    for (const edge of sourceEdges) {
      const newSource = edge.source_id === sourceNode.id ? targetNode.id : edge.source_id;
      const newTarget = edge.target_id === sourceNode.id ? targetNode.id : edge.target_id;
      if (newSource === newTarget) {
        this.run('DELETE FROM edges WHERE id = ?', [edge.id]);
        continue;
      }
      const duplicate = this.query(
        'SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND relation = ? AND id != ?',
        [newSource, newTarget, edge.relation, edge.id]
      );
      if (duplicate.length > 0) {
        this.run('DELETE FROM edges WHERE id = ?', [edge.id]);
      } else {
        this.run('UPDATE edges SET source_id = ?, target_id = ?, updated_at = ? WHERE id = ?', [
          newSource,
          newTarget,
          new Date().toISOString(),
          edge.id,
        ]);
      }
    }

    this.run('DELETE FROM nodes WHERE id = ?', [sourceNode.id]);
    if (this.userNodeId === sourceNode.id) this.userNodeId = targetNode.id;
    this.markDirty(true);
  }

  async integrateFromEntity(entities: EntityGene[], rawInput: string, selfName?: string): Promise<InferenceResult> {
    const details: string[] = [];
    let nodesCreated = 0;
    let edgesCreated = 0;
    const userName = selfName ?? '我';

    // 确保用户节点存在
    const userNodes = this.query('SELECT id FROM nodes WHERE name = ?', [userName]);
    let userId: string;
    if (userNodes.length === 0) {
      userId = uid();
      await this.addNode({
        id: userId,
        type: 'person',
        name: userName,
        aliases: ['我', '我自己'],
      });
      nodesCreated++;
      details.push(`创建用户节点: ${userName}`);
    } else {
      userId = userNodes[0].id;
    }
    this.userNodeId = userId;

    // 扫描 entity_genes，检测亲属称谓 + 人名的组合
    const persons = entities.filter((e) => e.type === 'person');
    const places = entities.filter((e) => e.type === 'place');
    const namedKinship = new Map(this.extractNamedKinshipMentions(rawInput).map((item) => [item.kinship, item.name]));

    // 🔴 长辈称谓列表（说话者是晚辈，关系方向需反转）
    const SENIOR_KINSHIP = new Set(['妈妈','妈','母亲','爸爸','爸','父亲','爷爷','奶奶','外公','外婆','祖父','祖母']);

    for (const person of persons) {
      // 检查该人名是否在 kinship 词表中
      const kinshipWord = Object.keys(KINSHIP_MAP).find((kw) => rawInput.includes(kw));
      if (kinshipWord) {
        const relation = KINSHIP_MAP[kinshipWord];
        const isSenior = SENIOR_KINSHIP.has(kinshipWord);
        const canonicalName = namedKinship.get(kinshipWord) || person.name;
        const aliasCandidates = canonicalName === person.name ? [] : [...new Set([person.name, kinshipWord].filter(Boolean))];
        const relationLabel = SPECIFIC_KINSHIP_LABEL[kinshipWord] || this.describeRelation(relation);

        // 创建或查找该人名的节点
        const existing = this.findPersonNodeByNameOrAlias(canonicalName);
        let personId: string;
        if (!existing) {
          personId = uid();
          await this.addNode({
            id: personId,
            type: 'person',
            name: canonicalName,
            aliases: aliasCandidates,
          });
          nodesCreated++;
          details.push(`创建节点: ${canonicalName} (${kinshipWord})`);
        } else {
          personId = existing.id;
          await this.ensurePersonAliases(personId, aliasCandidates);
          if (canonicalName !== person.name) {
            await this.mergePersonNodes(canonicalName, person.name, [kinshipWord]);
            const merged = this.findPersonNodeByNameOrAlias(canonicalName);
            if (merged?.id) personId = merged.id;
          }
        }
        // 🏛️ §十四: 每次提及自动建立/丰富档案
        this.ensurePersonProfile(canonicalName);
        await this.updatePersonProfile(canonicalName, {} as any, { countMention: true });
        await this.updatePersonProfile(canonicalName, { relation_to_user: relationLabel } as any, { countMention: false });
        await this.extractProfileFromText(canonicalName, rawInput);

        // 长辈称谓反转方向：用户说"我妈妈"→ 妈妈--[mother_of]-->我 + 我--[child_of]-->妈妈
        // 而非 我--[mother_of]-->妈妈（那意味着我是妈妈的妈）
        const sourceId = isSenior ? personId : userId;
        const targetId = isSenior ? userId : personId;

        // 检查是否已有此边（防止重复）
        const existingEdge = this.query(
          'SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND relation = ?',
          [sourceId, targetId, relation]
        );
        if (existingEdge.length === 0) {
          await this.addEdge({
            id: uid(),
            source_id: sourceId,
            target_id: targetId,
            relation,
          });
          edgesCreated++;
          const fromName = isSenior ? canonicalName : userName;
          const toName = isSenior ? userName : canonicalName;
          details.push(`创建边: ${fromName} --${relation}--> ${toName}`);

          // 自动创建反向边
          const reverseRel = REVERSE_RELATION[relation];
          if (reverseRel && reverseRel !== relation) {
            const revSrc = isSenior ? userId : personId;
            const revTgt = isSenior ? personId : userId;
            const revEdge = this.query(
              'SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND relation = ?',
              [revSrc, revTgt, reverseRel]);
            if (revEdge.length === 0) {
              await this.addEdge({
                id: uid(),
                source_id: revSrc,
                target_id: revTgt,
                relation: reverseRel,
              });
              edgesCreated++;
              const revFrom = isSenior ? userName : canonicalName;
              const revTo = isSenior ? canonicalName : userName;
              details.push(`创建反向边: ${revFrom} --${reverseRel}--> ${revTo}`);
            }
          }
        } else {
          const existFrom = isSenior ? canonicalName : userName;
          const existTo = isSenior ? userName : canonicalName;
          details.push(`边已存在: ${existFrom} --${relation}--> ${existTo}`);
        }
      } else {
        // 非亲属人名 → 社交关系记录（所有人名都入库，不丢弃）
        const _ex = this.query('SELECT id FROM nodes WHERE name = ?', [person.name]);
        let _pid: string;
        if (_ex.length === 0) {
          _pid = uid();
          await this.addNode({ id: _pid, type: 'person', name: person.name });
          nodesCreated++;
          details.push('创建社交节点: ' + person.name);
        } else {
          _pid = _ex[0].id;
        }
        this.ensurePersonProfile(person.name);
        await this.updatePersonProfile(person.name, {} as any, { countMention: true });
        await this.extractProfileFromText(person.name, rawInput);
        const _ee = this.query('SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND relation = ?', [userId, _pid, 'acquaintance_of']);
        if (_ee.length === 0) {
          await this.addEdge({ id: uid(), source_id: userId, target_id: _pid, relation: 'acquaintance_of' });
          edgesCreated++;
          details.push('创建社交边: ' + userName + ' --acquaintance_of--> ' + person.name);
        }
      }
    }

    // 地点关联：如果提到家庭成员 + 地点 → 自动创建 lives_in
    if (persons.length > 0 && places.length > 0) {
      for (const place of places) {
        const pNodes = this.query('SELECT id FROM nodes WHERE name = ?', [place.name]);
        let placeId: string;
        if (pNodes.length === 0) {
          placeId = uid();
          await this.addNode({
            id: placeId,
            type: 'place',
            name: place.name,
          });
          nodesCreated++;
          details.push(`创建地点节点: ${place.name}`);
        } else {
          placeId = pNodes[0].id;
        }

        // 为用户和所有亲属创建 lives_in 边
        const allNodes = [userId, ...persons.map((p) => {
          const found = this.query('SELECT id FROM nodes WHERE name = ?', [p.name]);
          return found.length > 0 ? found[0].id : null;
        }).filter(Boolean)];

        for (const nid of allNodes) {
          if (!nid) continue;
          const exists = this.query(
            'SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND relation = ?',
            [nid, placeId, 'lives_in']
          );
          if (exists.length === 0) {
            await this.addEdge({ id: uid(), source_id: nid, target_id: placeId, relation: 'lives_in' });
            edgesCreated++;
            details.push(`创建边: lives_in --> ${place.name}`);
          }
        }
      }
    }

    return { nodes_created: nodesCreated, edges_created: edgesCreated, details };
  }

  async correctRelation(source: string, target: string, correctRelation: string): Promise<void> {
    // 查找旧边并删除
    const srcNodes = this.query('SELECT id FROM nodes WHERE name = ?', [source]);
    const tgtNodes = this.query('SELECT id FROM nodes WHERE name = ?', [target]);
    if (srcNodes.length === 0 || tgtNodes.length === 0) return;

    this.run('DELETE FROM edges WHERE source_id = ? AND target_id = ?', [srcNodes[0].id, tgtNodes[0].id]);
    this.run('DELETE FROM edges WHERE source_id = ? AND target_id = ?', [tgtNodes[0].id, srcNodes[0].id]);

    // 创建正确边
    await this.addEdge({
      id: uid(),
      source_id: srcNodes[0].id,
      target_id: tgtNodes[0].id,
      relation: correctRelation,
    });

    const reverse = REVERSE_RELATION[correctRelation];
    if (reverse && reverse !== correctRelation) {
      await this.addEdge({
        id: uid(),
        source_id: tgtNodes[0].id,
        target_id: srcNodes[0].id,
        relation: reverse,
      });
    }

    this.markDirty();

    // 🛡️ 备份仅在 initialize() 时执行，写操作不触发全量备份（户籍制度 §7.1）
    this._ensureSelfNode();
  }


  async addFamilyMember(name: string, relation: string, aliases?: string[]): Promise<void> {
    const selfName = this.userNodeId ?? '我';
    const uNodes = this.query('SELECT id FROM nodes WHERE name = ?', [selfName]);
    let userNodeId: string;
    if (uNodes.length === 0) {
      userNodeId = uid();
      await this.addNode({ id: userNodeId, type: 'person', name: selfName });
    } else {
      userNodeId = uNodes[0].id;
    }

    const pNodes = this.query('SELECT id FROM nodes WHERE name = ?', [name]);
    let personId: string;
    if (pNodes.length === 0) {
      personId = uid();
      await this.addNode({
        id: personId,
        type: 'person',
        name,
        aliases,
      });
    } else {
      personId = pNodes[0].id;
    }

    await this.addEdge({ id: uid(), source_id: userNodeId, target_id: personId, relation });
    const reverse = REVERSE_RELATION[relation];
    if (reverse && reverse !== relation) {
      await this.addEdge({ id: uid(), source_id: personId, target_id: userNodeId, relation: reverse });
    }
  }

  /**
   * 整合社交关系到图谱（与 integrateFromEntity 互补——它处理家族关系，这个处理社交关系）
   *
   * 当 chat.ts 中的 RelationshipExtractor 检测到非家庭人士时调用此方法。
   * 同一人可同时拥有家族边（妈妈）和社交边（同事）——两边不冲突。
   * 家族主线和社交副线彼此独立，但在同一张图中可交叉引用。
   */
  async integrateSocialRelation(personName: string, relationType: string, rawInput: string): Promise<InferenceResult> {
    const details: string[] = [];
    let nodesCreated = 0;
    let edgesCreated = 0;

    // 🔴 非人名过滤：2字名第二字不是姓氏的拒绝入库（"应该""时候""强度"等）
    const SURNAMES = new Set('赵孙李周吴郑王冯陈褚蒋沈韩杨朱秦许何吕施张孔曹严华金魏陶姜戚谢邹柏水窦章苏潘葛彭郎鲁韦马苗凤花方俞任袁柳鲍史费廉岑薛雷贺倪汤罗郝邬安乐于时傅卞齐康余元卜顾孟平和穆萧尹邵湛汪祁毛禹狄贝明臧计戴谈宋庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯管卢莫经房解应宗丁宣邓郁单杭洪包诸左石崔吉钮龚程嵇邢滑裴荣翁荀於惠甄家封羿储靳邴糜松段富乌焦巴弓牧谷车侯宓蓬全郗班仰仲伊宫宁仇甘厉戎符刘景詹束龙叶幸司韶黎薄印宿白蒲从鄂索赖卓蔺屠蒙池乔阴苍双闻莘党翟谭劳逄姬申扶冉宰郦雍郤濮牛寿通扈燕郏浦尚农别庄柴阎充慕茹习宦艾鱼容向古易慎戈廖庾衡步耿满弘匡寇广禄阙沃蔚越隆师巩厍聂晁敖融辛阚那简饶曾毋沙乜养鞠须丰巢关蒯相查荆红游竺逯盖桓公');
    const COMMON_WORDS = new Set(['应该','时候','强度','索引','关联','相遇','相似','职责','储所','全长','公了','公桌','和种','史摘','和事','那那','白衬','鲁呢','段美','衣块','单员','明天','谢你','谢了','包子','公司']);
    if (personName.length === 2) {
      if (COMMON_WORDS.has(personName)) {
        details.push(`过滤非人名: ${personName}`);
        return { nodes_created: 0, edges_created: 0, details };
      }
    }
    if (personName === '有人' || personName === '某人' || personName === '大家') {
      return { nodes_created: 0, edges_created: 0, details };
    }

    // 查找或创建"我"节点
    const userNodes = this.query('SELECT id FROM nodes WHERE name = ?', ['我']);
    let userId: string;
    if (userNodes.length === 0) {
      userId = uid();
      await this.addNode({ id: userId, type: 'person', name: '我', aliases: ['我', '我自己'] });
      nodesCreated++;
    } else {
      userId = userNodes[0].id;
    }
    this.userNodeId = userId;

    // 查找或创建该人的节点
    const existing = this.query('SELECT id FROM nodes WHERE name = ?', [personName]);
    let personId: string;
    if (existing.length === 0) {
      personId = uid();
      await this.addNode({ id: personId, type: 'person', name: personName });
      nodesCreated++;
      details.push(`创建社交节点: ${personName}`);
    } else {
      personId = existing[0].id;
    }
    await this.updatePersonProfile(personName, {} as any, { countMention: true });

    // 🔴 家族边拦截：如果此人已有家族关系边，跳过社交边（防止"老公"同时有 spouse_of 和 acquaintance_of）
    if (relationType === 'acquaintance_of') {
      const familyRelTypes = new Set(['mother_of','father_of','spouse_of','sibling_of','child_of','grandfather_of','grandmother_of','parent_of','grandchild_of']);
      const hasFamily = this.query(
        'SELECT id FROM edges WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)',
        [userId, personId, personId, userId]
      ).some((e: any) => familyRelTypes.has(e.relation));
      if (hasFamily) {
        details.push(`跳过社交边（已有家族关系）: ${personName}`);
        return { nodes_created: 0, edges_created: 0, details };
      }
    }

    // 检查是否已有此边（防止重复）
    const existingEdge = this.query(
      'SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND relation = ?',
      [userId, personId, relationType]
    );
    if (existingEdge.length === 0) {
      await this.addEdge({ id: uid(), source_id: userId, target_id: personId, relation: relationType });
      edgesCreated++;
      details.push(`创建社交边: 我 --${relationType}--> ${personName}`);

      // 自动创建反向边
      const reverseRel = SOCIAL_REVERSE[relationType] || 'acquaintance_of';
      if (reverseRel && reverseRel !== relationType) {
        const revEdge = this.query(
          'SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND relation = ?',
          [personId, userId, reverseRel]
        );
        if (revEdge.length === 0) {
          await this.addEdge({ id: uid(), source_id: personId, target_id: userId, relation: reverseRel });
          edgesCreated++;
          details.push(`创建反向社交边: ${personName} --${reverseRel}--> 我`);
        }
      }
    } else {
      details.push(`社交边已存在: 我 --${relationType}--> ${personName}`);
    }

    return { nodes_created: nodesCreated, edges_created: edgesCreated, details };
  }

  /**
   * 🔄 社交→家族升级：当一个人已存在于社交图谱（acquaintance_of 等社交边），
   * 但当前对话检测到家庭关系（如"熊勇是我表弟"→ 表弟=兄弟）时，
   * 添加家族边而不删除社交边（同一人可兼具双重身份——既是同事又是亲戚）。
   *
   * @param personName 人名
   * @param familyRelation 家族关系值（如 '兄弟', '配偶', '子女'）
   * @param context 上下文备注
   */
  async promoteSocialToFamily(personName: string, familyRelation: string, context?: string): Promise<void> {
    const KINSHIP_MAP_INTERNAL: Record<string, string> = {
      '配偶': 'spouse_of', '恋人': 'spouse_of',
      '父亲': 'father_of', '母亲': 'mother_of', '儿子': 'child_of', '女儿': 'child_of', '子女': 'child_of',
      '兄弟': 'sibling_of', '姐妹': 'sibling_of',
      '祖父': 'grandfather_of', '祖母': 'grandmother_of',
      '公婆': 'parent_of', '岳父母': 'parent_of',
    };
    const relation = KINSHIP_MAP_INTERNAL[familyRelation];
    if (!relation) return; // 不认识的关系类型，跳过

    // 获取"我"节点
    const meNodes = this.query('SELECT id FROM nodes WHERE name = ? AND type = ?', ['我', 'person']);
    if (meNodes.length === 0) return;
    const meId = meNodes[0].id;

    // 查找此人节点
    const personNodes = this.query('SELECT id FROM nodes WHERE name = ? AND type = ?', [personName, 'person']);
    if (personNodes.length === 0) {
      // 人不存在于图谱中 — 创建节点和家族边
      const pid = uid();
      await this.addNode({ id: pid, type: 'person', name: personName });
      await this.addEdge({ id: uid(), source_id: meId, target_id: pid, relation });
      const reverseRel = REVERSE_RELATION[relation];
      if (reverseRel && reverseRel !== relation) {
        await this.addEdge({ id: uid(), source_id: pid, target_id: meId, relation: reverseRel });
      }
      console.log("[FamilyPromote] 节点创建 [ok]"); // name sanitized
      return;
    }

    const personId = personNodes[0].id;

    // 检查是否已有此家族边
    const existingFamilyEdge = this.query(
      'SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND relation = ?',
      [meId, personId, relation]
    );
    if (existingFamilyEdge.length > 0) return; // 已有，无需升级

    // 检查是否已有类似的家族边（任意家族关系类型）
    const familyRelTypes = new Set(['mother_of', 'father_of', 'spouse_of', 'sibling_of', 'child_of', 'grandfather_of', 'grandmother_of', 'parent_of', 'grandchild_of']);
    const anyFamily = this.query(
      'SELECT id, relation FROM edges WHERE source_id = ? AND target_id = ?',
      [meId, personId]
    );
    const hasFamily = anyFamily.some((e: any) => familyRelTypes.has(e.relation));
    if (hasFamily) return; // 已有家族关系，无需重复

    // 添加家族边（保留社交边）
    await this.addEdge({ id: uid(), source_id: meId, target_id: personId, relation });
    const reverseRel = REVERSE_RELATION[relation];
    if (reverseRel && reverseRel !== relation) {
      await this.addEdge({ id: uid(), source_id: personId, target_id: meId, relation: reverseRel });
    }
    console.log("[FamilyPromote] 升级 [ok]"); // details sanitized
  }

  /**
   * 🔗 FIX-4: 添加两个第三方人物之间的直接关系边（非"我"相关的 person→person 边）
   * 例如: 熊梓铭 -child_of-> 熊勇, 王全芬 -spouse_of-> 熊勇
   *
   * @param srcName 源人物名
   * @param relation 关系类型（child_of / spouse_of / sibling_of 等）
   * @param tgtName 目标人物名
   * @param context 上下文（可选，存到节点 properties）
   */
  async addPersonRelation(srcName: string, relation: string, tgtName: string, context?: string): Promise<void> {
    // 查找或创建源节点
    const srcNodes = this.query('SELECT id FROM nodes WHERE name = ? AND type = ?', [srcName, 'person']);
    let srcId: string;
    if (srcNodes.length === 0) {
      srcId = uid();
      await this.addNode({ id: srcId, type: 'person', name: srcName });
      await this.updatePersonProfile(srcName, {} as any);
      console.log("[PersonRelation] 节点创建 [ok]"); // name sanitized
    } else {
      srcId = srcNodes[0].id;
    }

    // 查找或创建目标节点
    const tgtNodes = this.query('SELECT id FROM nodes WHERE name = ? AND type = ?', [tgtName, 'person']);
    let tgtId: string;
    if (tgtNodes.length === 0) {
      tgtId = uid();
      await this.addNode({ id: tgtId, type: 'person', name: tgtName });
      await this.updatePersonProfile(tgtName, {} as any);
      console.log("[PersonRelation] 节点创建 [ok]"); // name sanitized
    } else {
      tgtId = tgtNodes[0].id;
    }

    // 检查正向边是否已存在
    const existingEdge = this.query(
      'SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND relation = ?',
      [srcId, tgtId, relation]
    );
    if (existingEdge.length > 0) {
      console.log("[PersonRelation] 边已存在 [skip]"); // details sanitized
      return;
    }

    // 创建正向边
    await this.addEdge({ id: uid(), source_id: srcId, target_id: tgtId, relation });
    console.log("[PersonRelation] 边创建 [ok]"); // details sanitized

    // 自动创建反向边
    const reverseRel = REVERSE_RELATION[relation];
    if (reverseRel && reverseRel !== relation) {
      const revEdge = this.query(
        'SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND relation = ?',
        [tgtId, srcId, reverseRel]
      );
      if (revEdge.length === 0) {
        await this.addEdge({ id: uid(), source_id: tgtId, target_id: srcId, relation: reverseRel });
        console.log("[PersonRelation] 反向边创建 [ok]"); // details sanitized
      }
    }

    // 更新人物画像中的 relation_to_user
    switch (relation) {
      case 'child_of':
        await this.updatePersonProfile(srcName, { relation_to_user: `${tgtName}的孩子` } as any);
        await this.updatePersonProfile(tgtName, { relation_to_user: `${srcName}的家长` } as any);
        break;
      case 'parent_of':
        await this.updatePersonProfile(srcName, { relation_to_user: `${tgtName}的家长` } as any);
        await this.updatePersonProfile(tgtName, { relation_to_user: `${srcName}的孩子` } as any);
        break;
      case 'spouse_of':
        await this.updatePersonProfile(srcName, { relation_to_user: `${tgtName}的配偶` } as any);
        await this.updatePersonProfile(tgtName, { relation_to_user: `${srcName}的配偶` } as any);
        break;
      case 'sibling_of':
        await this.updatePersonProfile(srcName, { relation_to_user: `${tgtName}的兄弟姐妹` } as any);
        await this.updatePersonProfile(tgtName, { relation_to_user: `${srcName}的兄弟姐妹` } as any);
        break;
    }
  }

  /**
   * 获取社交关系摘要（与 getFamilySummary 互补，只返回非家庭关系）
   * 同一人若同时有家族边和社交边，在两个摘要中都会出现。
   */
  /** 更新人物节点的备注信息（从知识库合并时调用） */
  async updateNodeProperties(personName: string, props: Record<string, any>): Promise<void> {
    const nodes = this.query('SELECT id, properties FROM nodes WHERE name = ? AND type = ?', [personName, 'person']);
    if (nodes.length === 0) return;
    const existingProps = JSON.parse(nodes[0].properties ?? '{}');
    const merged = { ...existingProps, ...props };
    this.run('UPDATE nodes SET properties = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(merged), new Date().toISOString(), nodes[0].id]);
    this.markDirty();

    // 🛡️ 备份仅在 initialize() 时执行，写操作不触发全量备份（户籍制度 §7.1）
    this._ensureSelfNode();
  }

  async getSocialSummary(): Promise<{ connections: Array<{ name: string; relation_to_user: string; note?: string }> }> {
    // P1: 30s TTL 缓存
    const _now = Date.now();
    if (this._socialCache && _now - this._socialCache.ts < this.CACHE_TTL) {
      return this._socialCache.data;
    }
    const connections: Array<{ name: string; relation_to_user: string; note?: string }> = [];
    const meNodes = this.query('SELECT id FROM nodes WHERE name = ? AND type = ?', ['我', 'person']);
    if (meNodes.length === 0) return { connections };
    const meId = meNodes[0].id;

    const nodes = this.query('SELECT * FROM nodes');
    const socialTypes = new Set([...Object.values(SOCIAL_MAP), 'acquaintance_of']);

    for (const node of nodes) {
      if (node.type === 'person' && node.name !== '我') {
        const edges = this.query(
          `SELECT e.relation FROM edges e WHERE (e.source_id = ? AND e.target_id = ?) OR (e.source_id = ? AND e.target_id = ?)`,
          [node.id, meId, meId, node.id]
        );
        for (const edge of edges) {
          if (socialTypes.has(edge.relation)) {
            const props = node.properties ? JSON.parse(node.properties) : {};
            connections.push({
              name: node.name,
              relation_to_user: this.describeSocialRelation(edge.relation),
              note: props.备注 || props.context || undefined,
            });
            break;
          }
        }
      }
    }
    const _result = { connections };
    this._socialCache = { data: _result, ts: Date.now() };
    return _result;
  }

  private _familyCache: { data: FamilySummary; ts: number } | null = null;
  private _socialCache: { data: { connections: Array<{ name: string; relation_to_user: string; note?: string }> }; ts: number } | null = null;
  private readonly CACHE_TTL = 30_000;

  async getFamilySummary(): Promise<FamilySummary> {
    const now = Date.now();
    if (this._familyCache && now - this._familyCache.ts < this.CACHE_TTL) {
      return this._familyCache.data;
    }
    const members: FamilySummary['members'] = [];
    const locations = new Set<string>();

    // 实时查询"我"节点，不依赖缓存的 userNodeId
    const meNodes = this.query('SELECT id FROM nodes WHERE name = ? AND type = ?', ['我', 'person']);
    if (meNodes.length === 0) return { members: [], locations: [] };
    const meId = meNodes[0].id;

    // 家族关系类型（不包括 acquaintance_of 等社交关系）
    const familyRels = new Set(['mother_of','father_of','spouse_of','sibling_of','grandfather_of','grandmother_of','child_of','grandchild_of','parent_of']);

    const nodes = this.query('SELECT * FROM nodes');
    for (const node of nodes) {
      if (node.type === 'person' && node.name !== '我') {
        // 查找该人与"我"的关系
        const edges = this.query(
          `SELECT e.relation FROM edges e WHERE (e.source_id = ? AND e.target_id = ?) OR (e.source_id = ? AND e.target_id = ?)`,
          [node.id, meId, meId, node.id]
        );
        // 只保留有家族关系边的人（排除纯社交联系人）
        const familyEdge = edges.find(e => familyRels.has(e.relation));
        if (!familyEdge) continue;
        const profile = this.getPersonProfile(node.name);
        members.push({
          name: node.name,
          relation_to_user: profile?.relation_to_user || this.describeRelation(familyEdge.relation),
          aliases: parseAliases(node.aliases),
        });
      }
      if (node.type === 'place') {
        locations.add(node.name);
      }
    }

    const result = { members, locations: [...locations] };
    this._familyCache = { data: result, ts: Date.now() };
    return result;
  }

  // ─── 辅助方法 ───

  /** 社交关系 → 中文描述 */
  private describeSocialRelation(rel: string): string {
    const map: Record<string, string> = {
      colleague_of: '同事', classmate_of: '同学', roommate_of: '室友',
      boss_of: '老板/上级', subordinate_of: '下属/部下',
      client_of: '客户', friend_of: '朋友', partner_of: '合伙人',
      neighbor_of: '邻居', teacher_of: '老师', student_of: '学生',
      doctor_of: '医生', consultant_of: '顾问',
      server_of: '服务方', acquaintance_of: '认识的人',
    };
    return map[rel] ?? rel;
  }

  private describeRelation(rel: string): string {
    const map: Record<string, string> = {
      mother_of: '母亲', father_of: '父亲',
      spouse_of: '配偶', sibling_of: '兄弟姐妹',
      child_of: '子女', grandfather_of: '爷爷', grandmother_of: '奶奶',
      grandchild_of: '孙辈', parent_of: '父母',
      lives_in: '居住在', close_to: '亲密',
    };
    return map[rel] ?? rel;
  }

  private run(sql: string, params?: unknown[]): void {
    if (!this.db) throw new Error('FamilyGraph not initialized. Call initialize() first.');
    this.db.run(sql, params);
  }

  private query(sql: string, params?: unknown[]): any[] {
    if (!this.db) throw new Error('FamilyGraph not initialized. Call initialize() first.');
    const stmt = this.db.prepare(sql);
    if (params) stmt.bind(params);
    const results: any[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  }

  /** 标记脏数据（500ms聚合落盘，平衡IO与可靠性） */
  private markDirty(immediate = false): void {
    this._dirty = true;
    this._familyCache = null;
    this._socialCache = null;
    if (immediate) { this.flush(); return; }
    if (!this._saveTimer) {
      this._saveTimer = setTimeout(() => this.flush(), 500);
    }
  }

  /** P4: 强制立即落盘 */
  private flush(): void {
    if (!this._dirty || !this.db) return;
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      writeFileSync(this.dbPath, buffer);
      this._dirty = false;
    } catch (err) {
      console.error('[FamilyGraph] 落盘失败:', err);
    }
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
  }

  /** 关闭数据库连接，释放 WASM 内存。调用后此实例不可再用。 */
  close(): void {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (this._dirty && this.db) {
      try {
        const data = this.db.export();
        writeFileSync(this.dbPath, Buffer.from(data));
      } catch (err) { console.error('[FamilyGraph] 关闭前落盘失败:', err); }
    }
    if (this.db) { this.db.close(); this.db = undefined as any; }
    this.ready = false;
  }

  /** P4: 显式触发落盘（关闭前调用） */
  async flushAll(): Promise<void> {
    this.flush();
  }

  // ═══════════════════════════════════════════════════
  //  🏛️ 时间感知引擎（§十三）
  // ═══════════════════════════════════════════════════

  /**
   * 🏛️ §十三: 根据出生年份计算当前年龄
   * 年龄永远不硬编码——从 birthYear 实时计算。
   * 首次调用时如果只有硬编码 age，自动回填 birthYear。
   */
  getCalculatedAge(personName: string): { age: number | null; birthYear: number | null; isCalculated: boolean; asOf: string } {
    const node = this.findPersonNodeByNameOrAlias(personName);
    if (!node) return { age: null, birthYear: null, isCalculated: false, asOf: new Date().toISOString() };
    const props = JSON.parse(node.properties || '{}');
    const asOf = new Date().toISOString();
    const birthYear = props.birthYear || props.dossier?.basicInfo?.birthYear || null;

    if (birthYear) {
      const by = parseInt(String(birthYear), 10);
      if (isNaN(by)) return { age: null, birthYear: null, isCalculated: false, asOf };
      return { age: new Date().getFullYear() - by, birthYear: by, isCalculated: true, asOf };
    }

    // 降级: 有硬编码 age 但无 birthYear → 自动推算并回填
    const hardAge = props.age;
    if (hardAge !== undefined && hardAge !== null) {
      const estimatedBY = new Date().getFullYear() - parseInt(String(hardAge), 10);
      props.birthYear = estimatedBY;
      if (!props.dossier) props.dossier = {};
      if (!props.dossier.basicInfo) props.dossier.basicInfo = {};
      props.dossier.basicInfo.birthYear = estimatedBY;
      this.run('UPDATE nodes SET properties=? WHERE id=?', [JSON.stringify(props), node.id]);
      console.log(`[FamilyGraph] 年龄→出生年: ${personName} age=${hardAge} → birthYear=${estimatedBY}`);
      return { age: parseInt(String(hardAge), 10), birthYear: estimatedBY, isCalculated: false, asOf };
    }
    return { age: null, birthYear: null, isCalculated: false, asOf };
  }

  /**
   * 🏛️ 记录档案字段变更历史（时间向量）
   */
  addProfileChange(personName: string, field: string, oldValue: any, newValue: any): void {
    const node = this.findPersonNodeByNameOrAlias(personName);
    if (!node) return;
    const props = JSON.parse(node.properties || '{}');
    const now = new Date().toISOString();
    if (!props._changeHistory) props._changeHistory = [];
    props._changeHistory.push({ field, oldValue, newValue, timestamp: now });
    // V2.0: 卷宗永久存档 — 主表保留10000条，超出自动归档（保留全部记录不删除）
    if (props._changeHistory.length > 10000) props._changeHistory = props._changeHistory.slice(-10000);
    this.run('UPDATE nodes SET properties=? WHERE id=?', [JSON.stringify(props), node.id]);
  }

  /** 🏛️ 获取档案变更时间线 */
  getProfileTimeline(personName: string): Array<{ field: string; oldValue: any; newValue: any; timestamp: string }> {
    const node = this.findPersonNodeByNameOrAlias(personName);
    if (!node) return [];
    return (JSON.parse(node.properties || '{}'))._changeHistory || [];
  }

  /**
   * 🏛️ 设置关系边的"已知自"时间锚点
   */
  setEdgeTimeAnchor(srcName: string, tgtName: string, relation: string, knownSince?: string): void {
    const s = this._findPersonIds(srcName), t = this._findPersonIds(tgtName);
    if (!s.length || !t.length) return;
    const since = knownSince || new Date().toISOString();
    this.run("UPDATE edges SET properties=? WHERE source_id=? AND target_id=? AND relation=?",
      [JSON.stringify({ known_since: since, ...JSON.parse((this.query(
        "SELECT properties FROM edges WHERE source_id=? AND target_id=? AND relation=?",
        [s[0], t[0], relation])[0]?.properties || '{}')) }), s[0], t[0], relation]);
  }

  /** 🏛️ 获取关系已建立天数 */
  getEdgeAgeDays(srcName: string, tgtName: string, relation: string): number | null {
    const s = this._findPersonIds(srcName), t = this._findPersonIds(tgtName);
    if (!s.length || !t.length) return null;
    const rows = this.query(
      "SELECT properties, created_at FROM edges WHERE source_id=? AND target_id=? AND relation=?",
      [s[0], t[0], relation]);
    if (!rows.length) return null;
    try {
      const since = JSON.parse(rows[0].properties || '{}').known_since || rows[0].created_at;
      return since ? Math.floor((Date.now() - new Date(since).getTime()) / 86400000) : null;
    } catch { return null; }
  }

  // ── P1: 人物画像 ──

  /**
   * 获取人物画像
   */
  getPersonProfile(personName: string): PersonProfile | null {
    const node = this.findPersonNodeByNameOrAlias(personName);
    if (!node) return null;
    const props: Partial<PersonProfile> = node.properties ? JSON.parse(node.properties) : {};
    const result = {
      name: node.name,
      relation_to_user: '',
      last_mentioned: '',
      mention_count: 0,
      ...props,
    } as PersonProfile;
    // 🔴 FG真人标记: relation_to_user 非空则不可扮演
    // V3.2.1 调试模式: DEBUG_UNLOCK_ALL=true 时全部放行（无需重启，修改此标志后重启即可）
    (result as any).roleplay_forbidden = FamilyGraph.DEBUG_UNLOCK_ALL ? false : !!(result.relation_to_user && result.relation_to_user !== '' && result.relation_to_user !== '无' && !result.relation_to_user.includes('虚构') && !result.relation_to_user.includes('扮演'));
    // 📜 信息权威铁律 · 等级S: 记录age字段是否有效
    if (result.age !== undefined && result.age !== null) {
      if(this._verbose)console.log('[FG:S] getPersonProfile(' + personName + '→' + node.name + ') age=' + result.age + ' (SOURCE: nodes.properties)');
    } else {
      if(this._verbose)console.log('[FG:S] getPersonProfile(' + personName + '→' + node.name + ') age=MISSING');
    }
    // ── V3.3 状态自动降级: 根据 last_mentioned 自动调整 status ──
    this._checkStatusDowngrade(node, result);
    return result;
  }

  /** V3.3: 根据 last_mentioned 时间自动降级实体状态 */
  private _checkStatusDowngrade(node: any, profile: PersonProfile): void {
    try {
      const currentStatus = (node as any).status || 'active';
      if (currentStatus === 'deceased') return; // 注销状态不可逆
      if (currentStatus === 'archived') return; // 封存状态仅手动恢复

      const lastMentioned = profile.last_mentioned;
      if (!lastMentioned) return;

      const daysSince = (Date.now() - new Date(lastMentioned).getTime()) / 86400_000;

      if (currentStatus === 'active' && daysSince > 90) {
        this.run('UPDATE nodes SET status = ? WHERE id = ?', ['dormant', node.id]);
      } else if (currentStatus === 'dormant' && daysSince > 365) {
        this.run('UPDATE nodes SET status = ? WHERE id = ?', ['archived', node.id]);
      } else if (currentStatus === 'dormant' && daysSince < 90) {
        // 最近被提及 → 恢复 active
        this.run('UPDATE nodes SET status = ? WHERE id = ?', ['active', node.id]);
      }
    } catch { /* 状态更新失败不影响读取 */ }
  }

  /**
   * V3.2.1 调试模式: 全部限制解锁
   * true  = roleplay_forbidden 始终 false、circle_level/security_level 全部开放
   * false = 正常运行（调试完成后恢复）
   */
  static DEBUG_UNLOCK_ALL = true;

  /**
   * SP2-3: 反义词冲突检测对
   * v1.1: 扩充覆盖外貌/性格/职业/关系四大类
   */
  private static CONFLICT_PAIRS: Array<[RegExp, RegExp]> = [
    // 外貌类
    [/高(?!中)/, /矮/], [/瘦/, /胖/], [/长发/, /短发/], [/大胸|丰满/, /平胸|飞机场|贫乳/],
    [/白/, /黑/], [/大眼睛/, /小眼睛/], [/瓜子脸|圆脸/, /方脸|长脸/], [/双眼皮/, /单眼皮/],
    [/长发/, /短发/], [/卷发/, /直发/], [/戴眼镜/, /不戴眼镜/],
    // 性格类（v1.1 新增）
    [/外向|开朗|活泼/, /内向|安静|腼腆/], [/急脾气|暴躁/, /温和|慢性子|温柔/],
    [/大方/, /小气|抠门/], [/勤快|勤奋|勤劳/, /懒|懒惰|懒散/],
    [/乐观/, /悲观|消极/], [/细心|细致/, /粗心|马虎|大大咧咧/],
    // 职业类（v1.1 新增）
    [/创业|老板|ceo|创始人|总经理/, /员工|打工|上班族|基层/],
    [/全职/, /兼职|临时/],
    // 关系类（v1.1 新增）
    [/已婚|有家室/, /未婚|单身/], [/有孩子|有小孩/, /没孩子|丁克/],
    [/本地人/, /外地人/],
    // 🏛️ §11.6: 年龄/身高/职业跨级冲突（V2.2 新增）
    [/\b1[4-9]\b/, /\b2[5-9]\b/],                         // 14-19 vs 25-29
    [/\b1\.[5-6]\d\b/, /\b1\.[7-8]\d\b/],                 // 矮(1.5-1.6) vs 高(1.7-1.8)
    [/同事/, /家人|亲属|亲戚/],                              // 同事 vs 家人
  ];

  /**
   * 更新或创建人物画像
   *
   * SP2-3: 新增冲突检测 — 检测到关键字段矛盾时保留双版本+标记冲突
   * v1.1: 支持 dossier 6 模块结构化更新 + pending 待确认机制
   */
  async updatePersonProfile(personName: string, updates: Partial<PersonProfile>, options?: UpdatePersonProfileOptions): Promise<void> {
    const node = this.findPersonNodeByNameOrAlias(personName);
    if (!node) return;

    const existing: Partial<PersonProfile> = node.properties ? JSON.parse(node.properties) : {};
    const shouldCountMention = options?.countMention ?? !Object.prototype.hasOwnProperty.call(updates, 'mention_count');
    const nextMentionCount = typeof updates.mention_count === 'number'
      ? updates.mention_count
      : (existing.mention_count || 0) + (shouldCountMention ? 1 : 0);
    const merged: PersonProfile = {
      name: node.name,
      relation_to_user: existing.relation_to_user || '',
      last_mentioned: new Date().toISOString(),
      mention_count: nextMentionCount,
      ...existing,
      ...updates,
    };
    merged.mention_count = nextMentionCount;

    if (merged.appearance && isInvalidProfileSnippet(merged.appearance)) {
      delete merged.appearance;
    }
    if (merged.occupation && (isInvalidProfileSnippet(merged.occupation) || isLikelyPlaceName(merged.occupation))) {
      delete merged.occupation;
    }
    if (merged.pendingItems) {
      merged.pendingItems = this.dedupePendingItems(merged.pendingItems.filter((item) => {
        if (!item?.value) return false;
        if (item.field === 'appearance' && isInvalidProfileSnippet(item.value)) return false;
        if (item.field === 'contact.workplace' && isInvalidProfileSnippet(item.value)) return false;
        return true;
      }));
    }

    // SP2-3: 冲突检测 — 检查关键描述字段矛盾
    const _conflictFields = ['age', 'appearance', 'body_features', 'description', 'occupation', 'relation_to_user'];
    const _existingConflicts: Array<{ field: string; oldValue: string; newValue: string; timestamp: string }> = (existing as any).conflicts || [];
    for (const field of _conflictFields) {
      const oldVal = (existing as any)[field] || '';
      const newVal = (updates as any)[field] || '';
      if (oldVal && newVal && oldVal !== newVal) {
        const hasConflict = FamilyGraph.CONFLICT_PAIRS.some(([a, b]) => a.test(oldVal) && b.test(newVal));
        if (hasConflict) {
          _existingConflicts.push({ field, oldValue: oldVal, newValue: newVal, timestamp: new Date().toISOString() });
          (merged as any)[field] = oldVal;
          (merged as any).conflicts = _existingConflicts;
          (merged as any).conflict = true;
          if(this._verbose)console.log('[FamilyGraph] 冲突检测: ' + personName + ' ' + field + ' (' + oldVal + ' vs ' + newVal + ')');
        }
      }
    }

    // ── dossier 升级: 存量 flat 字段同步到 dossier ──
    if (!merged.dossier) {
      merged.dossier = this.buildDossierFromFlat(merged, existing as any);
    }
    this.promotePendingItems(merged);
    // 如有新的 flat 字段更新，同步到 dossier
    if (updates.appearance && merged.dossier.imageTraits) {
      merged.dossier.imageTraits.looks = merged.dossier.imageTraits.looks || updates.appearance;
    }
    if (updates.body_features && merged.dossier.imageTraits) {
      merged.dossier.imageTraits.bodyFeatures = merged.dossier.imageTraits.bodyFeatures || updates.body_features;
    }
    if (updates.style && merged.dossier.imageTraits) {
      merged.dossier.imageTraits.style = merged.dossier.imageTraits.style || updates.style;
    }
    if (updates.voice && merged.dossier.imageTraits) {
      merged.dossier.imageTraits.voice = merged.dossier.imageTraits.voice || updates.voice;
    }
    if (updates.traits && merged.dossier.personalityPrefs) {
      for (const t of updates.traits) {
        if (!merged.dossier.personalityPrefs.traits.includes(t)) {
          merged.dossier.personalityPrefs.traits.push(t);
        }
      }
    }
    if (updates.interests && merged.dossier.personalityPrefs) {
      for (const t of updates.interests) {
        if (!merged.dossier.personalityPrefs.interests.includes(t)) {
          merged.dossier.personalityPrefs.interests.push(t);
        }
      }
    }
    if (updates.relation_to_user && merged.dossier.relationMap) {
      merged.dossier.relationMap.relationToUser = updates.relation_to_user;
    }

    merged.completeness = this.calcProfileCompleteness(merged);

    // 🏛️ §十三: 记录字段变更到时间向量
    for (const field of Object.keys(updates)) {
      if (field === 'mention_count' || field === 'last_mentioned' || field === 'completeness') continue;
      const oldVal = (existing as any)[field];
      const newVal = (updates as any)[field];
      if (oldVal !== undefined && newVal !== undefined && JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        if (!merged._changeHistory) merged._changeHistory = [];
        merged._changeHistory.push({ field, oldValue: oldVal, newValue: newVal, timestamp: new Date().toISOString() });
        if (merged._changeHistory.length > 10000) merged._changeHistory = merged._changeHistory.slice(-10000);
      }
    }

    this.run('UPDATE nodes SET properties = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(merged), new Date().toISOString(), node.id]);
    this.markDirty(true);
  }

  /**
   * 🏛️ PAE 档案采集引擎专用：直接写入 dossier 子字段
   * 绕过 flat→dossier 同步，直接操作结构化档案的任意字段路径。
   *
   * @param personName - 人物名
   * @param fieldPath - 字段路径，如 "basicInfo.gender"、"health.condition"
   * @param value - 要写入的值
   */
  async setDossierField(personName: string, fieldPath: string, value: any): Promise<void> {
    const node = this.findPersonNodeByNameOrAlias(personName);
    if (!node) return;

    const props = JSON.parse(node.properties || '{}');
    if (!props.dossier) {
      props.dossier = this.buildDossierFromFlat(props, props);
    }

    const dossier = props.dossier;
    const parts = fieldPath.split('.');
    let target: any = dossier;

    // 按路径导航到目标位置，中间缺失的对象自动创建
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (!target[key] || typeof target[key] !== 'object') {
        target[key] = {};
      }
      target = target[key];
    }

    const lastKey = parts[parts.length - 1];
    const oldValue = JSON.stringify(target[lastKey] ?? null);
    const newValueStr = JSON.stringify(value);

    // 值未变化则跳过
    if (oldValue === newValueStr) return;

    target[lastKey] = value;

    // 记录变更历史
    if (!props._changeHistory) props._changeHistory = [];
    props._changeHistory.push({
      field: `dossier.${fieldPath}`,
      oldValue: target[lastKey] !== undefined ? oldValue : null,
      newValue: value,
      timestamp: new Date().toISOString(),
    });
    if (props._changeHistory.length > 10000) props._changeHistory = props._changeHistory.slice(-10000);

    // 更新 mention 计数和最后提及时间
    props.mention_count = (props.mention_count || 0) + 1;
    props.last_mentioned = new Date().toISOString();

    // 重算完整性
    props.completeness = this.calcProfileCompleteness(props as PersonProfile);

    this.run('UPDATE nodes SET properties = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(props), new Date().toISOString(), node.id]);
    this.markDirty(true);
  }

  /**
   * 计算画像完整度 (0-1)
   * 权重：relation=30%, traits=20%, occupation=15%, interests=10%, timeline=15%, description=10%
   * v1.1: 支持 dossier 结构补充评分
   */
  calcProfileCompleteness(profile: PersonProfile): number {
    let score = 0;
    // flat 字段评分
    if (profile.relation_to_user && profile.relation_to_user !== '认识的人') score += 0.2;
    else if (profile.relation_to_user) score += 0.08;
    if (profile.traits && profile.traits.length > 0) score += 0.1;
    if (profile.occupation) score += 0.08;
    if (profile.interests && profile.interests.length > 0) score += 0.08;
    if (profile.timeline && profile.timeline.length > 0) score += 0.08;
    if (profile.description || profile.personality) score += 0.04;
    if (profile.appearance) score += 0.05;
    if (profile.body_features) score += 0.03;
    // dossier 10模块补充评分
    if (profile.dossier) {
      const d = profile.dossier;
      if (d.basicInfo?.gender) score += 0.03;
      if (d.basicInfo?.birthYear) score += 0.03;
      if (d.basicInfo?.birthPlace) score += 0.02;
      if (d.imageTraits?.looks) score += 0.04;
      if (d.imageTraits?.voice) score += 0.02;
      if (d.imageTraits?.distinguishingMarks) score += 0.02;
      if (d.imageTraits?.scent) score += 0.02;
      // 女性详细体征评分
      if (d.imageTraits?.feminineDetails?.firstImpression) score += 0.02;
      if (d.imageTraits?.feminineDetails?.stature || d.imageTraits?.feminineDetails?.measurements) score += 0.03;
      if (d.imageTraits?.feminineDetails?.breasts) score += 0.03;
      if (d.imageTraits?.feminineDetails?.skin) score += 0.02;
      if (d.imageTraits?.feminineDetails?.allure) score += 0.02;
      if (d.imageTraits?.feminineDetails?.bodyScent) score += 0.02;
      if (d.imageTraits?.feminineDetails?.intimateReaction || d.imageTraits?.feminineDetails?.memorableTraits) score += 0.03;
      if (d.personalityPrefs?.habits) score += 0.03;
      if (d.imageTraits?.scent) score += 0.02;
      // 交集模块评分
      if (d.relationMap?.intersections?.metWhen) score += 0.03;
      if (d.relationMap?.intersections?.workTogether) score += 0.04;
      if (d.relationMap?.intersections?.lifeIntersection) score += 0.03;
      if (d.relationMap?.intersections?.emotionalAssessment) score += 0.03;
      if (d.relationMap?.intersections?.interestRelation) score += 0.03;
      if ((d.relationMap?.intersections?.sharedEvents || []).length > 0) score += 0.04;
      if (d.personalityPrefs?.psychology) score += 0.03;
      if (d.contact?.phone || d.contact?.wechat || d.contact?.address) score += 0.03;
      if (d.familyNetwork?.parents?.length || d.familyNetwork?.spouse || d.familyNetwork?.children?.length) score += 0.05;
      if (d.health?.condition || d.health?.medicalHistory) score += 0.03;
      if (d.lifeMilestones && d.lifeMilestones.length > 0) score += 0.05;
      if (d.memoryAnchors?.diamondIds?.length > 0) score += 0.04;
    }
    return Math.round(Math.min(1, score) * 100) / 100;
  }

  /**
   * 从 flat 字段构建初始 dossier（存量迁移用）
   */
  private buildDossierFromFlat(profile: Partial<PersonProfile>, _existing: any): PersonDossier {
    return {
      basicInfo: {
        gender: undefined, birthYear: undefined, birthPlace: undefined,
        education: profile.occupation || undefined, maritalStatus: undefined,
        zodiac: undefined, ethnicity: undefined,
      },
      contact: {
        phone: undefined, wechat: undefined, address: undefined, email: undefined, workplace: undefined,
      },
      lifeResume: {
        timeline: (profile as any).timeline || [],
        careerHistory: profile.occupation || undefined,
        notableEvents: undefined,
      },
      imageTraits: {
        looks: profile.appearance || undefined,
        bodyFeatures: profile.body_features || undefined,
        style: profile.style || undefined,
        voice: profile.voice || undefined,
        distinguishingMarks: undefined,
        scent: undefined,
        feminineDetails: undefined,
      },
      personalityPrefs: {
        traits: profile.traits || [],
        description: profile.personality || undefined,
        interests: profile.interests || [],
        habits: profile.habits || undefined,
        psychology: profile.psychology || undefined,
      },
      relationMap: {
        relationToUser: profile.relation_to_user || '',
        intersections: undefined,
        notes: _existing.备注 || _existing.note || _existing.context || undefined,
      },
      familyNetwork: {
        parents: undefined, spouse: undefined, children: undefined,
        siblings: undefined, extended: undefined,
      },
      health: {
        condition: undefined, medicalHistory: undefined, allergies: undefined, lifestyle: undefined,
      },
      lifeMilestones: [],
      socialCapital: {
        colleagues: undefined, friends: undefined, clients: undefined, description: undefined,
      },
      memoryAnchors: { diamondIds: [] },
    };
  }

  /**
   * v1.1: 添加记忆锚点（Top-5，满5自动淘汰最旧）
   */
  async addMemoryAnchor(personName: string, diamondId: string): Promise<void> {
    const nodes = this.query('SELECT id, properties FROM nodes WHERE name = ? AND type = ?', [personName, 'person']);
    if (nodes.length === 0) return;

    const props = nodes[0].properties ? JSON.parse(nodes[0].properties) : {};
    const dossier: PersonDossier = props.dossier || this.buildDossierFromFlat(props, props);
    const anchors = dossier.memoryAnchors || { diamondIds: [] };

    if (anchors.diamondIds.includes(diamondId)) return;
    anchors.diamondIds.push(diamondId);
    if (anchors.diamondIds.length > 5) {
      anchors.diamondIds = anchors.diamondIds.slice(-5);
    }
    dossier.memoryAnchors = anchors;
    props.dossier = dossier;
    this.run('UPDATE nodes SET properties = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(props), new Date().toISOString(), nodes[0].id]);
    this.markDirty(true);
  }

  /**
   * v1.1: 获取完整结构化档案
   */
  getFullProfile(personName: string): PersonDossier | null {
    const profile = this.getPersonProfile(personName);
    if (!profile) return null;
    return profile.dossier ?? this.buildDossierFromFlat(profile, {});
  }

  /**
   * v1.1: 迁移所有存量人物画像到 dossier 结构（幂等）
   */
  async migrateProfilesToDossier(): Promise<{ total: number; migrated: number; errors: number }> {
    const persons = this.query('SELECT id, name, properties FROM nodes WHERE type = ?', ['person']);
    let migrated = 0, errors = 0;
    for (const node of persons) {
      try {
        const props = node.properties ? JSON.parse(node.properties) : {};
        if (props.dossier) continue;
        const profile: Partial<PersonProfile> = { ...props, name: node.name };
        props.dossier = this.buildDossierFromFlat(profile, props);
        props.completeness = this.calcProfileCompleteness({ ...profile, dossier: props.dossier } as PersonProfile);
        this.run('UPDATE nodes SET properties = ?, updated_at = ? WHERE id = ?',
          [JSON.stringify(props), new Date().toISOString(), node.id]);
        migrated++;
      } catch { errors++; }
    }
    if (migrated > 0) {
      this.markDirty(true);
      if (errors > 0) console.warn(`[FamilyGraph] dossier 迁移: ${migrated} 人升级, ${errors} 错误`);
      else console.log(`[FamilyGraph] dossier 迁移: ${migrated} 人升级`);
    }
    return { total: persons.length, migrated, errors };
  }

  /**
   * v1.1: 添加待确认条目（30 天 TTL）
   */
  async addPendingItem(personName: string, field: string, value: string, source: string): Promise<void> {
    const node = this.findPersonNodeByNameOrAlias(personName);
    if (!node) return;

    // 🏛️ §12.2: 入库前过滤 — 拦截LLM生成的场景文本
    if (!_isValidPendingValue(value)) return;

    const parsed = node.properties ? JSON.parse(node.properties) : {};
    const pending: PendingItem = {
      field, value, source: source.substring(0, 80),
      timestamp: new Date().toISOString(), confirmed: false, occurrences: 1,
    };
    parsed.pendingItems = this.dedupePendingItems([...(parsed.pendingItems || []), pending]);
    this.promotePendingItems(parsed);
    if (parsed.dossier) {
      parsed.completeness = this.calcProfileCompleteness(parsed as PersonProfile);
    }
    this.run('UPDATE nodes SET properties = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(parsed), new Date().toISOString(), node.id]);
    this.markDirty();

    // 🛡️ 备份仅在 initialize() 时执行，写操作不触发全量备份（户籍制度 §7.1）
    this._ensureSelfNode();
  }

  /**
   * 🏛️ §12.2: 检测当前是否有未解决的档案冲突
   * 返回结构化冲突报告，供 chat.ts 构造反问问题。
   *
   * 使用模式:
   *   const cr = fg.detectConflicts('徐诗雨');
   *   if (cr.hasConflict) {
   *     // 构造反问: `我记得你之前说${name}的${cr.items[0].field}是${cr.items[0].oldValue}...`
   *   }
   */
  detectConflicts(personName: string): ConflictReport {
    const node = this.findPersonNodeByNameOrAlias(personName);
    if (!node) return { hasConflict: false, items: [] };
    const props = JSON.parse(node.properties || '{}');
    const conflicts: Array<ConflictItem> = (props.conflicts || []).map((c: any) => ({
      field: c.field,
      oldValue: c.oldValue,
      newValue: c.newValue,
      timestamp: c.timestamp,
      resolved: c.resolved || false,
    })).filter((c: ConflictItem) => !c.resolved);
    return {
      hasConflict: props.conflict === true && conflicts.length > 0,
      items: conflicts,
    };
  }

  /**
   * 🏛️ §11.4: 解决档案冲突。
   * @param resolution 'keep_old' — 保留旧值，丢弃新值 | 'accept_new' — 接受新值，替换旧值
   */
  resolveConflict(personName: string, field: string, resolution: 'keep_old' | 'accept_new'): void {
    const node = this.findPersonNodeByNameOrAlias(personName);
    if (!node) return;
    const props = JSON.parse(node.properties || '{}');

    // 找到对应冲突条目
    const conflicts: any[] = props.conflicts || [];
    const idx = conflicts.findIndex((c: any) => c.field === field && !c.resolved);
    if (idx === -1) return;

    if (resolution === 'accept_new') {
      // 替换旧值为新值
      (props as any)[field] = conflicts[idx].newValue;
    }
    // 标记已解决
    conflicts[idx].resolved = true;
    conflicts[idx].resolvedAt = new Date().toISOString();
    conflicts[idx].resolution = resolution;

    // 检查是否所有冲突都已解决
    const allResolved = conflicts.every((c: any) => c.resolved);
    props.conflicts = conflicts;
    props.conflict = !allResolved;

    this.run('UPDATE nodes SET properties = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(props), new Date().toISOString(), node.id]);
    this.markDirty();
    console.log(`[FamilyGraph] 冲突解决: ${personName} ${field} → ${resolution}`);
  }


  /**
   * v1.1: 清理 30 天以上未确认的 pending 条目
   */
  cleanExpiredPendingItems(): number {
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    const persons = this.query('SELECT id, name, properties FROM nodes WHERE type = ?', ['person']);
    let total = 0;
    for (const node of persons) {
      try {
        const props = node.properties ? JSON.parse(node.properties) : {};
        const items: PendingItem[] = props.pendingItems || [];
        const before = items.length;
        props.pendingItems = items.filter(i => i.timestamp >= cutoff || i.confirmed);
        if (props.pendingItems.length < before) {
          total += before - props.pendingItems.length;
          this.run('UPDATE nodes SET properties = ?, updated_at = ? WHERE id = ?',
            [JSON.stringify(props), new Date().toISOString(), node.id]);
        }
      } catch { /* skip */ }
    }
    if (total > 0) { this.markDirty(); console.log(`[FamilyGraph] 清理 ${total} 条过期 pending`); }
    return total;
  }

  /**
   * v1.1: 从对话文本中提取人物档案信息（ProfileExtractor）
   * 规则：
   *   - 履历/特质类（traits/interests）：只追加不覆盖
   *   - 基础信息/关系类（occupation/relation_to_user）：仅高置信度可覆盖
   *   - 冲突信息：标记为 pending 而非直接覆盖
   *
   * @param personName 目标人物名
   * @param conversationText 对话原文（用于提取上下文）
   * @returns 本次提取到的字段数
   */
  /**
   * 🏛️ §十四: 确保每个人拥有档案骨架（家族向量 + 时间线向量 + 寻址链）
   * ==============================================================
   * 首次为某人创建档案时自动提取已知信息：
   *   - 家族向量: 从 edges 表反查所有关系
   *   - 寻址链向量: BFS 从"我"到此人的最短家族路径
   *   - 时间线向量: first_mentioned / last_mentioned / birthYear推算
   *
   * 该方法是幂等的——已有档案的人不会被覆盖，只补充缺失字段。
   */
  ensurePersonProfile(personName: string): PersonProfile {
    const node = this.findPersonNodeByNameOrAlias(personName);
    if (!node) return null!;
    const existing = JSON.parse(node.properties || '{}');
    const now = new Date().toISOString();

    // ── 基础标识 ──
    if (!existing.name) existing.name = personName;
    // 🛡️ mention_count 和 last_mentioned 由 updatePersonProfile 统一管理，此处不碰

    // ── 家族向量: 从 edges 反查 ──
    if (!existing.relations) {
      existing.relations = this._buildRelationVector(personName, node.id);
    }

    // ── 寻址链向量: BFS 从"我"到此人 ──
    if (!existing.addressingChain) {
      const chain = this._buildAddressingChain(personName, node.id);
      if (chain) existing.addressingChain = chain;
    }

    // ── 时间线向量 ──
    if (!existing.first_mentioned) existing.first_mentioned = existing.last_mentioned || now;
    if (!existing.timeline) existing.timeline = [];
    // 如果有 birthYear，时间线自动生成年龄演变记录
    const birthYear = existing.birthYear || existing.dossier?.basicInfo?.birthYear;
    if (birthYear && existing.timeline.length === 0) {
      const by = parseInt(String(birthYear), 10);
      if (!isNaN(by)) {
        existing.timeline.push({ date: `${by}`, summary: `${personName}出生`, type: 'birth' });
        existing.timeline.push({ date: now.substring(0,7), summary: `年龄: ${new Date().getFullYear() - by}岁 (实时计算)`, type: 'age_latest' });
      }
    } else if (existing.age && existing.timeline.length === 0) {
      existing.timeline.push({ date: now.substring(0,7), summary: `首次记录年龄: ${existing.age}岁`, type: 'age_recorded' });
    }

    // ── 自动补充可达信息 ──
    // 如果有"我"与某人的关系边，反推 relation_to_user
    if (!existing.relation_to_user && existing.relations) {
      const relToMe = existing.relations.find((r: any) => r.relative === '我');
      if (relToMe) {
        const desc = this._describeRelationForProfile(relToMe.relation, relToMe.direction, personName);
        if (desc) existing.relation_to_user = desc;
      }
    }

    // 从边类型推断性别
    if (!existing.gender) {
      const inferredGender = this._inferGenderFromEdges(node.id);
      if (inferredGender) existing.gender = inferredGender;
    }

    // ── 写入 ──
    if (!existing.completeness) existing.completeness = this.calcProfileCompleteness(existing as PersonProfile);
    existing._autoProfileGenerated = now;
    this.run('UPDATE nodes SET properties = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(existing), now, node.id]);
    return existing as PersonProfile;
  }

  /** 🏛️ 为所有人批量建立档案 */
  ensureAllPersonProfiles(): { total: number; enriched: number; details: string[] } {
    const all = this.query("SELECT name FROM nodes WHERE type = 'person'");
    let enriched = 0;
    const details: string[] = [];
    for (const row of all) {
      try {
        const existing = this.findPersonNodeByNameOrAlias(row.name);
        if (!existing) continue;
        const props = JSON.parse(existing.properties || '{}');
        const hadRelations = !!props.relations;
        const hadChain = !!props.addressingChain;
        const hadTimeline = Array.isArray(props.timeline) && props.timeline.length > 0;
        this.ensurePersonProfile(row.name);
        if (!hadRelations || !hadChain || !hadTimeline) {
          enriched++;
          details.push(row.name);
        }
      } catch { /* skip */ }
    }
    if (enriched > 0) {
      this.markDirty();
      console.log(`[FamilyGraph] 档案骨架建立: ${enriched} 人`);
    }
    return { total: all.length, enriched, details };
  }

  // ═══ 内部辅助: 档案骨架构建 ═══

  /** 从 edges 表反查某人的全部家族关系 */
  private _buildRelationVector(personName: string, nodeId: string): Array<{ relative: string; relation: string; direction: 'to' | 'from' }> {
    const result: Array<{ relative: string; relation: string; direction: 'to' | 'from' }> = [];
    const FAMILY = new Set(['mother_of','father_of','parent_of','child_of',
      'elder_sister_of','younger_sister_of','sister_of','brother_of','sibling_of',
      'spouse_of','grandfather_of','grandmother_of','grandchild_of',
      'aunt_of','uncle_of','niece_of','nephew_of','cousin_of']);
    const SOCIAL = new Set(Object.keys(SOCIAL_REVERSE));
    const ALL_RELS = new Set([...FAMILY, ...SOCIAL]);
    const seen = new Set<string>();

    for (const e of this.query("SELECT target_id, relation FROM edges WHERE source_id = ?", [nodeId])) {
      if (!ALL_RELS.has(e.relation)) continue;
      const tgtInfo = this._getPersonInfo(e.target_id);
      const relName = tgtInfo?.name || '?';
      const key = `${relName}|${e.relation}`;
      if (seen.has(key)) continue; seen.add(key);
      result.push({ relative: relName, relation: e.relation, direction: 'to' });
    }
    for (const e of this.query("SELECT source_id, relation FROM edges WHERE target_id = ?", [nodeId])) {
      if (!ALL_RELS.has(e.relation)) continue;
      const srcInfo = this._getPersonInfo(e.source_id);
      const relName = srcInfo?.name || '?';
      const key = `${relName}|_rev_${e.relation}`;
      if (seen.has(key)) continue; seen.add(key);
      result.push({ relative: relName, relation: e.relation, direction: 'from' });
    }
    return result;
  }

  /** BFS 从"我"到目标人物的寻址链 */
  private _buildAddressingChain(personName: string, targetId: string): string | null {
    if (personName === '我') return '本人';

    const meIds = this._findPersonIds('我');
    if (!meIds.length) return null;

    const path = this._findKinshipPath(meIds[0], targetId);
    if (!path) return null;

    // 将路径转换为自然语言寻址链
    // 构建可读寻址链: 我 > [关系] > 某人 > [关系] > 目标
    const parts: string[] = ['我'];
    for (const step of path) {
      const info = this._getPersonInfo(step.targetId);
      const nm = info?.name || '?';
      const label = RELATION_LABEL_CN[step.relation] || step.relation.replace('_reverse_','');
      parts.push(label);
      parts.push(nm);
    }
    // 去重相邻: [我, 子女, 阿苏, 妈妈, 徐诗雨] → "我 > 阿苏[子女] > 徐诗雨[妈妈]"
    const compact: string[] = [];
    let lastPerson = '我';
    for (let i = 1; i < parts.length; i += 2) {
      const rel = parts[i] || '';
      const person = parts[i+1] || '';
      if (person && person !== lastPerson) {
        compact.push(`${person}[${rel}]`);
        lastPerson = person;
      }
    }
    return compact.length > 0 ? `我 > ${compact.join(' > ')}` : '无路径';
  }

  /** 从关系边类型推断性别 */
  private _inferGenderFromEdges(nodeId: string): string | null {
    // 出边
    for (const e of this.query("SELECT relation FROM edges WHERE source_id = ?", [nodeId])) {
      if (['mother_of','elder_sister_of','younger_sister_of','sister_of','aunt_of','niece_of','grandmother_of'].includes(e.relation)) return 'female';
      if (['father_of','elder_brother_of','younger_brother_of','brother_of','uncle_of','nephew_of','grandfather_of'].includes(e.relation)) return 'male';
    }
    // 入边
    for (const e of this.query("SELECT relation FROM edges WHERE target_id = ?", [nodeId])) {
      if (['mother_of','elder_sister_of','younger_sister_of','sister_of','aunt_of','niece_of','grandmother_of'].includes(e.relation)) return 'female';
      if (['father_of','elder_brother_of','younger_brother_of','brother_of','uncle_of','nephew_of','grandfather_of'].includes(e.relation)) return 'male';
    }
    // 从名字推断
    const rows = this.query("SELECT name FROM nodes WHERE id = ?", [nodeId]);
    if (rows.length > 0) {
      const nm = rows[0].name;
      if (/(姐|妹|妈|娘|奶|婆|姨|姑|女|玥|薇|茜|雪|芬|珍|花|云|韵|涵|雨|瑶)/.test(nm)) return 'female';
      if (/(哥|弟|爸|爹|爷|公|叔|舅|男|勇|铭|权|斌|龙|锋|伟|工)/.test(nm)) return 'male';
    }
    return null;
  }

  /** 从关系边描述"与用户的身份" */
  private _describeRelationForProfile(relation: string, direction: 'to' | 'from', personName: string): string | null {
    // direction 'from' = 别人指向此人 → 此人是 relation 的承受方
    // direction 'to' = 此人指向别人
    if (direction === 'from') {
      // source --rel--> person
      if (relation === 'child_of') return `${personName}的孩子`;
      if (relation === 'spouse_of') return `${personName}的配偶`;
      if (relation.startsWith('sister') || relation.includes('sister')) return `${personName}的姐妹`;
      if (relation.startsWith('brother') || relation.includes('brother')) return `${personName}的兄弟`;
      if (relation === 'niece_of' || relation === 'nephew_of') return `${personName}的侄/甥辈`;
    }
    if (direction === 'to') {
      if (relation === 'mother_of') return `${personName}的妈妈`;
      if (relation === 'father_of') return `${personName}的爸爸`;
      if (relation === 'parent_of') return `${personName}的家长`;
      if (relation.startsWith('elder_sister')) return `${personName}的姐姐`;
      if (relation.startsWith('younger_sister')) return `${personName}的妹妹`;
      if (relation.startsWith('elder_brother')) return `${personName}的哥哥`;
      if (relation.startsWith('younger_brother')) return `${personName}的弟弟`;
      if (relation === 'spouse_of') return `${personName}的配偶`;
      if (relation === 'aunt_of') return `${personName}的阿姨/姑姑`;
      if (relation === 'uncle_of') return `${personName}的叔叔/舅舅`;
      if (relation === 'cousin_of') return `${personName}的堂表亲`;
    }
    return null;
  }

  /**
   * C2+C3: 从对话文本中提取人物档案。
   * - conversationText: 完整对话（用于第三人称匹配，如"张三是工程师"）
   * - selfNarration: 可选，该人物自己的发言（用于第一人称匹配，如"我是工程师"）
   *   仅当该人物是对话的发言者时才传入，避免将用户的第一人称误归因到其他人物。
   */
  async extractProfileFromText(personName: string, conversationText: string, selfNarration?: string): Promise<number> {
    const profile = this.getPersonProfile(personName);
    if (!profile || !conversationText) return 0;

    let extracted = 0;
    const selfText = selfNarration || '';

    // C2+C3: 双人称匹配辅助 — 第三人称匹配完整对话，第一人称仅匹配该人物自己的发言
    const matchSubj = (body: string): RegExpMatchArray | null => {
      return conversationText.match(new RegExp(`${personName}${body}`))
          || (selfText ? selfText.match(new RegExp(`我${body}`)) : null);
    };

    // 1. 提取职业/身份（高置信度模式：包含"是"的声明句）
    const occupationMatch = matchSubj(`(?:是|做|从事|在.+?担任)([^，。！？]{2,20}(?:工作|一职|岗位|职位|老师|医生|工程师|经理|主管|员))`);
    if (occupationMatch && !profile.occupation && !isInvalidProfileSnippet(occupationMatch[1])) {
      const occupation = occupationMatch[1].substring(0, 30);
      await this.updatePersonProfile(personName, { occupation } as any, { countMention: false });
      extracted++;
    }

    // 2. 提取性格标签（低置信度追加模式 — 无主语锚定，全文扫描）
    // C2+C3: 同时扫描完整对话和该人物自己的发言
    const scanText = selfText ? conversationText + '\n' + selfText : conversationText;
    const traitHints = [
      { regex: /开朗|外向|活泼/, value: '开朗' },
      { regex: /内向|安静|腼腆/, value: '内向' },
      { regex: /温柔|温和|脾气好/, value: '温柔' },
      { regex: /急脾气|暴躁|火爆/, value: '急躁' },
      { regex: /幽默|风趣|搞笑/, value: '幽默' },
      { regex: /细心|细致|心细/, value: '细心' },
      { regex: /大方|豪爽/, value: '大方' },
      { regex: /勤快|勤奋/, value: '勤奋' },
      { regex: /懒惰|懒散/, value: '懒散' },
      { regex: /乐观/, value: '乐观' },
      { regex: /悲观/, value: '悲观' },
      { regex: /热心|乐于助人/, value: '热心' },
      { regex: /固执|要强/, value: '固执' },
      { regex: /贤惠|体贴|顾家/, value: '顾家' },
      { regex: /善良|心软/, value: '善良' },
      { regex: /成熟|稳重/, value: '稳重' },
      { regex: /大方|不小气/, value: '大方' },
    ];
    const newTraits: string[] = [];
    for (const hint of traitHints) {
      if (hint.regex.test(scanText)) {
        const existing = profile.traits || [];
        if (!existing.includes(hint.value)) {
          newTraits.push(hint.value);
        }
      }
    }
    if (newTraits.length > 0) {
      const merged = [...(profile.traits || []), ...newTraits];
      await this.updatePersonProfile(personName, { traits: merged } as any, { countMention: false });
      extracted += newTraits.length;
    }

    // 3. 提取关系描述
    const relationNoteMatch = matchSubj(`(?:是|算|属于)(?:我的|你的|我|你)?([^，。！？]{2,20}(?:朋友|同学|同事|亲戚|邻居|合伙人|搭档|合作伙伴))`);
    if (relationNoteMatch && relationNoteMatch[1]) {
      const note = relationNoteMatch[1].substring(0, 30);
      if (!profile.relation_to_user) {
        await this.updatePersonProfile(personName, { relation_to_user: note } as any, { countMention: false });
        extracted++;
      } else if (profile.relation_to_user !== note) {
        await this.addPendingItem(personName, 'relationMap.relationToUser', note, conversationText.substring(0, 80));
        extracted++;
      }
    }

    // 4. 提取爱好（追加模式 — 无主语锚定）
    const interestHints = [
      /喜欢|爱好|爱看|爱听|爱玩|爱打|爱去|爱做/,
      /热爱|酷爱|迷恋/,
    ];
    for (const hint of interestHints) {
      const interestMatch = scanText.match(hint);
      if (interestMatch) {
        const detailMatch = scanText.match(new RegExp(`${interestMatch[0]}([^，。！？]{2,20})`));
        if (detailMatch) {
          const interest = detailMatch[1].substring(0, 15);
          if (!(profile.interests || []).includes(interest) && interest.length >= 2) {
            const merged = [...(profile.interests || []), interest];
            await this.updatePersonProfile(personName, { interests: merged } as any, { countMention: false });
            extracted++;
          }
        }
      }
    }

    // 5. 提取外貌描述
    const appearanceMatch = matchSubj(`(?:长?得?|长相|样子|看起来)([^，。！？]{3,30})`);
    if (appearanceMatch && appearanceMatch[1].length >= 3) {
      const desc = appearanceMatch[1].substring(0, 40);
      if (!profile.appearance && !profile.dossier?.imageTraits?.looks) {
        await this.updatePersonProfile(personName, { appearance: desc } as any, { countMention: false });
        extracted++;
      } else if (profile.appearance && profile.appearance !== desc) {
        await this.addPendingItem(personName, 'appearance', desc, conversationText.substring(0, 80));
        extracted++;
      }
    }

    // ── v1.2 新增提取规则 ──

    // 6. 提取联系方式（电话/微信/地址 — 无主语锚定）
    const phoneMatch = scanText.match(/(?:电话|手机|打给我|联系)(?:\s*[:：]?\s*)(1[3-9]\d{9})/);
    if (phoneMatch) {
      const phone = phoneMatch[1];
      if (profile.dossier?.contact?.phone !== phone) {
        const dossier = this.getFullProfile(personName) || this.buildDossierFromFlat(profile, {});
        dossier.contact.phone = phone;
        await this.updatePersonProfile(personName, {} as any, { countMention: false });
        extracted++;
      }
    }
    const wechatMatch = scanText.match(/(?:微信|WeChat|wx)(?:\s*[:：]?\s*)([a-zA-Z0-9_]{4,30})/);
    if (wechatMatch) {
      const wechat = wechatMatch[1];
      await this.addPendingItem(personName, 'contact.wechat', wechat, conversationText.substring(0, 80));
      extracted++;
    }

    // 7. 提取年龄/出生年份（无主语锚定）
    // C2+C3: 优先从 selfText 匹配"我今年X岁"，再回退到全文匹配
    const ageMatch = (selfText ? selfText.match(/(?:我|)今年(\d{1,2})岁/) : null)
                  || scanText.match(/(?:今年|现在)(\d{1,2})岁/);
    if (ageMatch) {
      const age = parseInt(ageMatch[1]);
      const birthYear = new Date().getFullYear() - age;
      await this.addPendingItem(personName, 'basicInfo.birthYear', String(birthYear), conversationText.substring(0, 80));
      extracted++;
    }

    // 8. 提取健康信息
    const healthMatch = matchSubj(`.*?(?:身体|健康|生病|住院|吃药|手术|过敏|毛病)([^。！？]{2,30})`);
    if (healthMatch) {
      const healthInfo = healthMatch[0].substring(0, 40);
      await this.addPendingItem(personName, 'health.condition', healthInfo, conversationText.substring(0, 80));
      extracted++;
    }

    // 9. 提取工作单位/地点
    const workplaceMatch = matchSubj(`.*?(?:在|任职于|工作于|在.*上班)([^，。！？]{2,20})`);
    if (workplaceMatch && !isInvalidProfileSnippet(workplaceMatch[1])) {
      const workplace = workplaceMatch[1].substring(0, 20);
      await this.addPendingItem(personName, 'contact.workplace', workplace, conversationText.substring(0, 80));
      extracted++;
    }

    // 📜 提取住址/家庭地址
    const addrMatch = matchSubj(`.*?(?:住在|住|家在)([^，。！？]{2,30})`)
                   || matchSubj(`.*?(?:家|住的地方|住址)(?:在|是)([^，。！？]{2,30})`);
    if (addrMatch && addrMatch[1] && !/什么|哪里|哪儿|哪/.test(addrMatch[1])) {
      const addr = addrMatch[1].trim().substring(0, 30);
      if (!(profile as any).address || (profile as any).address !== addr) {
        await this.updatePersonProfile(personName, { address: addr } as any, { countMention: false });
        extracted++;
      }
    }

    // 10. 提取人生大事（结婚/生子/毕业等）
    const milestoneMatch = matchSubj(`.*?(?:结婚|生子|毕业|考上|入职|退休|去世|生病|住院|创业|开店)([^。！？]{2,30})`);
    if (milestoneMatch) {
      await this.addPendingItem(personName, 'lifeMilestones', milestoneMatch[0].substring(0, 40), conversationText.substring(0, 80));
      extracted++;
    }

    // 11. 提取家庭关系（XX的爸爸/妈妈/老婆/老公等）
    const familyRelMatch = matchSubj(`(?:的|是)(?:爸爸|妈妈|父亲|母亲|老公|老婆|丈夫|妻子|儿子|女儿|孩子|哥哥|弟弟|姐姐|妹妹|兄弟|姐妹|爷爷|奶奶|外公|外婆)`);
    if (familyRelMatch) {
      const relation = familyRelMatch[0].substring(0, 20);
      await this.addPendingItem(personName, 'familyNetwork.extended', relation, conversationText.substring(0, 80));
      extracted++;
    }

    // ── v1.2 新增：与用户的交集提取 ──
    // 交集规则结构复杂，不使用 matchSubj，分别处理第三人称和第一人称

    // 12. 提取结识场景（"我和XX是在XX认识的" / "我是在XX认识你的"）
    let metWhen: string | null = null;
    const metMatch = conversationText.match(new RegExp(`(?:我和|与)${personName}(?:是在|是)([^，。！？]{2,30})(?:认识的|认识|见面|相遇|碰到的)`));
    if (metMatch) { metWhen = metMatch[1].substring(0, 30); }
    if (!metWhen && selfText) {
      const metFirstMatch = selfText.match(new RegExp(`我(?:是在|是)([^，。！？]{2,30})(?:认识你的|和你认识的|认识你|见到你的|遇到你|碰见你的)`));
      if (metFirstMatch) { metWhen = metFirstMatch[1].substring(0, 30); }
    }
    if (metWhen) {
      await this.addPendingItem(personName, 'relationMap.intersections.metWhen', metWhen, conversationText.substring(0, 80));
      extracted++;
    }

    // 13. 提取共事记录（"张三和我一起做XX" / "我和你一起做XX"）
    let workTogether: string | null = null;
    const workMatch = conversationText.match(new RegExp(`${personName}(?:和我|同我|跟我)?(?:一起|一同|合作|共事|搭档|合伙|共同)(?:做|搞|负责|参与|创业|经营|管理)([^，。！？]{2,40})`));
    if (workMatch) { workTogether = workMatch[0].substring(0, 50); }
    if (!workTogether && selfText) {
      const workFirstMatch = selfText.match(new RegExp(`我(?:和你|同你|跟你)(?:一起|一同|合作|共事|搭档|合伙|共同)(?:做|搞|负责|参与|创业|经营|管理)([^，。！？]{2,40})`));
      if (workFirstMatch) { workTogether = workFirstMatch[0].substring(0, 50); }
    }
    if (workTogether) {
      await this.addPendingItem(personName, 'relationMap.intersections.workTogether', workTogether, conversationText.substring(0, 80));
      extracted++;
    }

    // 14. 提取生活交集（"张三和我一起去XX" / "我和你一起去XX"）
    let lifeIntersection: string | null = null;
    const lifeMatch = conversationText.match(new RegExp(`${personName}(?:和我|同我|跟我)?(?:一起|经常|偶尔|有时)(?:去|来|吃|喝|玩|聚|见|约|住|走)([^，。！？]{2,30})`));
    if (lifeMatch) { lifeIntersection = lifeMatch[0].substring(0, 40); }
    if (!lifeIntersection && selfText) {
      const lifeFirstMatch = selfText.match(new RegExp(`我(?:和你|同你|跟你)(?:一起|经常|偶尔|有时)(?:去|来|吃|喝|玩|聚|见|约|住|走)([^，。！？]{2,30})`));
      if (lifeFirstMatch) { lifeIntersection = lifeFirstMatch[0].substring(0, 40); }
    }
    if (lifeIntersection) {
      await this.addPendingItem(personName, 'relationMap.intersections.lifeIntersection', lifeIntersection, conversationText.substring(0, 80));
      extracted++;
    }

    // 15. 提取情感评价（"对张三很信任" / "我对你很信任"）
    const emotionMatch = conversationText.match(new RegExp(`对${personName}(?:很|非常|挺|特别|有点|有些|一向)(?:信赖|信任|看重|欣赏|佩服|尊敬|感恩|感激|讨厌|反感|不满|失望|嫌弃|依赖|依靠|忌惮|防备)`))
                      || (selfText ? selfText.match(new RegExp(`我对你(?:很|非常|挺|特别|有点|有些|一向)(?:信赖|信任|看重|欣赏|佩服|尊敬|感恩|感激|讨厌|反感|不满|失望|嫌弃|依赖|依靠|忌惮|防备)`)) : null);
    if (emotionMatch) {
      const assessment = emotionMatch[0].substring(0, 30);
      await this.addPendingItem(personName, 'relationMap.intersections.emotionalAssessment', assessment, conversationText.substring(0, 80));
      extracted++;
    }

    // 16. 提取利益关系（"张三是我的客户" / "我是你的客户"）
    const interestMatch = conversationText.match(new RegExp(`${personName}(?:是|算|属于)我的(?:客户|供应商|合伙人|合作伙伴|老板|上级|下属|员工|同事|搭档|乙方|甲方|代理商|渠道商|股东|投资人)`))
                       || (selfText ? selfText.match(new RegExp(`我(?:是|算|属于)你的(?:客户|供应商|合伙人|合作伙伴|老板|上级|下属|员工|同事|搭档|乙方|甲方|代理商|渠道商|股东|投资人)`)) : null);
    if (interestMatch) {
      const interestRelation = interestMatch[0].substring(0, 20);
      await this.addPendingItem(personName, 'relationMap.intersections.interestRelation', interestRelation, conversationText.substring(0, 80));
      extracted++;
    }

    // ── v1.2 新增：女性详细体征提取 ──
    // C2+C3: 全部经由 matchSubj，第一人称仅匹配 selfNarration（该人物自己的发言）

    // 17. 提取整体印象/气质
    const impressionMatch = matchSubj(`.*?(?:第一印象|给人的感觉|气质|那种|一看就是|看起来)([^。！？]{3,30})`);
    if (impressionMatch) {
      await this.addPendingItem(personName, 'imageTraits.feminineDetails.firstImpression', impressionMatch[0].substring(0, 50), conversationText.substring(0, 80));
      extracted++;
    }

    // 18. 提取身高体型描述（含三围/身材数据）
    const statureMatch = matchSubj(`.*?(?:身高|一米[五六七八九]|身材|个子|体型|三围|胸围|腰围|臀围|匀称|苗条|丰满|娇小|高挑|修长|性感|火辣)([^。！？]{3,30})`);
    if (statureMatch) {
      await this.addPendingItem(personName, 'imageTraits.feminineDetails.stature', statureMatch[0].substring(0, 50), conversationText.substring(0, 80));
      extracted++;
    }

    // 19. 提取胸部特征
    const breastMatch = matchSubj(`.*?(?:胸|乳房|乳沟|奶子|胸部|乳晕|乳头|胸型|罩杯|丰满|平胸|微乳|大胸|巨乳|椒乳|酥胸|双峰)([^。！？]{2,30})`);
    if (breastMatch) {
      await this.addPendingItem(personName, 'imageTraits.feminineDetails.breasts', breastMatch[0].substring(0, 50), conversationText.substring(0, 80));
      extracted++;
    }

    // 20. 提取臀部/腰/腿特征
    const bodyPartMatch = matchSubj(`.*?(?:臀|屁股|翘臀|蜜桃臀|圆润|腰|细腰|小蛮腰|水蛇腰|蜜桃|美腿|大腿|长腿|玉腿|腿型|小腿|修长|笔直|性感)([^。！？]{2,30})`);
    if (bodyPartMatch) {
      await this.addPendingItem(personName, 'imageTraits.feminineDetails.buttocks', bodyPartMatch[0].substring(0, 50), conversationText.substring(0, 80));
      extracted++;
    }

    // 21. 提取皮肤描述
    const skinMatch = matchSubj(`.*?(?:皮肤|肌肤|肤质|雪白|白皙|嫩滑|光滑|细腻|吹弹可破|冰肌玉骨|小麦色|古铜|白嫩|弹性|体温|温热|冰凉)([^。！？]{2,30})`);
    if (skinMatch) {
      await this.addPendingItem(personName, 'imageTraits.feminineDetails.skin', skinMatch[0].substring(0, 50), conversationText.substring(0, 80));
      extracted++;
    }

    // 22. 提取唇/眼/发特征
    const lookMatch = matchSubj(`.*?(?:嘴唇|双唇|红唇|性感|丰唇|薄唇|眼睛|眼神|双眸|眼眸|瞳孔|桃花眼|丹凤眼|睫毛|秀发|长发|青丝|发丝|发质|马尾|披肩发|短发|卷发|直发|发香)([^。！？]{2,30})`);
    if (lookMatch) {
      await this.addPendingItem(personName, 'imageTraits.feminineDetails.lips', lookMatch[0].substring(0, 50), conversationText.substring(0, 80));
      extracted++;
    }

    // 23. 提取体味/体香/香水
    const scentMatch = matchSubj(`.*?(?:体味|体香|香水|味道|气味|香|气息|芬芳|幽香|清香|淡香|浓郁|奶香|花|栀子|玫瑰|茉莉|檀香|麝香)([^。！？]{2,30})`);
    if (scentMatch) {
      await this.addPendingItem(personName, 'imageTraits.feminineDetails.bodyScent', scentMatch[0].substring(0, 50), conversationText.substring(0, 80));
      extracted++;
    }

    // 24. 提取性感/魅惑描述
    const allureMatch = matchSubj(`.*?(?:性感|魅惑|妩媚|妖娆|撩人|迷人|勾人|摄魂|风骚|骚|浪|淫荡|风情|韵味|诱惑|挑逗|销魂|让人受不了|把持不住|欲火)([^。！？]{2,30})`);
    if (allureMatch) {
      await this.addPendingItem(personName, 'imageTraits.feminineDetails.allure', allureMatch[0].substring(0, 50), conversationText.substring(0, 80));
      extracted++;
    }

    // 25. 提取触感描述
    const touchMatch = matchSubj(`.*?(?:手感|触感|抚摸|接触|温软|柔软|柔滑|细腻|紧致|弹性|炙热|滚烫|冰凉|润滑|湿润|嫩滑)([^。！？]{2,30})`);
    if (touchMatch) {
      await this.addPendingItem(personName, 'imageTraits.feminineDetails.touch', touchMatch[0].substring(0, 50), conversationText.substring(0, 80));
      extracted++;
    }

    // 26. 提取特殊记忆点
    const memMatch = matchSubj(`.*?(?:最让人|最令我|印象最深|忘不了|怀念|想念|回味|魂牵梦萦|念念不忘|挥之不去)([^。！？]{3,40})`);
    if (memMatch) {
      await this.addPendingItem(personName, 'imageTraits.feminineDetails.memorableTraits', memMatch[0].substring(0, 60), conversationText.substring(0, 80));
      extracted++;
    }

    return extracted;
  }

  /**
   * v1.1: 全量补全缺失的反向边
   * 遍历所有边，确保有正向边必有反向边，无单向断链
   */
  completeReverseEdges(): { completed: number; errors: number } {
    let completed = 0, errors = 0;

    const allEdges = this.query(
      'SELECT e.source_id, e.target_id, e.relation, a.name as srcName, b.name as tgtName FROM edges e JOIN nodes a ON e.source_id = a.id JOIN nodes b ON e.target_id = b.id'
    );

    for (const edge of allEdges) {
      const reverseRel = REVERSE_RELATION[edge.relation] || SOCIAL_REVERSE[edge.relation];
      if (!reverseRel || reverseRel === edge.relation) continue; // 自反关系（spouse_of, friend_of）无需补全

      const existing = this.query(
        'SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND relation = ?',
        [edge.target_id, edge.source_id, reverseRel]
      );
      if (existing.length === 0) {
        try {
          this.run('INSERT INTO edges (id, source_id, target_id, relation, properties, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [uid(), edge.target_id, edge.source_id, reverseRel, '{}', new Date().toISOString(), new Date().toISOString()]);
          completed++;
        } catch { errors++; }
      }
    }

    if (completed > 0) {
      this.markDirty(true);
      if (errors > 0) console.warn(`[FamilyGraph] 反向边补全: ${completed} 条新增, ${errors} 错误`);
      else console.log(`[FamilyGraph] 反向边补全: ${completed} 条新增`);
    }
    return { completed, errors };
  }

  /**
   * 🏛️ 户籍制度 §三: 血缘关系传递推理 (V4.0 Phase 7)
   * =============================================
   * 反向边补全只保证 A→B 有 B→A，但家族关系需要跨节点传递。
   *
   * 规则:
   *   ① 姐妹/兄弟共享父母 — A和B是手足，A有父母P → B也有父母P
   *   ② 姐妹/兄弟共享姑姑/舅舅 — A的手足关系延伸到B
   *   ③ 姐妹/兄弟共享堂表亲 — 同上
   *   ④ 父母的父母是祖辈 — A→parent→P, P→parent→G → A是G的孙辈
   *   ⑤ 父母的姐妹/兄弟是姑姑/舅舅 — A→parent→P, P→sibling→Q → Q是A的姑姑/舅舅
   *
   * 所有 INSERT 使用 INSERT OR IGNORE，启动时可重复执行不产生重复边。
   */
  inferFamilyLinks(): { inferred: number; details: string[] } {
    const details: string[] = [];

    // ── 预加载所有边到内存 ──
    const allEdges: Array<{ src: string; tgt: string; rel: string }> = this.query(
      'SELECT source_id as src, target_id as tgt, relation as rel FROM edges'
    );
    const edgeSet = new Set(allEdges.map(e => `${e.src}|${e.tgt}|${e.rel}`));

    let added = 0;
    const addEdge = (src: string, tgt: string, rel: string, revRel?: string): boolean => {
      let didAdd = false;
      const key = `${src}|${tgt}|${rel}`;
      if (!edgeSet.has(key)) {
        this.run('INSERT OR IGNORE INTO edges (id, source_id, target_id, relation, properties, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [uid(), src, tgt, rel, '{"_inferred":true}', new Date().toISOString(), new Date().toISOString()]);
        edgeSet.add(key); added++; didAdd = true;
      }
      // 🏛️ 户籍铁律 §三.1: 每条家族边自动创建反向边
      const reverseRel = revRel || REVERSE_RELATION[rel] || null;
      if (reverseRel && reverseRel !== rel) {
        const revKey = `${tgt}|${src}|${reverseRel}`;
        if (!edgeSet.has(revKey)) {
          this.run('INSERT OR IGNORE INTO edges (id, source_id, target_id, relation, properties, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [uid(), tgt, src, reverseRel, '{"_inferred":true}', new Date().toISOString(), new Date().toISOString()]);
          edgeSet.add(revKey); added++; didAdd = true;
        }
      }
      return didAdd;
    };

    // ── 收集所有手足关系对 (A, B)  ──
    const SIBLING_RELS = new Set(['elder_sister_of','younger_sister_of','elder_brother_of',
      'younger_brother_of','sister_of','brother_of','sibling_of']);
    const siblingPairs: Array<[string, string]> = [];
    for (const e of allEdges) {
      if (SIBLING_RELS.has(e.rel)) {
        siblingPairs.push([e.src, e.tgt]);
      }
    }

    if (siblingPairs.length === 0) return { inferred: 0, details: [] };

    // ═══ 规则①②③: 姐妹/兄弟共享父母/姑姑/堂表亲 ═══
    const SHARED_RELS = new Set(['child_of','niece_of','nephew_of','cousin_of']);
    for (const [sibA, sibB] of siblingPairs) {
      for (const e of allEdges) {
        if (e.src === sibA && SHARED_RELS.has(e.rel)) {
          // sibA 有这条关系 → sibB 也应该有
          if (addEdge(sibB, e.tgt, e.rel)) {
            details.push(`rule①-③: sibling共享 →${e.tgt}(${e.rel})`);
          }
        }
      }
    }

    // ═══ 规则④: 父母的父母是祖辈 ═══
    // 收集 child_of 映射: child → [parentId, ...]
    const childToParents: Map<string, string[]> = new Map();
    for (const e of allEdges) {
      if (e.rel === 'child_of') {
        if (!childToParents.has(e.src)) childToParents.set(e.src, []);
        childToParents.get(e.src)!.push(e.tgt);
      }
    }
    // 对每个 parent，再查其 parent
    for (const [child, parents] of childToParents) {
      for (const parent of parents) {
        const grandParents = childToParents.get(parent) || [];
        for (const gp of grandParents) {
          // 推断祖辈边: gp(祖辈) → child(孙辈)
          // 检查 nodes 表获取 gp 性别以确定 grand*father* 或 grand*mother*
          const gpNodes = this.query("SELECT properties FROM nodes WHERE id = ?", [gp]);
          const gpGender = gpNodes.length > 0
            ? (() => { try { return JSON.parse(gpNodes[0].properties || '{}').gender; } catch { return null; } })()
            : null;
          const gpRel = gpGender === 'male' ? 'grandfather_of' : 'grandmother_of';
          if (addEdge(gp, child, gpRel)) { details.push(`rule④: →grandchild(grandchild_of)`); }
          if (addEdge(child, gp, 'grandchild_of')) { details.push(`rule④: grandchild→grandparent`); }
        }
      }
    }

    // ═══ 规则⑤: 父母的姐妹/兄弟是姑姑/舅舅 ═══
    for (const [child, parents] of childToParents) {
      for (const parent of parents) {
        // 找 parent 的手足
        for (const e of allEdges) {
          if ((e.src === parent || e.tgt === parent) && SIBLING_RELS.has(e.rel)) {
            const auntUncle = e.src === parent ? e.tgt : e.src;
            // 确定 aunt/uncle 的性别
            const auNodes = this.query("SELECT properties FROM nodes WHERE id = ?", [auntUncle]);
            const auGender = auNodes.length > 0
              ? (() => { try { return JSON.parse(auNodes[0].properties || '{}').gender; } catch { return null; } })()
              : null;
            // aunt/uncle → child
            const auRel = auGender === 'male' ? 'uncle_of' : 'aunt_of';
            if (addEdge(auntUncle, child, auRel)) { details.push(`rule⑤: ${auntUncle}→${child}(${auRel})`); }
            // child → aunt/uncle
            const childRel = auGender === 'male' ? 'nephew_of' : 'niece_of';
            if (addEdge(child, auntUncle, childRel)) { details.push(`rule⑤: ${child}→${auntUncle}(${childRel})`); }
          }
        }
      }
    }

    if (added > 0) {
      this.markDirty(true);
      console.log(`[FamilyGraph] 血缘传递推理: ${added} 条新边`);
    }
    return { inferred: added, details };
  }

  /**
   * 🏛️ 亲属称谓计算引擎 (V4.0 Phase 7)
   * =================================
   * 给定 FG 中任意两人，基于关系路径计算正确的中国亲属称谓。
   *
   * 核心理念: 称谓不是"查表"——是血缘距离+性别+长幼+父系/母系的四维计算结果。
   *
   * 使用:
   *   fg.getKinshipTerm('徐诗雨', '徐诗韵')
   *   // → { term: '姐姐', reverse: '妹妹', category: '手足', generation: 0 }
   */
  getKinshipTerm(fromPerson: string, toPerson: string): KinshipTerm | null {
    const fromIds = this._findPersonIds(fromPerson);
    const toIds = this._findPersonIds(toPerson);
    if (fromIds.length === 0 || toIds.length === 0) return null;

    const fromId = fromIds[0];
    const toId = toIds[0];

    const fromInfo = this._getPersonInfo(fromId);
    const toInfo = this._getPersonInfo(toId);
    if (!fromInfo || !toInfo) return null;

    // ① 找最短路径（BFS，最多 5 跳）
    const path = this._findKinshipPath(fromId, toId);
    if (!path) return null;

    // ② 分类路径 → 关系类型
    const pattern = this._classifyKinshipPath(fromId, toId, path);
    if (!pattern) return null;

    // ③ 基于性别/年龄/父系母系 解析具体称谓
    const term = this._resolveTerm(fromInfo, toInfo, pattern);

    return term;
  }

  /** 获取某人与所有人的关系称谓列表 */
  getAllKinshipTerms(personName: string): Array<{ relative: string; termAtoB: string; termBtoA: string; category: string }> {
    const results: Array<{ relative: string; termAtoB: string; termBtoA: string; category: string }> = [];
    const ids = this._findPersonIds(personName);
    if (ids.length === 0) return results;

    const allPersons = this.query("SELECT id, name FROM nodes WHERE type = 'person' AND name != ?", [personName]);
    for (const p of allPersons) {
      const term = this.getKinshipTerm(personName, p.name);
      if (term) {
        results.push({
          relative: p.name,
          termAtoB: term.term,           // fromPerson 称呼 toPerson
          termBtoA: term.reverse,         // toPerson 称呼 fromPerson
          category: term.category,
        });
      }
    }
    return results;
  }

  // ═══════════════════════════════════════════
  //  内部: 路径寻找
  // ═══════════════════════════════════════════

  private _findPersonIds(name: string): string[] {
    return this.query("SELECT id FROM nodes WHERE type = 'person' AND name = ?", [name])
      .map((r: any) => r.id);
  }

  private _getPersonInfo(nodeId: string): PersonNodeInfo | null {
    const rows = this.query("SELECT name, properties FROM nodes WHERE id = ?", [nodeId]);
    if (rows.length === 0) return null;
    const r = rows[0];
    let props: any = {};
    try { props = JSON.parse(r.properties || '{}'); } catch {}
    return {
      id: nodeId,
      name: r.name,
      gender: props.gender || null,
      age: props.age || props.birthYear || null,
      surname: (r.name || '?')[0],
    };
  }

  /** BFS 寻找两人间最短家族路径 */
  private _findKinshipPath(fromId: string, toId: string): KinshipStep[] | null {
    if (fromId === toId) return [];
    const visited = new Set<string>([fromId]);
    const queue: Array<{ nodeId: string; steps: KinshipStep[] }> = [{ nodeId: fromId, steps: [] }];

    while (queue.length > 0) {
      const { nodeId, steps } = queue.shift()!;
      const neighbors = this._getGraphNeighbors(nodeId);

      for (const nb of neighbors) {
        if (visited.has(nb.targetId)) continue;
        visited.add(nb.targetId);
        const newSteps = [...steps, nb];

        if (nb.targetId === toId) return newSteps;
        if (newSteps.length >= 5) continue; // 超过5跳，忽略
        queue.push({ nodeId: nb.targetId, steps: newSteps });
      }
    }
    return null;
  }

  /** 获取某节点的家族邻居边 */
  private _getGraphNeighbors(nodeId: string): KinshipStep[] {
    const FAMILY_EDGES = new Set([
      'mother_of','father_of','parent_of','child_of',
      'elder_sister_of','younger_sister_of','sister_of','brother_of','sibling_of',
      'elder_brother_of','younger_brother_of',
      'spouse_of', 'husband_of', 'wife_of',
      'grandfather_of','grandmother_of','grandchild_of',
      'aunt_of','uncle_of','niece_of','nephew_of','cousin_of',
    ]);
    // 🏛️ §十五: 社交边同等参与图谱遍历
    const SOCIAL_EDGES = new Set(Object.keys(SOCIAL_REVERSE));

    const steps: KinshipStep[] = [];
    // 出边
    for (const e of this.query(
      "SELECT target_id, relation FROM edges WHERE source_id = ?", [nodeId])) {
      if (FAMILY_EDGES.has(e.relation) || SOCIAL_EDGES.has(e.relation)) {
        const info = this._getPersonInfo(e.target_id);
        steps.push({
          fromId: nodeId, targetId: e.target_id, relation: e.relation,
          targetName: info?.name || '?', targetGender: info?.gender || null,
        });
      }
    }
    // 入边
    for (const e of this.query(
      "SELECT source_id, relation FROM edges WHERE target_id = ?", [nodeId])) {
      if (FAMILY_EDGES.has(e.relation) || SOCIAL_EDGES.has(e.relation)) {
        const info = this._getPersonInfo(e.source_id);
        steps.push({
          fromId: nodeId, targetId: e.source_id, relation: '_reverse_' + e.relation,
          targetName: info?.name || '?', targetGender: info?.gender || null,
        });
      }
    }
    return steps;
  }

  // ═══════════════════════════════════════════
  //  内部: 路径分类
  // ═══════════════════════════════════════════

  private _classifyKinshipPath(fromId: string, toId: string, path: KinshipStep[]): RelationPattern | null {
    if (path.length === 0) return { category: 'self' };
    if (path.length === 1) return this._classifyOneStep(path[0]);

    // ── 将路径压缩为结构签名 ──
    //    P=parent边, C=child边, S=sibling边, M=spouse边, A=aunt/uncle边, N=niece/nephew边
    const sig = path.map(s => {
      if (this._isParentEdge(s)) return 'P';
      if (this._isChildEdge(s)) return 'C';
      if (this._isSiblingEdge(s)) return 'S';
      if (this._isSpouseEdge(s)) return 'M';
      return '?';
    }).join('');

    // ── 两步路径 ──
    if (path.length === 2) {
      if (sig === 'PP') return { category: 'grandparent' };
      if (sig === 'CC') return { category: 'grandchild' };
      if (sig === 'CS' || sig === 'PS') return { category: 'aunt_uncle', lineage: this._inferLineage(path, fromId) };
      if (sig === 'SP' || sig === 'SC') return { category: 'niece_nephew', lineage: this._inferLineage(path, fromId) };
      if (sig === 'SS') return { category: 'sibling', sub: 'indirect' };
      if (sig.startsWith('M') && sig[1] === 'P') return { category: 'inlaw_parent' };
      if (sig.startsWith('M') && sig[1] === 'S') return { category: 'spouse_sibling' };
      if (sig === 'SM') return { category: 'inlaw_sibling' };
      if (sig === 'CM') return { category: 'inlaw_child_spouse' };
      if (sig[0] === 'P' && sig[1] === 'M') return { category: 'inlaw_parent' }; // 继父/母
    }

    // ── 三步路径 ──
    if (path.length === 3) {
      // 曾祖: C→P→P 或 P→P→P
      if (sig.match(/^(C|)PP$/) && sig.includes('PP')) return { category: 'great_grandparent' };
      // 曾孙: P→C→C
      if (sig === 'PCC') return { category: 'great_grandchild' };
      // 堂表亲 via 手足: C→P→S
      if (sig === 'CPS') return { category: 'aunt_uncle', lineage: this._inferLineage(path, fromId) };
      // 堂表亲 via 手足: S→P→C
      if (sig === 'SPC') return { category: 'niece_nephew', lineage: this._inferLineage(path, fromId) };
      // 堂表亲 via 手足→子: C→S→C
      if (sig === 'CSC') return { category: 'cousin', lineage: this._inferLineage(path, fromId) };
      // 姑父/姨父/婶婶/舅妈: C→P→S→M 无法一步描述...
      // instead: C→S→M = 姑父/姨父/婶婶/舅妈 (aunt/uncle→spouse)
      if (sig.match(/^(C|P|)SM$/)) return { category: 'inlaw_sibling_spouse', lineage: this._inferLineage(path, fromId) };
      // 叔公/姑婆/舅公/姨婆: P→P→S  或  C→P→P→S (4-hop)
      if (sig === 'PPS') return { category: 'grand_aunt_uncle', lineage: this._inferLineage(path, fromId) };
      // 侄孙/外甥孙: S→C→C
      if (sig === 'SCC') return { category: 'grand_niece_nephew', lineage: this._inferLineage(path, fromId) };
      // 连襟/妯娌: M→S→M
      if (sig === 'MSM') return { category: 'spouse_sibling', sub: 'inlaw' };
    }

    // ── 四步路径: 远房堂表/隔代表亲 ──
    if (path.length === 4) {
      // 堂叔/表叔 (grandparent's sibling's child): P→P→S→C
      if (sig === 'PPSC') return { category: 'second_cousin', lineage: 'paternal' };
      // 远房 cousin: C→P→S→C
      if (sig === 'CPSC') return { category: 'cousin', lineage: this._inferLineage(path, fromId) };
      // 叔公/姑婆 via C→P→P→S
      if (sig === 'CPPS') return { category: 'grand_aunt_uncle', lineage: this._inferLineage(path, fromId) };
      // 远房 cousin via sibling chain: C→S→P→C
      if (sig === 'CSPC') return { category: 'second_cousin', lineage: this._inferLineage(path, fromId) };
      // 姑父/姨父: C→P→S→M
      if (sig === 'CPSM') return { category: 'inlaw_sibling_spouse', lineage: this._inferLineage(path, fromId) };
      // 侄孙/外甥孙 via S→P→C→C
      if (sig === 'SPCC') return { category: 'grand_niece_nephew', lineage: this._inferLineage(path, fromId) };
    }

    // ── 5跳: 高祖辈 ──
    if (path.length === 5) {
      if (sig === 'PPPPP' || sig === 'CPPPP') return { category: 'great_grandparent', sub: 'great2' };
      if (sig === 'CCCCC' || sig === 'PCCCC') return { category: 'great_grandchild', sub: 'great2' };
    }

    return { category: 'relative' };
  }

  private _classifyOneStep(step: KinshipStep): RelationPattern | null {
    if (this._isParentEdge(step)) return { category: 'parent' };
    if (this._isChildEdge(step)) return { category: 'child' };
    if (this._isSiblingEdge(step)) return { category: 'sibling', sub: 'direct' };
    if (this._isSpouseEdge(step)) return { category: 'spouse' };
    // 🏛️ §十五: 社交关系分类
    if (Object.keys(SOCIAL_REVERSE).includes(step.relation)
        || step.relation.startsWith('_reverse_') && Object.keys(SOCIAL_REVERSE).includes(step.relation.replace('_reverse_',''))) {
      return { category: 'social', sub: step.relation.replace('_reverse_','') };
    }
    if (step.relation === 'aunt_of' || step.relation === 'uncle_of') {
      const fromS = this._getPersonInfo(step.fromId)?.surname;
      const toS = this._getPersonInfo(step.targetId)?.surname;
      return { category: 'aunt_uncle', lineage: (fromS && toS && fromS === toS) ? 'paternal' : 'maternal' };
    }
    if (step.relation === 'niece_of' || step.relation === 'nephew_of') {
      const fromS = this._getPersonInfo(step.fromId)?.surname;
      const toS = this._getPersonInfo(step.targetId)?.surname;
      return { category: 'niece_nephew', lineage: (fromS && toS && fromS === toS) ? 'paternal' : 'maternal' };
    }
    if (step.relation === 'cousin_of') {
      const fromS = this._getPersonInfo(step.fromId)?.surname;
      const toS = this._getPersonInfo(step.targetId)?.surname;
      return { category: 'cousin', lineage: (fromS && toS && fromS === toS) ? 'paternal' : 'maternal' };
    }
    if (step.relation === 'grandfather_of' || step.relation === 'grandmother_of')
      return { category: 'grandparent' };
    if (step.relation === 'grandchild_of') return { category: 'grandchild' };
    return null;
  }

  private _isParentEdge(step: KinshipStep): boolean {
    return ['mother_of','father_of','parent_of'].includes(step.relation) ||
           ['grandfather_of','grandmother_of'].includes(step.relation);
  }
  private _isChildEdge(step: KinshipStep): boolean {
    return step.relation === 'child_of' ||
           step.relation === '_reverse_mother_of' ||
           step.relation === '_reverse_father_of' ||
           step.relation === '_reverse_parent_of';
  }
  private _isSiblingEdge(step: KinshipStep): boolean {
    return ['elder_sister_of','younger_sister_of','sister_of','brother_of',
            'elder_brother_of','younger_brother_of','sibling_of'].includes(step.relation) ||
           step.relation.startsWith('_reverse_elder') || step.relation.startsWith('_reverse_younger') ||
           step.relation === '_reverse_sibling_of';
  }
  private _isSpouseEdge(step: KinshipStep): boolean {
    return ['spouse_of','husband_of','wife_of'].includes(step.relation) ||
           step.relation === '_reverse_spouse_of';
  }

  /** 推断父系/母系（基于路径中关键人物的姓氏匹配） */
  private _inferLineage(path: KinshipStep[], fromId: string): 'paternal' | 'maternal' | 'unknown' {
    // 找 path 中第一个 parent 节点，对比姓氏
    for (const step of path) {
      if (step.relation === 'child_of') {
        const targetInfo = this._getPersonInfo(step.targetId);
        const fromInfo = this._getPersonInfo(fromId);
        if (targetInfo && fromInfo && targetInfo.surname === fromInfo.surname)
          return 'paternal'; // 同姓 → 父系
        if (targetInfo && step.targetGender === 'female')
          return 'maternal'; // 母亲 → 母系
      }
    }
    return 'unknown';
  }

  // ═══════════════════════════════════════════
  //  内部: 称谓决策
  // ═══════════════════════════════════════════

  private _resolveTerm(from: PersonNodeInfo, to: PersonNodeInfo, pattern: RelationPattern): KinshipTerm {
    const fromGender = from.gender;
    const toGender = to.gender;
    const fromAge = typeof from.age === 'number' ? from.age : null;
    const toAge = typeof to.age === 'number' ? to.age : null;

    // 默认相对年龄: 如无数据，根据边类型推断
    const elderDefault = !fromAge || !toAge ? null : fromAge > toAge;

    // 辅助：推断父系/母系（姓氏比较）
    const detLineage = (p: RelationPattern): 'paternal'|'maternal' =>
      (p.lineage && p.lineage !== 'unknown') ? p.lineage as 'paternal'|'maternal'
      : (from.surname === to.surname ? 'paternal' : 'maternal');

    // 辅助：基于年龄+边类型推断长幼
    const isElder = elderDefault;

    switch (pattern.category) {
      // ── 自己 ──
      case 'self':
        return { term: '自己', reverse: '自己', category: 'self', generation: 0 };

      // ── 父母/子女 ──
      case 'parent': return {
        term: toGender === 'male' ? '儿子' : toGender === 'female' ? '女儿' : '子女',
        reverse: fromGender === 'male' ? '爸爸' : fromGender === 'female' ? '妈妈' : '父母',
        category: 'parent', generation: 1,
      };
      case 'child': return {
        term: toGender === 'male' ? '爸爸' : toGender === 'female' ? '妈妈' : '父母',
        reverse: fromGender === 'male' ? '儿子' : fromGender === 'female' ? '女儿' : '子女',
        category: 'child', generation: -1,
      };

      // ── 手足 ──
      case 'sibling': {
        const t = fromGender === 'male'
          ? (isElder === true ? '哥哥' : isElder === false ? '弟弟' : '兄弟')
          : fromGender === 'female'
          ? (isElder === true ? '姐姐' : isElder === false ? '妹妹' : '姐妹')
          : '手足';
        const r = toGender === 'male'
          ? (isElder === true ? '弟弟' : '哥哥')
          : toGender === 'female'
          ? (isElder === true ? '妹妹' : '姐姐')
          : '手足';
        return { term: t, reverse: r, category: 'sibling', generation: 0 };
      }

      // ── 配偶 ──
      case 'spouse': return {
        term: fromGender === 'male' ? '老公' : fromGender === 'female' ? '老婆' : '配偶',
        reverse: toGender === 'male' ? '老公' : toGender === 'female' ? '老婆' : '配偶',
        category: 'spouse', generation: 0,
      };

      // ── 爷奶/祖辈 ──
      case 'grandparent': return {
        term: fromGender === 'male' ? '爷爷' : fromGender === 'female' ? '奶奶' : '祖辈',
        reverse: toGender === 'male' ? '孙子' : toGender === 'female' ? '孙女' : '孙辈',
        category: 'grandparent', generation: 2,
      };
      case 'grandchild': return {
        term: toGender === 'male' ? '孙子' : toGender === 'female' ? '孙女' : '孙辈',
        reverse: fromGender === 'male' ? '爷爷' : fromGender === 'female' ? '奶奶' : '祖辈',
        category: 'grandchild', generation: -2,
      };

      // ── 曾祖/曾孙 ──
      case 'great_grandparent': {
        const sub = pattern.sub || '';
        const prefix = sub === 'great2' ? '高' : '曾';
        return {
          term: fromGender === 'male' ? (prefix + '祖父') : fromGender === 'female' ? (prefix + '祖母') : (prefix + '祖'),
          reverse: toGender === 'male' ? (sub === 'great2' ? '玄孙' : '曾孙') : toGender === 'female' ? (sub === 'great2' ? '玄孙女' : '曾孙女') : (sub === 'great2' ? '玄孙辈' : '曾孙辈'),
          category: 'great_grandparent', generation: sub === 'great2' ? 4 : 3,
        };
      }
      case 'great_grandchild': {
        const sub = pattern.sub || '';
        const prefix = sub === 'great2' ? '玄' : '曾';
        return {
          term: toGender === 'male' ? (prefix + '孙') : toGender === 'female' ? (prefix + '孙女') : (prefix + '孙辈'),
          reverse: fromGender === 'male' ? (sub === 'great2' ? '高祖' : '曾祖父') : fromGender === 'female' ? (sub === 'great2' ? '高祖母' : '曾祖母') : (sub === 'great2' ? '高祖' : '曾祖'),
          category: 'great_grandchild', generation: sub === 'great2' ? -4 : -3,
        };
      }

      // ── 叔伯姑舅姨 (父母辈旁系) ──
      case 'aunt_uncle': {
        const L = detLineage(pattern);
        const fromMale = fromGender === 'male', fromFemale = fromGender === 'female';
        const toMale = toGender === 'male', toFemale = toGender === 'female';
        // from(长辈)叫to(晚辈)
        const t = fromMale
          ? (L === 'paternal' ? '叔叔' : '舅舅')
          : fromFemale
          ? (L === 'paternal' ? '姑姑' : '姨妈')
          : (L === 'paternal' ? '叔叔/姑姑' : '舅舅/姨妈');
        // to(晚辈)叫from(长辈)
        const r = toMale
          ? (L === 'paternal' ? '侄子' : '外甥')
          : toFemale
          ? (L === 'paternal' ? '侄女' : '外甥女')
          : (L === 'paternal' ? '侄辈' : '外甥辈');
        return { term: t, reverse: r, category: 'aunt_uncle', generation: 1 };
      }

      // ── 侄/甥辈 ──
      case 'niece_nephew': {
        const L = detLineage(pattern);
        const toMale = toGender === 'male', toFemale = toGender === 'female';
        const fromMale = fromGender === 'male', fromFemale = fromGender === 'female';
        const t = toMale
          ? (L === 'paternal' ? '侄子' : '外甥')
          : toFemale
          ? (L === 'paternal' ? '侄女' : '外甥女')
          : (L === 'paternal' ? '侄辈' : '外甥辈');
        const r = fromMale
          ? (L === 'paternal' ? '叔叔' : '舅舅')
          : fromFemale
          ? (L === 'paternal' ? '姑姑' : '姨妈')
          : (L === 'paternal' ? '叔叔/姑姑' : '舅舅/姨妈');
        return { term: t, reverse: r, category: 'niece_nephew', generation: -1 };
      }

      // ── 堂表亲 ──
      case 'cousin': {
        const L = detLineage(pattern);
        const fromMale = fromGender === 'male', fromFemale = fromGender === 'female';
        const toMale = toGender === 'male', toFemale = toGender === 'female';
        const elder = isElder;
        const t = fromMale
          ? (L === 'paternal' ? (elder === true ? '堂兄' : elder === false ? '堂弟' : '堂兄弟') : (elder === true ? '表兄' : elder === false ? '表弟' : '表兄弟'))
          : fromFemale
          ? (L === 'paternal' ? (elder === true ? '堂姐' : elder === false ? '堂妹' : '堂姐妹') : (elder === true ? '表姐' : elder === false ? '表妹' : '表姐妹'))
          : (L === 'paternal' ? '堂亲' : '表亲');
        const r = toMale
          ? (L === 'paternal' ? '堂兄弟' : '表兄弟')
          : toFemale
          ? (L === 'paternal' ? '堂姐妹' : '表姐妹')
          : (L === 'paternal' ? '堂亲' : '表亲');
        return { term: t, reverse: r, category: 'cousin', generation: 0 };
      }

      // ── 叔公/姑婆/舅公/姨婆 (祖辈旁系) ──
      case 'grand_aunt_uncle': {
        const L = detLineage(pattern);
        const t = fromGender === 'male'
          ? (L === 'paternal' ? '叔公' : '舅公')
          : fromGender === 'female'
          ? (L === 'paternal' ? '姑婆' : '姨婆')
          : (L === 'paternal' ? '叔公/姑婆' : '舅公/姨婆');
        const r = toGender === 'male'
          ? (L === 'paternal' ? '侄孙' : '外甥孙')
          : toGender === 'female'
          ? (L === 'paternal' ? '侄孙女' : '外甥孙女')
          : (L === 'paternal' ? '侄孙辈' : '外甥孙辈');
        return { term: t, reverse: r, category: 'grand_aunt_uncle', generation: 2 };
      }

      // ── 侄孙/外甥孙辈 ──
      case 'grand_niece_nephew': {
        const L = detLineage(pattern);
        const t = toGender === 'male'
          ? (L === 'paternal' ? '侄孙' : '外甥孙')
          : toGender === 'female'
          ? (L === 'paternal' ? '侄孙女' : '外甥孙女')
          : (L === 'paternal' ? '侄孙辈' : '外甥孙辈');
        const r = fromGender === 'male'
          ? (L === 'paternal' ? '叔公' : '舅公')
          : fromGender === 'female'
          ? (L === 'paternal' ? '姑婆' : '姨婆')
          : (L === 'paternal' ? '叔公/姑婆' : '舅公/姨婆');
        return { term: t, reverse: r, category: 'grand_niece_nephew', generation: -2 };
      }

      // ── 远房堂表 (second cousin / 堂叔/表叔) ──
      case 'second_cousin': {
        const L = detLineage(pattern);
        // from 是 to 的堂叔/表叔 (长一辈的远房 cousin)
        const t = fromGender === 'male'
          ? (L === 'paternal' ? '堂叔' : '表叔')
          : fromGender === 'female'
          ? (L === 'paternal' ? '堂姑' : '表姑')
          : (L === 'paternal' ? '堂叔/堂姑' : '表叔/表姑');
        const r = toGender === 'male'
          ? (L === 'paternal' ? '堂侄' : '表侄')
          : toGender === 'female'
          ? (L === 'paternal' ? '堂侄女' : '表侄女')
          : (L === 'paternal' ? '堂侄辈' : '表侄辈');
        return { term: t, reverse: r, category: 'second_cousin', generation: 1 };
      }

      // ── 姻亲: 公婆/岳父母 (配偶的父母) ──
      case 'inlaw_parent': {
        const t = fromGender === 'male' ? '岳父' : fromGender === 'female' ? '岳母'
          : toGender === 'male' ? '公公' : '婆婆';
        const r = toGender === 'male' ? '女婿' : toGender === 'female' ? '儿媳' : '女婿/儿媳';
        return { term: t, reverse: r, category: 'inlaw_parent', generation: 1 };
      }

      // ── 姻亲: 大/小姑子、大/小叔子、大/小姨子、大/小舅子 (配偶的手足) ──
      case 'spouse_sibling': {
        // from 的配偶 是 to 的手足 → from叫to 是 "配偶的手足"
        // 反过来: to 叫 from 是 "手足的配偶"
        const t = fromGender === 'male'
          ? (toGender === 'male' ? '大舅子/小舅子' : '大姨子/小姨子')
          : fromGender === 'female'
          ? (toGender === 'male' ? '大伯子/小叔子' : '大姑子/小姑子')
          : '配偶的手足';
        const r = toGender === 'male'
          ? (fromGender === 'male' ? '姐夫/妹夫' : '姐夫/妹夫')
          : toGender === 'female'
          ? (fromGender === 'male' ? '嫂子/弟媳' : '嫂子/弟媳')
          : '手足的配偶';
        return { term: t, reverse: r, category: 'spouse_sibling', generation: 0 };
      }

      // ── 姻亲: 姐夫/嫂子/弟媳/妹夫 (手足的配偶) ──
      case 'inlaw_sibling_spouse': {
        const L = detLineage(pattern);
        // from 是 to 的手足的配偶 → from叫to:
        // from 的姐妹的丈夫 = 姐夫/妹夫
        // from 的兄弟的妻子 = 嫂子/弟媳
        // 反过来: to 是从 from 角度看的手足的配偶的手足
        const t = fromGender === 'male'
          ? (L === 'paternal' ? '堂姐夫/堂妹夫' : '表姐夫/表妹夫')
          : fromGender === 'female'
          ? (L === 'paternal' ? '堂嫂/堂弟媳' : '表嫂/表弟媳')
          : (L === 'paternal' ? '堂亲配偶' : '表亲配偶');
        const r = toGender === 'male'
          ? (L === 'paternal' ? '堂兄/堂弟' : '表兄/表弟')
          : toGender === 'female'
          ? (L === 'paternal' ? '堂姐/堂妹' : '表姐/表妹')
          : (L === 'paternal' ? '堂亲' : '表亲');
        return { term: t, reverse: r, category: 'inlaw_sibling_spouse', generation: 0 };
      }

      // ── 姻亲: 女婿/儿媳 (子女的配偶) ──
      case 'inlaw_child_spouse': return {
        term: toGender === 'male' ? '女婿' : toGender === 'female' ? '儿媳' : '子女的配偶',
        reverse: fromGender === 'male' ? '岳父' : fromGender === 'female' ? '岳母' : '配偶的父母',
        category: 'inlaw_child_spouse', generation: -1,
      };

      // ── 姻亲: 姐夫/嫂子 (手足的配偶——直接路径) ──
      case 'inlaw_sibling': {
        const fromMale = fromGender === 'male', fromFemale = fromGender === 'female';
        const toMale = toGender === 'male', toFemale = toGender === 'female';
        // from 的手足(to)的配偶 = from叫to:
        if (toMale) {
          // to 是男性 → 他是姐姐的丈夫(姐夫)或妹妹的丈夫(妹夫)
          const t = isElder === true ? '姐夫' : isElder === false ? '妹夫' : '姐/妹夫';
          const r = fromMale ? '小舅子' : fromFemale ? '小姨子' : '手/足的配偶';
          return { term: t, reverse: r, category: 'inlaw_sibling', generation: 0 };
        }
        if (toFemale) {
          // to 是女性 → 她是哥哥的妻子(嫂子)或弟弟的妻子(弟媳)
          const t = isElder === true ? '嫂子' : isElder === false ? '弟媳' : '嫂/弟媳';
          const r = fromMale ? '小叔子' : fromFemale ? '小姑子' : '手/足的配偶';
          return { term: t, reverse: r, category: 'inlaw_sibling', generation: 0 };
        }
        return { term: '姻亲', reverse: '姻亲', category: 'inlaw_sibling', generation: 0 };
      }

      case 'social':
        const sRel = SOCIAL_LABEL_CN[pattern.sub || ''] || '社交关系';
        return { term: sRel, reverse: sRel, category: 'social', generation: 0 };

      default:
        return { term: '亲属', reverse: '亲属', category: 'relative', generation: 0 };
    }
  }

  /**
   * v1.1: 从备份文件恢复图谱（轻量回滚）
   * 恢复前自动备份当前版本，恢复后自行校验完整性
   */
  async restoreFromBackup(backupPath: string): Promise<{ success: boolean; error?: string; preBackupPath?: string; verified: boolean }> {
    const { existsSync, copyFileSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    // 1. 自动备份当前版本
    const preBackupPath = this.dbPath + '.pre-restore.' + Date.now() + '.bak';
    try {
      const currentData = this.db!.export();
      writeFileSync(preBackupPath, Buffer.from(currentData));
    } catch (e) {
      return { success: false, error: `当前版本备份失败: ${e}`, preBackupPath, verified: false };
    }

    // 2. 检查备份文件
    if (!existsSync(backupPath)) {
      return { success: false, error: '备份文件不存在', preBackupPath, verified: false };
    }

    // 3. 验证备份文件可读性
    try {
      const SQL = await initSqlJs();
      const backupData = await import('node:fs').then(fs => fs.readFileSync(backupPath));
      const testDb = new SQL.Database(backupData);
      const nodes = testDb.exec('SELECT COUNT(*) as cnt FROM nodes');
      const edges = testDb.exec('SELECT COUNT(*) as cnt FROM edges');
      const nodeCnt = nodes[0]?.values[0]?.[0] || 0;
      const edgeCnt = edges[0]?.values[0]?.[0] || 0;
      testDb.close();
      if (nodeCnt === 0) {
        return { success: false, error: '备份文件无效（nodes 表为空）', preBackupPath, verified: false };
      }
    } catch (e) {
      return { success: false, error: `备份文件不可读: ${e}`, preBackupPath, verified: false };
    }

    // 4. 替换当前库
    try {
      copyFileSync(backupPath, this.dbPath);
      // 重新加载
      const SQL = await initSqlJs();
      const buffer = await import('node:fs').then(fs => fs.readFileSync(this.dbPath));
      this.db = new SQL.Database(buffer);
      console.log(`[FamilyGraph] 已从备份恢复: ${backupPath}`);
    } catch (e) {
      return { success: false, error: `恢复失败: ${e}`, preBackupPath, verified: false };
    }

    return { success: true, preBackupPath, verified: true };
  }

  /**
   * v1.1: 获取备份状态统计
   */
  getBackupStats(): { personCount: number; edgeCount: number; reverseEdgeRatio: number } {
    const persons = this.query("SELECT COUNT(*) as cnt FROM nodes WHERE type = 'person'");
    const edges = this.query('SELECT COUNT(*) as cnt FROM edges');
    const edgeCnt = edges[0]?.cnt ?? 0;

    // 计算反向边比例：自反关系（spouse_of/friend_of）在每个 pair 中应出现 2 次
    const pairsWithBoth = this.query(
      `SELECT COUNT(*) as cnt FROM (
        SELECT e1.source_id, e1.target_id FROM edges e1
        INNER JOIN edges e2 ON e1.source_id = e2.target_id AND e1.target_id = e2.source_id
        WHERE e1.relation != e2.relation
        GROUP BY e1.source_id, e1.target_id
      )`
    );
    const bothCount = pairsWithBoth[0]?.cnt ?? 0;
    const totalPairs = this.query(
      `SELECT COUNT(*) as cnt FROM (SELECT DISTINCT source_id, target_id FROM edges)`
    );
    const pairCnt = totalPairs[0]?.cnt ?? 1;

    return {
      personCount: persons[0]?.cnt ?? 0,
      edgeCount: edgeCnt,
      reverseEdgeRatio: Math.round(bothCount / Math.max(1, pairCnt) * 100) / 100,
    };
  }

  /**
   * v1.1: 使用 EntityValidator 校验档案字段
   */
  validateDossierField(field: string, value: string): { valid: boolean; reason?: string } {
    switch (field) {
      case 'name': return validatePersonName(value);
      case 'relation': return validateRelationType(value);
      case 'gender':
        if (value && !['男', '女', '未知'].includes(value)) return { valid: false, reason: '性别只能为男/女/未知' };
        return { valid: true };
      case 'traits':
        if (value && value.length > 10) return { valid: false, reason: '性格标签过长' };
        return { valid: true };
      default:
        if (value && value.length > 200) return { valid: false, reason: '字段值超过200字符' };
        return { valid: true };
    }
  }

  /**
   * 获取人物画像摘要（用于对话注入）
   */
  getPersonSummary(personName: string): string | null {
    const profile = this.getPersonProfile(personName);
    if (!profile) return null;
    const parts: string[] = [personName];
    if (profile.relation_to_user) parts.push(profile.relation_to_user);
    if (profile.occupation) parts.push('做' + profile.occupation);
    if (profile.traits && profile.traits.length > 0) parts.push('性格' + profile.traits.join('/'));
    return parts.join('，');
  }

  /**
   * P0-3: 获取所有已知人员姓名（用于幻觉校验）
   */
  getAllPersonNames(): string[] {
    const rows = this.query('SELECT name FROM nodes WHERE type = ?', ['person']);
    return (rows as any[]).map(r => r.name as string).filter(Boolean);
  }

  /**
   * S2-3: 清洗关系词脏节点
   * 删除「老公/老婆/爸爸/妈妈/同事/朋友」等关系词被误作为人名创建的节点
   */
  async cleanDirtyNodes(): Promise<number> {
    const dirtyWords = ['老公','老婆','爸爸','妈妈','爷爷','奶奶','外公','外婆',
      '哥哥','弟弟','姐姐','妹妹','儿子','女儿','同事','同学','朋友','室友',
      '老板','上司','领导','客户','老师','医生','邻居','合伙人'];
    let cleaned = 0;

    for (const word of dirtyWords) {
      const nodes = this.query('SELECT id FROM nodes WHERE name = ? AND type = ?', [word, 'person']);
      for (const node of nodes) {
        const profile = this.getPersonProfile(word);
        // 仅当该节点没有有效的人物画像信息时删除（仅关系词，无其他属性）
        if (profile && !profile.appearance && !profile.body_features && !profile.occupation
            && !profile.traits?.length && !profile.description && !profile.interests?.length) {
          // 删除关联边
          this.run('DELETE FROM edges WHERE source_id = ? OR target_id = ?', [node.id, node.id]);
          this.run('DELETE FROM nodes WHERE id = ?', [node.id]);
          cleaned++;
        }
      }
    }
    if (cleaned > 0) {
      console.log(`[FamilyGraph] 清洗 ${cleaned} 个脏节点`);
      this.markDirty(true);
    }
    return cleaned;
  }

  /**
   * S2-3: 检索人物时联动返回档案 + 关联记忆
   * 返回人物画像 + 关联的 edges 列表（供 chat.ts 构建检索）
   */
  searchPersonWithMemories(personName: string): {
    profile: PersonProfile | null;
    relations: Array<{ name: string; relation: string }>;
  } {
    const profile = this.getPersonProfile(personName);
    const relations: Array<{ name: string; relation: string }> = [];

    if (profile) {
      const nodes = this.query('SELECT id FROM nodes WHERE name = ? AND type = ?', [personName, 'person']);
      if (nodes.length > 0) {
        const nodeId = nodes[0].id;
        // 出边
        const outgoing = this.query(
          `SELECT n.name, e.relation FROM edges e JOIN nodes n ON e.target_id = n.id WHERE e.source_id = ?`,
          [nodeId]
        );
        for (const e of outgoing) {
          relations.push({ name: e.name, relation: e.relation });
        }
        // 入边
        const incoming = this.query(
          `SELECT n.name, e.relation FROM edges e JOIN nodes n ON e.source_id = n.id WHERE e.target_id = ?`,
          [nodeId]
        );
        for (const e of incoming) {
          relations.push({ name: e.name, relation: e.relation });
        }
      }
    }

    return { profile, relations };
  }

  /**
   * S2-3: 特征独立建边
   * 为人物外貌/身体特征创建独立的 object 节点并关联
   */
  async addFeatureEdge(personName: string, featureName: string, featureType: 'appearance' | 'body' | 'style' | 'trait'): Promise<void> {
    const personNodes = this.query('SELECT id FROM nodes WHERE name = ? AND type = ?', [personName, 'person']);
    if (personNodes.length === 0) return;
    const personId = personNodes[0].id;

    // 查找或创建特征节点
    const featureNodes = this.query('SELECT id FROM nodes WHERE name = ? AND type = ?', [featureName, 'object']);
    let featureId: string;
    if (featureNodes.length > 0) {
      featureId = featureNodes[0].id;
    } else {
      featureId = uid();
      await this.addNode({ id: featureId, type: 'object', name: featureName });
    }

    // 建边
    const relation = featureType === 'appearance' ? 'has_appearance' :
      featureType === 'body' ? 'has_body_feature' :
      featureType === 'style' ? 'has_style' : 'has_trait';
    const existing = this.query(
      'SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND relation = ?',
      [personId, featureId, relation]
    );
    if (existing.length === 0) {
      await this.addEdge({ id: uid(), source_id: personId, target_id: featureId, relation });
      console.log("[FamilyGraph] 特征建边 [ok]"); // details sanitized
    }
  }

  // ════════════════════════════════════════════════════════════
  // 双库统一兼容层（返回 entity_relations 兼容格式）
  // ════════════════════════════════════════════════════════════

  /**
   * 获取指定人物的关联人物（兼容 entity_relations 格式）
   * 返回 {name, relation, strength}[] 格式
   */
  getRelatedPersons(personName: string): Array<{ name: string; relation: string; strength: number }> {
    const results: Array<{ name: string; relation: string; strength: number }> = [];
    const nodes = this.query('SELECT id FROM nodes WHERE name = ? AND type = ?', [personName, 'person']);
    if (nodes.length === 0) return results;

    const nodeId = nodes[0].id;

    // 出边（此人认识谁）
    const outgoing = this.query(
      `SELECT n.name, e.relation FROM edges e JOIN nodes n ON e.target_id = n.id WHERE e.source_id = ?`,
      [nodeId]
    );
    for (const e of outgoing) {
      results.push({ name: e.name, relation: e.relation, strength: 1.0 });
    }

    // 入边（谁认识此人）
    const incoming = this.query(
      `SELECT n.name, e.relation FROM edges e JOIN nodes n ON e.source_id = n.id WHERE e.target_id = ?`,
      [nodeId]
    );
    for (const e of incoming) {
      results.push({ name: e.name, relation: e.relation, strength: 1.0 });
    }

    return results;
  }

  /**
   * 批量获取关联人物（兼容 findRelatedEntities 格式）
   * 对每个实体名查 FamilyGraph 并合并结果
   */
  getRelatedPersonsBatch(entityNames: string[], minStrength = 0.3): Array<{ name: string; relation: string; strength: number }> {
    const results: Array<{ name: string; relation: string; strength: number }> = [];
    const seen = new Set<string>();

    for (const name of entityNames) {
      const rels = this.getRelatedPersons(name);
      for (const r of rels) {
        if (!seen.has(r.name) && r.strength >= minStrength) {
          seen.add(r.name);
          results.push(r);
        }
      }
      // 如果该名字本身就是人物节点，也算入关联
      if (!seen.has(name) && entityNames.includes(name)) {
        const profile = this.getPersonProfile(name);
        if (profile?.relation_to_user) {
          seen.add(name);
          results.push({ name, relation: 'known_person', strength: 0.5 });
        }
      }
    }
    return results;
  }

  /**
   * N跳关联人物检索（兼容 findRelatedEntitiesN 格式）
   */
  getRelatedPersonsN(entityNames: string[], maxHops: 1|2|3 = 1, minStrength = 0.3): Array<{ name: string; relation: string; strength: number; hop: number }> {
    const results: Array<{ name: string; relation: string; strength: number; hop: number }> = [];
    const seen = new Set<string>(entityNames);
    let currentLayer = entityNames.filter(n => {
      const nodes = this.query('SELECT id FROM nodes WHERE name = ? AND type = ?', [n, 'person']);
      return nodes.length > 0;
    });
    let hop = 1;

    while (hop <= maxHops && currentLayer.length > 0 && results.length < 8) {
      const nextLayer: string[] = [];
      for (const name of currentLayer) {
        const rels = this.getRelatedPersons(name);
        for (const r of rels) {
          if (seen.has(r.name)) continue;
          seen.add(r.name);
          if (r.strength >= minStrength) {
            results.push({ ...r, hop });
            nextLayer.push(r.name);
            if (results.length >= 8) break;
          }
        }
        if (results.length >= 8) break;
      }
      currentLayer = nextLayer;
      hop++;
    }

    return results;
  }

  /**
   * 获取图谱统计信息（用于健康检查）
   */
  // ═══════════════════════════════════════════════════
  //  🛡️ §十六: FG→黑钻同步 + 完整性守护
  // ═══════════════════════════════════════════════════

  /**
   * 🏛️ §十六: 将 FG 核心人物档案和关键关系同步到黑钻库
   * ==================================================
   * FG 数据属于客观事实，与对话记忆同级，纳入钙化休眠体系。
   * 仅同步 completeness ≥ 0.3 的人物（有实质性档案内容），
   * 以及所有家族关系边（非 acquaintance_of）。
   *
   * @param sqlite fusion_memory.db 的 SQLiteAdapter（由 server.ts 传入）
   * @returns 同步计数
   */
  syncToBlackDiamond(sqlite: any, options?: { force?: boolean }): { profiles: number; relations: number; skipped: number } {
    let profiles = 0, relations = 0, skipped = 0;

    // ── ① 人物档案 → 黑钻 ──
    const allPersons = this.query("SELECT id, name, properties FROM nodes WHERE type = 'person'");
    for (const node of allPersons) {
      try {
        const props = JSON.parse(node.properties || '{}');
        const completeness = props.completeness || 0;
        if (completeness < 0.3 && !options?.force) { skipped++; continue; }

        const summary = this._buildBlackDiamondSummary(node.name, props);
        if (!summary) { skipped++; continue; }

        // 幂等：已同步的跳过（通过 tags 中的 fg_person 标记）
        const existing = (sqlite.queryAll?.("SELECT id FROM black_diamond WHERE tags LIKE '%\"fg_person\"%' AND summary LIKE ?", [`%${node.name}%`]) as any[]) || [];
        if (existing.length > 0 && !options?.force) { skipped++; continue; }

        const emotionTag = props.gender === 'female' ? '亲密' : props.gender === 'male' ? '尊重' : '中性';
        const calcium = Math.min(3, Math.floor(completeness * 5)); // completeness 0-1 → calcium 0-3

        sqlite.writeRaw(
          `INSERT OR REPLACE INTO black_diamond (id, summary, emotion_tag, source_id, calcium_level, recall_count, tags, notes, created_at, updated_at, emotion_vector, namespace, entry_channel, status)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'default', 'fg_sync', 'active')`,
          [
            `fg_${node.name}_${Date.now().toString(36)}`,
            summary,
            emotionTag,
            null, // 无 source_id（不是从 memories 表晋升的）
            calcium,
            JSON.stringify(['fg_person', `person:${node.name}`, `calcium:${calcium}`, `completeness:${Math.round(completeness * 100)}%`]),
            `[FG人物档案] ${node.name} · 完整度${Math.round(completeness * 100)}%`,
            new Date().toISOString(), new Date().toISOString(),
            null,
          ],
        );
        profiles++;
      } catch { skipped++; }
    }

    // ── ② 核心关系 → 黑钻 ──
    const keyRelations = new Set(['mother_of','father_of','parent_of','child_of',
      'spouse_of','elder_sister_of','younger_sister_of','sister_of','brother_of','sibling_of',
      'elder_brother_of','younger_brother_of','grandfather_of','grandmother_of']);
    const allEdges = this.query("SELECT source_id, target_id, relation FROM edges");
    for (const edge of allEdges) {
      if (!keyRelations.has(edge.relation)) continue;
      const src = this._getPersonInfo(edge.source_id);
      const tgt = this._getPersonInfo(edge.target_id);
      if (!src || !tgt) continue;

      const summary = `[FG家族关系] ${src.name} 是 ${tgt.name} 的${RELATION_LABEL_CN[edge.relation] || edge.relation}`;
      const relId = `fg_rel_${src.name}_${tgt.name}_${edge.relation}`.replace(/[^a-zA-Z0-9一-鿿_]/g, '_');

      sqlite.writeRaw(
        `INSERT OR REPLACE INTO black_diamond (id, summary, emotion_tag, source_id, calcium_level, recall_count, tags, notes, created_at, updated_at, emotion_vector, namespace, entry_channel, status)
         VALUES (?, ?, '亲密', ?, 3, 0, ?, ?, ?, ?, NULL, 'default', 'fg_sync', 'active')`,
        [
          relId,
          summary,
          null,
          JSON.stringify(['fg_relation', `family`, edge.relation, `from:${src.name}`, `to:${tgt.name}`]),
          `[FG关系] ${src.name}→${tgt.name} (${edge.relation})`,
          new Date().toISOString(), new Date().toISOString(),
        ],
      );
      relations++;
    }

    if (profiles + relations > 0) {
      console.log(`[FamilyGraph] 黑钻同步: ${profiles} 人 + ${relations} 关系`);
    }
    return { profiles, relations, skipped };
  }

  /** 构建黑钻摘要文本 */
  private _buildBlackDiamondSummary(name: string, props: any): string | null {
    const parts: string[] = [];
    const rel = props.relation_to_user;
    const age = props.birthYear ? `${new Date().getFullYear() - props.birthYear}岁` : props.age ? `${props.age}岁` : null;
    const occ = props.occupation;
    const traits = props.traits?.length ? props.traits.slice(0, 3).join('、') : null;
    const gender = props.gender === 'male' ? '男' : props.gender === 'female' ? '女' : null;

    if (gender) parts.push(gender);
    if (age) parts.push(age);
    if (rel) parts.push(rel);
    if (occ) parts.push(occ);
    if (traits) parts.push(`性格${traits}`);

    return parts.length > 0 ? `【${name}】${parts.join('，')}` : null;
  }

  /**
   * 🛡️ §十六: FG 完整性守护闸门
   * ==========================
   * 启动时自动执行。任何一项不通过→禁止系统进入生产模式。
   */
  fgIntegrityGuard(): { healthy: boolean; checks: Array<{ name: string; passed: boolean; detail: string }>; errors: string[] } {
    // 🔴 V3.3: 先清理残余自指边（inferFamilyLinks 可能产生）
    this.run('DELETE FROM edges WHERE source_id = target_id');

    const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
    const errors: string[] = [];

    // ① 核心表存在
    const nodeCount = this.query("SELECT COUNT(*) as cnt FROM nodes")[0]?.cnt || 0;
    const edgeCount = this.query("SELECT COUNT(*) as cnt FROM edges")[0]?.cnt || 0;
    checks.push({
      name: '核心表非空', passed: nodeCount > 0 && edgeCount > 0,
      detail: `nodes=${nodeCount} edges=${edgeCount}`,
    });
    if (nodeCount === 0) errors.push('nodes 表为空——FG 数据丢失');
    if (edgeCount === 0) errors.push('edges 表为空——所有家族关系丢失');

    // ② "我"节点存在
    const meCount = this.query("SELECT COUNT(*) as cnt FROM nodes WHERE name = '我' AND type = 'person'")[0]?.cnt || 0;
    checks.push({
      name: '"我"节点存在', passed: meCount > 0,
      detail: `me nodes: ${meCount}`,
    });
    if (meCount === 0) errors.push('"我"节点丢失——FG 核心身份不可用');

    // ③ 无自指边
    const selfLoops = this.query("SELECT COUNT(*) as cnt FROM edges WHERE source_id = target_id")[0]?.cnt || 0;
    checks.push({
      name: '无自指边', passed: selfLoops === 0,
      detail: `self-loops: ${selfLoops}`,
    });
    if (selfLoops > 0) errors.push(`发现 ${selfLoops} 条自指边——数据结构异常`);

    // ④ 家族反向边完整性
    const missingRev = this.query(
      "SELECT COUNT(*) as cnt FROM edges e1 WHERE e1.relation IN ('mother_of','father_of','elder_sister_of','younger_sister_of','elder_brother_of','younger_brother_of','aunt_of','uncle_of','niece_of','nephew_of') AND NOT EXISTS (SELECT 1 FROM edges e2 WHERE e2.source_id=e1.target_id AND e2.target_id=e1.source_id)"
    )[0]?.cnt || 0;
    checks.push({
      name: '家族反向边完整', passed: missingRev === 0,
      detail: `missing: ${missingRev}`,
    });
    if (missingRev > 0) errors.push(`${missingRev} 条家族边缺少反向边`);

    // ⑤ entity_relations 无"姐妹"污染（仅当 sqlite 可用时）
    // 此检查依赖外部 fusion_memory.db，仅作为信息输出不阻断启动

    // ⑥ 所有人有档案
    const totalPersons = this.query("SELECT COUNT(*) as cnt FROM nodes WHERE type = 'person'")[0]?.cnt || 0;
    const withName = this.query("SELECT COUNT(*) as cnt FROM nodes WHERE type = 'person' AND name IS NOT NULL AND name != ''")[0]?.cnt || 0;
    checks.push({
      name: '所有人有姓名', passed: withName === totalPersons,
      detail: `${withName}/${totalPersons}`,
    });
    if (withName < totalPersons) errors.push(`${totalPersons - withName} 人缺少姓名`);

    // ⑥ V3.2: 全部 person 节点有合法户籍 UUID
    // V2.0: 接受 TXS-9位纯流水号 或 旧格式(A-00001等)
    const personsWithoutUUID = this.query(
      "SELECT COUNT(*) as cnt FROM nodes WHERE type = 'person' AND (uuid IS NULL OR uuid = '' OR (uuid NOT LIKE 'TXS-%' AND uuid NOT LIKE '_-_____'))"
    )[0]?.cnt || 0;
    checks.push({
      name: '全部节点有合法UUID', passed: personsWithoutUUID === 0,
      detail: personsWithoutUUID === 0 ? `${withName}/${withName}` : `缺失: ${personsWithoutUUID}/${withName}`,
    });
    if (personsWithoutUUID > 0) errors.push(`${personsWithoutUUID} 个 person 节点缺少合法户籍 UUID`);

    // ⑦ V3.3: 全部 person 节点有 entity_source
    const withoutSource = this.query(
      "SELECT COUNT(*) as cnt FROM nodes WHERE type = 'person' AND (entity_source IS NULL OR entity_source = '')"
    )[0]?.cnt || 0;
    checks.push({
      name: '全部节点有entity_source', passed: withoutSource === 0,
      detail: withoutSource === 0 ? `${totalPersons}/${totalPersons}` : `缺: ${withoutSource}/${totalPersons}`,
    });
    if (withoutSource > 0) errors.push(`${withoutSource} 个节点缺少 entity_source`);

    // ⑧ V3.3: 全部 person 节点有合法 status
    const badStatus = this.query(
      "SELECT COUNT(*) as cnt FROM nodes WHERE type = 'person' AND (status IS NULL OR status NOT IN ('active','dormant','archived','deceased'))"
    )[0]?.cnt || 0;
    checks.push({
      name: '全部节点status合法', passed: badStatus === 0,
      detail: badStatus === 0 ? `${totalPersons}/${totalPersons}` : `非法: ${badStatus}`,
    });
    if (badStatus > 0) errors.push(`${badStatus} 个节点 status 非法`);

    // ⑨ V3.3: social_group_genes 非空
    const withoutSocial = this.query(
      "SELECT COUNT(*) as cnt FROM nodes WHERE type = 'person' AND (social_group_genes IS NULL OR social_group_genes = '')"
    )[0]?.cnt || 0;
    checks.push({
      name: 'social_group_genes非空', passed: withoutSocial === 0,
      detail: withoutSocial === 0 ? `${totalPersons}/${totalPersons}` : `空: ${withoutSocial}`,
    });
    if (withoutSocial > 0) errors.push(`${withoutSocial} 个节点 social_group_genes 为空`);

    // ⑩ V3.3: A 类节点必须有 family_edge 到'我'
    const aWithoutEdge = this.query(
      "SELECT COUNT(*) as cnt FROM nodes n WHERE n.type = 'person' AND n.category = 'A' AND n.name != '我' AND NOT EXISTS (SELECT 1 FROM edges e JOIN nodes n2 ON (e.source_id = n2.id OR e.target_id = n2.id) WHERE (e.source_id = n.id OR e.target_id = n.id) AND n2.name = '我' AND e.relation IN ('mother_of','father_of','spouse_of','sibling_of','child_of','parent_of','grandparent_of','grandchild_of','elder_sister_of','younger_sister_of','elder_brother_of','younger_brother_of'))"
    )[0]?.cnt || 0;
    checks.push({
      name: 'A类全部有家族边', passed: aWithoutEdge === 0,
      detail: aWithoutEdge === 0 ? '全部符合' : `缺失: ${aWithoutEdge}人`,
    });
    if (aWithoutEdge > 0) errors.push(`${aWithoutEdge} 个 A 类节点缺少家族边到"我"`);

    const healthy = errors.length === 0;
    if (healthy) {
      console.log('[FamilyGraph] 🛡️ 完整性守护: 通过 ✓ (' + checks.filter(c => c.passed).length + '/' + checks.length + ')');
    } else {
      console.error('[FamilyGraph] 🔴 完整性守护失败:');
      for (const e of errors) console.error('  - ' + e);
    }

    return { healthy, checks, errors };
  }

  getStats(): { personCount: number; edgeCount: number; locationCount: number; objectCount: number } {
    const persons = this.query('SELECT COUNT(*) as cnt FROM nodes WHERE type = ?', ['person']);
    const edges = this.query('SELECT COUNT(*) as cnt FROM edges');
    const locations = this.query('SELECT COUNT(*) as cnt FROM nodes WHERE type = ?', ['place']);
    const objects = this.query('SELECT COUNT(*) as cnt FROM nodes WHERE type = ?', ['object']);
    return {
      personCount: (persons[0] as any)?.cnt ?? 0,
      edgeCount: (edges[0] as any)?.cnt ?? 0,
      locationCount: (locations[0] as any)?.cnt ?? 0,
      objectCount: (objects[0] as any)?.cnt ?? 0,
    };
  }

  /**
   * 获取所有边摘要（用于 debug API）
   */
  getAllEdgesSummary(): Array<{ entityA: string; entityB: string; relation: string; strength: number }> {
    const results = this.query(
      `SELECT a.name as entityA, b.name as entityB, e.relation
       FROM edges e
       JOIN nodes a ON a.id = e.source_id
       JOIN nodes b ON b.id = e.target_id
       ORDER BY e.created_at DESC
       LIMIT 50`,
    );
    return (results as any[]).map(r => ({
      entityA: r.entityA,
      entityB: r.entityB,
      relation: r.relation,
      strength: 1.0,
    }));
  }

  // ════════════════════════════════════════════════════════════
  // v2.0: 圈层管理
  // ════════════════════════════════════════════════════════════

  /**
   * 设置人物圈层级别
   */
  setCircleLevel(personName: string, level: CircleLevel, manual = true): void {
    const nodes = this.query('SELECT id, properties FROM nodes WHERE name = ? AND type = ?', [personName, 'person']);
    if (nodes.length === 0) return;
    const props = JSON.parse(nodes[0].properties || '{}');
    props.circle_level = level;
    props.circle_locked = manual ? true : (props.circle_locked || false);
    this.run('UPDATE nodes SET circle_level = ?, properties = ?, updated_at = ? WHERE id = ?',
      [level, JSON.stringify(props), new Date().toISOString(), nodes[0].id]);
    this.markDirty(true);
  }

  /** 获取人物圈层级别 */
  getCircleLevel(personName: string): CircleLevel {
    const rows = this.query('SELECT circle_level FROM nodes WHERE name = ? AND type = ?', [personName, 'person']);
    if (rows.length === 0) return 0;
    return (rows[0].circle_level as CircleLevel) || 0;
  }

  /** 按圈层批量获取人物 */
  getPersonsByCircle(level: CircleLevel, includeAbove = false): string[] {
    const op = includeAbove ? '>=' : '=';
    const rows = this.query(`SELECT name FROM nodes WHERE type = ? AND circle_level ${op} ? ORDER BY circle_level`, ['person', level]);
    return rows.map((r: any) => r.name as string);
  }

  /** 自动推算圈层（基于base_intimacy阈值） */
  autoAssignCircle(personName: string): CircleLevel {
    const nodes = this.query('SELECT properties FROM nodes WHERE name = ? AND type = ?', [personName, 'person']);
    if (nodes.length === 0) return 0;
    const props = JSON.parse(nodes[0].properties || '{}');
    if (props.circle_locked) return props.circle_level || 0;

    // 遍历所有关联边，取最高（最内层）圈层
    const edges = this.query(`
      SELECT e.relation FROM edges e
      JOIN nodes n ON e.source_id = n.id OR e.target_id = n.id
      WHERE n.name = ? AND n.type = 'person'
    `, [personName]);

    let bestLevel: CircleLevel = 5;
    for (const e of edges) {
      const base = DEFAULT_BASE_INTIMACY[e.relation] ?? 0.1;
      let level: CircleLevel = 5;
      if (base >= 0.85) level = 1;
      else if (base >= 0.6) level = 2;
      else if (base >= 0.3) level = 3;
      else if (base >= 0.1) level = 4;
      if (level < bestLevel) bestLevel = level;
    }
    return bestLevel;
  }

  /** 批量为所有人分配圈层（跳过已锁定的） */
  batchAutoAssignCircles(): { assigned: number; locked: number } {
    const persons = this.query("SELECT name FROM nodes WHERE type='person'");
    let assigned = 0, locked = 0;
    for (const p of persons) {
      const props = JSON.parse((this.query('SELECT properties FROM nodes WHERE name = ?', [p.name])[0]?.properties) || '{}');
      if (props.circle_locked) { locked++; continue; }
      const level = this.autoAssignCircle(p.name);
      this.run('UPDATE nodes SET circle_level = ? WHERE name = ? AND type = ?', [level, p.name, 'person']);
      assigned++;
    }
    this.markDirty(true);
    this.flush();
    return { assigned, locked };
  }

  // ════════════════════════════════════════════════════════════
  // v2.0: 权重管理
  // ════════════════════════════════════════════════════════════

  setRelationWeights(sourceName: string, targetName: string, weights: Partial<RelationWeights>): void {
    const edge = this.findEdge(sourceName, targetName);
    if (!edge) return;
    const props = JSON.parse(edge.properties || '{}');
    const current: RelationWeights = props.weights || {};
    const locked = current._locked || [];
    for (const [k, v] of Object.entries(weights)) {
      if (!locked.includes(k)) (current as any)[k] = v;
    }
    if (current.base_intimacy === undefined) {
      current.base_intimacy = DEFAULT_BASE_INTIMACY[edge.relation] ?? 0.1;
    }
    props.weights = current;
    this.run('UPDATE edges SET properties = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(props), new Date().toISOString(), edge.id]);
    this.markDirty(true);
  }

  getRelationWeights(sourceName: string, targetName: string): RelationWeights | null {
    const edge = this.findEdge(sourceName, targetName);
    if (!edge) return null;
    return (JSON.parse(edge.properties || '{}').weights) || null;
  }

  lockWeight(sourceName: string, targetName: string, field: string): void {
    const edge = this.findEdge(sourceName, targetName);
    if (!edge) return;
    const props = JSON.parse(edge.properties || '{}');
    const w: RelationWeights = props.weights || {};
    w._locked = [...(w._locked || []), field];
    props.weights = w;
    this.run('UPDATE edges SET properties = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(props), new Date().toISOString(), edge.id]);
    this.markDirty(true);
  }

  unlockWeight(sourceName: string, targetName: string, field: string): void {
    const edge = this.findEdge(sourceName, targetName);
    if (!edge) return;
    const props = JSON.parse(edge.properties || '{}');
    const w: RelationWeights = props.weights || {};
    w._locked = (w._locked || []).filter((f: string) => f !== field);
    props.weights = w;
    this.run('UPDATE edges SET properties = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(props), new Date().toISOString(), edge.id]);
    this.markDirty(true);
  }

  /** 每轮对话增量更新互动频次 */
  updateInteractionFreq(sourceName: string, targetName: string): void {
    const edge = this.findEdge(sourceName, targetName);
    if (!edge) return;
    const props = JSON.parse(edge.properties || '{}');
    const w = props.weights || {};
    if (w._locked?.includes('interaction_freq')) return;
    w.interaction_freq = Math.min(1.0, (w.interaction_freq ?? 0.5) + 0.05);
    props.weights = w;
    this.run('UPDATE edges SET properties = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(props), new Date().toISOString(), edge.id]);
    this.markDirty(true);
  }

  /** 从24D向量更新情绪强度 (EMA平滑) */
  updateEmotionalIntensity(sourceName: string, targetName: string, p24d: Record<string, number>): void {
    const edge = this.findEdge(sourceName, targetName);
    if (!edge) return;
    const props = JSON.parse(edge.properties || '{}');
    const w = props.weights || {};
    if (w._locked?.includes('emotional_intensity')) return;
    const p = Math.abs(p24d?.pleasure ?? 0);
    const a = p24d?.arousal ?? 0;
    const intensity = (p + a) / 2;
    w.emotional_intensity = 0.7 * (w.emotional_intensity ?? 0.5) + 0.3 * intensity;
    props.weights = w;
    this.run('UPDATE edges SET properties = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(props), new Date().toISOString(), edge.id]);
    this.markDirty(true);
  }

  getEffectiveIntimacy(sourceName: string, targetName: string): number {
    const edge = this.findEdge(sourceName, targetName);
    if (!edge) return 0;
    const w: RelationWeights = (JSON.parse(edge.properties || '{}').weights) || {};
    const base = w.base_intimacy ?? DEFAULT_BASE_INTIMACY[edge.relation] ?? 0.1;
    const freq = w.interaction_freq ?? 0.5;
    const emotion = w.emotional_intensity ?? 0.5;
    return base * (0.8 + 0.4 * freq) * (0.8 + 0.4 * emotion);
  }

  // ════════════════════════════════════════════════════════════
  // v2.0: 实体从属关系 + 商业组织集成
  // ════════════════════════════════════════════════════════════

  async addEntityRelation(entityName: string, relation: string, targetName: string, entityType: NodeType = 'thing', targetType: NodeType = 'place'): Promise<void> {
    const eid = this.ensureNode(entityName, entityType);
    const tid = this.ensureNode(targetName, targetType);
    if (!eid || !tid) return;
    const existing = this.query('SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND relation = ?', [eid, tid, relation]);
    if (existing.length === 0) {
      await this.addEdge({ id: uid(), source_id: eid, target_id: tid, relation });
    }
  }

  async integrateOrgRelation(rawInput: string): Promise<InferenceResult> {
    const details: string[] = [];
    let edgesCreated = 0;
    for (const [keyword, rel] of Object.entries(ORG_MAP)) {
      const idx = rawInput.indexOf(keyword);
      if (idx < 0) continue;
      const before = rawInput.substring(0, idx).trim();
      const after = rawInput.substring(idx + keyword.length).trim();
      const personMatch = before.match(/([一-龥]{2,4})$/);
      const orgMatch = after.match(/^([一-龥A-Za-z0-9]{2,20})/);
      if (personMatch && orgMatch) {
        const personId = this.ensureNode(personMatch[1], 'person');
        const orgId = this.ensureNode(orgMatch[1], 'org');
        if (personId && orgId) {
          const rev = ORG_REVERSE[rel];
          await this.addEdge({ id: uid(), source_id: personId, target_id: orgId, relation: rel });
          if (rev) await this.addEdge({ id: uid(), source_id: orgId, target_id: personId, relation: rev });
          edgesCreated++;
          details.push(`${personMatch[1]} --${rel}--> ${orgMatch[1]}`);
        }
      }
    }
    return { nodes_created: 0, edges_created: edgesCreated, details };
  }

  /** 按人物检索关联记忆（对接 FusionStorageAdapter） */
  searchMemoriesByPerson(storage: any, personName: string, limit = 10): any[] {
    if (!storage?.findMemoriesByEntityNames) return [];
    try { return storage.findMemoriesByEntityNames([personName], limit); }
    catch { return []; }
  }

  // ════════════════════════════════════════════════════════════
  // v2.0: 内部工具
  // ════════════════════════════════════════════════════════════

  private ensureNode(name: string, type: NodeType): string | null {
    const existing = this.query('SELECT id FROM nodes WHERE name = ? AND type = ?', [name, type]);
    if (existing.length > 0) return existing[0].id;
    const id = uid();
    this.run('INSERT INTO nodes (id, type, name, properties, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, type, name, '{}', new Date().toISOString(), new Date().toISOString()]);
    return id;
  }

  findEdge(nameA: string, nameB: string): { id: string; relation: string; properties: string } | null {
    const rows = this.query(`
      SELECT e.id, e.relation, e.properties FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE (n1.name = ? AND n2.name = ?) OR (n1.name = ? AND n2.name = ?)
      LIMIT 1
    `, [nameA, nameB, nameB, nameA]);
    return rows.length > 0 ? rows[0] as any : null;
  }

  private rowToNode(row: any): GraphNode {
    return {
      id: row.nid ?? row.id,
      type: row.ntype ?? row.type,
      name: row.nname ?? row.name,
      aliases: row.aliases ? parseAliases(row.aliases) : undefined,
      properties: row.properties ? JSON.parse(row.properties) : undefined,
    };
  }
}
