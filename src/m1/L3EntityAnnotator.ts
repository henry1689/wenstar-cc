/**
 * L3EntityAnnotator — 实体基因槽标注器
 *
 * 使用 FMM（正向最大匹配）分词 + 规则匹配提取实体。
 * 最小语义单位原则：禁止单字子串匹配，防止中文多字误报。
 *
 * Ref: ARCH.md §3.1 L3 实体基因槽
 * Ref: ARCH.md §4.2 编码时 entity_genes 标注 phenotype / knowledge_type
 * Ref: 设计意图宣言 §4 AI自我模型四大支柱
 */
import type {
  EntityGene,
  EntityType,
  PhenotypeLabel,
  L3AnnotationResult,
  SelfModelV1,
} from './types/dna.js';

// ──────────────────────────────────────────────
// 实体规则
// ──────────────────────────────────────────────

/**
 * 实体提取规则：带规范化名称的匹配规则
 * 每条规则在 FMM 分词后的 token 中进行匹配（不是子串匹配）。
 */
interface NormalizedEntityRule {
  name: string;
  type: EntityType;
  /** 匹配关键词（FMM 词典据此构建，单字仅保留"我"） */
  patterns: string[];
}

/**
 * 兜底实体规则（JSON 文件不可用时使用）
 */
const FALLBACK_ENTITY_RULES: NormalizedEntityRule[] = [
  { name: '我', type: 'self', patterns: ['我'] },
  { name: '妈妈', type: 'person', patterns: ['妈妈'] },
  { name: '爸爸', type: 'person', patterns: ['爸爸'] },
  { name: '开心', type: 'emotion', patterns: ['开心'] },
  { name: '难过', type: 'emotion', patterns: ['难过'] },
  { name: '工作', type: 'event', patterns: ['工作', '上班'] },
  { name: '公司', type: 'place', patterns: ['公司', '办公室'] },
  { name: '北京', type: 'place', patterns: ['北京'] },
  { name: '上海', type: 'place', patterns: ['上海'] },
];

/** P2: 从 JSON 加载实体规则（有缓存），失败时兜底 */
let _loadedL3Rules: NormalizedEntityRule[] | null = null;
function getEntityRules(): NormalizedEntityRule[] {
  if (_loadedL3Rules) return _loadedL3Rules;
  try {
    const jsonRules = loadEntityRules();
    if (jsonRules && jsonRules.length > 0) {
      _loadedL3Rules = jsonRules.map((r: any) => ({ name: r.name, type: r.type as EntityType, patterns: r.patterns }));
      return _loadedL3Rules;
    }
  } catch { /* 静默降级 */ }
  console.warn('[L3] entity_rules.json 加载失败，使用内存兜底规则');
  _loadedL3Rules = FALLBACK_ENTITY_RULES;
  return _loadedL3Rules;
}

// 已删除的单字规则（因 FMM 匹配后仍会产生单字误报）：
// - '家'(place) — 国家/大家/专家 误报
// - '花'(object) — 花园/花生/花费 误报
// - '书'(object) — 书店/书法/秘书 误报

// 🔴 DS-01 铁律（M1-M9 禁止低层 import 高层）：原为值导入 `import { FamilyGraph }`，
//    被 CK-01 `checkNineLayerPipeline`（main_harness_checker.ts:254 isReverseDependency =
//    fromNum < impNum）实测判为 m1→m4 反向依赖（:240 只豁免 import type，值导入不豁免），
//    三轮 flow 实测 DS-01 均 60 分（距达标差 38 分）卡住 S4.5。
//    改为**类型引用**（编译期擦除）+ 下方 initFg() 内动态 import 取值 ——
//    `private fg: FamilyGraph | null` 的类型不受影响，运行时行为零变化。
import type { FamilyGraph } from '../m4/household/FamilyGraph.js';

// 🔴 批1（2026-11-07）：滑窗人名生成器已物理删除 ——
//   NON_NAME_SUFFIX / COMMON_WORDS_PERSON / GRAMMAR_WORDS_PERSON / isPersonName 随
//   detectPersonNames 一并退役。实体准入改由主回复调用的「原文证据」校验承担（批2）。

// ──────────────────────────────────────────────
// 中文正向最大匹配分词器
// ──────────────────────────────────────────────
class ChineseSegmenter {
  private dict: string[] = [];
  private maxLen = 0;

  constructor(rules: NormalizedEntityRule[]) {
    const allPatterns = rules.flatMap(r => r.patterns);
    const unique = [...new Set(allPatterns)];
    // 按长度降序排列（FMM 核心 — 最长词优先）
    this.dict = unique.sort((a, b) => b.length - a.length || a.localeCompare(b));
    this.maxLen = Math.max(...this.dict.map(s => s.length), 1);
  }

  /**
   * 正向最大匹配分词
   * 从文本开头开始，每次尝试匹配词典中最长的词。
   */
  segment(text: string): string[] {
    const tokens: string[] = [];
    let i = 0;
    while (i < text.length) {
      let matched = false;
      const lookahead = Math.min(this.maxLen, text.length - i);
      for (let len = lookahead; len >= 1; len--) {
        const candidate = text.substring(i, i + len);
        if (this.dict.includes(candidate)) {
          tokens.push(candidate);
          i += len;
          matched = true;
          break;
        }
      }
      if (!matched) {
        // 未匹配的单字直接作为原子 token 加入
        // 后续实体提取时，非"我"的单字 token 不会被匹配为实体
        tokens.push(text[i]);
        i++;
      }
    }
    return tokens;
  }
}

// ──────────────────────────────────────────────
// 情感极性词表（从 emotion_lexicon.json 统一加载）
// ──────────────────────────────────────────────
import { loadSet, loadEntityRules } from './LexiconLoader.js';
// 🔴 2026-11-08 批2（ADR-020）：LLMEntityExtractor 已退场 —— 实体取证并入主回复调用。

/**
 * 情感极性词表，用于 phenotype 标注
 * 统一从 emotion_lexicon.json 加载，与 M3 感知分析器同源
 */
export const POSITIVE_WORDS = loadSet('emotion_lexicon.json', 'positive_words');
export const NEGATIVE_WORDS = loadSet('emotion_lexicon.json', 'negative_words');

// ──────────────────────────────────────────────
// 实体提取器（基于 FMM 分词）
// ──────────────────────────────────────────────

/**
 * 基于 FMM 分词的命名实体识别器
 *
 * 匹配方式：对输入文本做 FMM 分词 → 检查 token 是否匹配规则中的 pattern
 * 与旧版差异：旧版用 text.includes(pattern) 做子串匹配，
 * 单字规则会在"国家"→"家"、"花园"→"花"等场景产生大量误报。
 * 新版基于 token 的精确匹配彻底消除此问题。
 */
class TokenBasedEntityExtractor {
  private segmenter: ChineseSegmenter;
  private rules: NormalizedEntityRule[];

  constructor(rules: NormalizedEntityRule[]) {
    this.rules = rules;
    this.segmenter = new ChineseSegmenter(rules);
  }

  extractTokens(text: string): string[] {
    return this.segmenter.segment(text.toLowerCase());
  }

  extract(text: string): Array<{ name: string; type: EntityType; allele: string }> {
    const found: Array<{ name: string; type: EntityType; allele: string }> = [];
    const seen = new Set<string>();

    // FMM 分词
    const tokens = this.segmenter.segment(text.toLowerCase());

    for (const rule of this.rules) {
      // 检查 token 列表中是否有任意 pattern 匹配
      const matchedPattern = rule.patterns.find((pat) =>
        tokens.includes(pat.toLowerCase())
      );

      if (matchedPattern) {
        const dedupKey = `${rule.type}:${rule.name}`;
        if (!seen.has(dedupKey)) {
          seen.add(dedupKey);
          found.push({
            name: rule.name,
            type: rule.type,
            allele: matchedPattern,
          });
        }
      }
    }

    return found;
  }
}

// ──────────────────────────────────────────────
// L3 实体标注器
// ──────────────────────────────────────────────

/**
 * L3 实体标注器
 *
 * 使用规则驱动的方式完成：
 * 1. NER 实体提取（FMM 分词 + 关键词模式匹配）
 * 2. phenotype 标注（基于情感极性 + 自我模型比对）
 * 3. knowledge_type 分类（默认private，特定类型映射到family/world）
 *
 * Ref: ARCH.md §3.1 L3 实体基因槽
 * Ref: 架构决策备忘录 v1.1 — 禁止LLM介入
 */
export class L3EntityAnnotator {
  private extractor: TokenBasedEntityExtractor;
  // P1: FG 人名库兜底 — 只读匹配已登记人名（不产生新名字）
  private fg: FamilyGraph | null = null;

  constructor() {
    // P2: 从 JSON 加载实体规则（外部化配置），新增实体只需编辑 entity_rules.json
    this.extractor = new TokenBasedEntityExtractor(getEntityRules());
    // P1: FG 初始化改为惰性（构造同步无法 await sql.js wasm），initFg() 异步补加载
  }

  /**
   * 🆕 P1: 异步初始化 FG 人名库（含别名映射）。
   * 构造同步无法 await sql.js wasm 加载，需调用方（async 环境）调用一次。
   * 幂等：已初始化则跳过。
   */
  async initFg(): Promise<void> {
    if (this.fg || this._fgInitFailed) return;
    try {
      // 🔴 DS-01：值依赖改在本 async 方法内动态取，静态图上 m1 不再持有 m4 的值引用
      //    （动态 import 无 `from` 子句，CK-01 的 import 正则 `/import\s+.*\s+from\s+/` 不匹配
      //     → 不计入依赖边）。加载时机本就在这里（构造期无法 await sql.js wasm，见上方注释），
      //    行为零变化；失败仍由既有 `_fgInitFailed` 兜底，不会每轮重试。
      const { FamilyGraph } = await import('../m4/household/FamilyGraph.js');
      const fg = new FamilyGraph();
      await fg.initialize();
      this.fg = fg;
      console.log('[L3] FG 人名库初始化完成（含别名）');
    } catch (e) {
      this._fgInitFailed = true;
      console.warn('[L3] FG 初始化失败，别名兜底降级:', (e as Error)?.message);
    }
  }

  /** FG 初始化失败标志（避免每轮重试） */
  private _fgInitFailed = false;

  /**
   * 判断实体的 phenotype（对自我模型的影响方向）
   */
  private determinePhenotype(
    entityName: string,
    entityType: EntityType,
    context: string,
    selfModel: SelfModelV1
  ): PhenotypeLabel {
    if (entityType === 'self') {
      const hasStrongNegative = [...NEGATIVE_WORDS].some((w) => context.includes(w));
      const hasStrongPositive = [...POSITIVE_WORDS].some((w) => context.includes(w));
      if (hasStrongNegative && !hasStrongPositive) return 'conflict';
      if (hasStrongPositive && !hasStrongNegative) return 'enhance';
      return 'neutral';
    }

    const contextLower = context.toLowerCase();
    let positiveCount = 0;
    let negativeCount = 0;

    for (const word of POSITIVE_WORDS) {
      if (contextLower.includes(word)) positiveCount++;
    }
    for (const word of NEGATIVE_WORDS) {
      if (contextLower.includes(word)) negativeCount++;
    }

    if (positiveCount > negativeCount) return 'enhance';
    if (negativeCount > positiveCount) return 'conflict';

    for (const boundary of selfModel.boundaries) {
      if (contextLower.includes(boundary.toLowerCase())) {
        return 'conflict';
      }
    }

    return 'neutral';
  }

  /**
   * 确定 knowledge_type（知识源类型）
   */
  private determineKnowledgeType(entityType: EntityType, entityName: string): 'private' | 'family' | 'world' {
    if (entityType === 'person') {
      const familyKeywords = [
        '妈妈', '母亲', '爸', '爸爸', '父亲',
        '爷爷', '奶奶', '外公', '外婆',
        '哥哥', '弟弟', '姐姐', '妹妹',
        '老公', '老婆', '丈夫', '妻子',
        '姑姑', '舅舅', '阿姨', '叔叔',
        '家庭', '家人', '亲戚',
      ];
      if (familyKeywords.some((kw) => entityName.includes(kw))) {
        return 'family';
      }
    }

    if (entityType === 'place') {
      const worldPlaces = ['北京', '上海', '深圳', '广州', '杭州', '中国', '美国'];
      if (worldPlaces.includes(entityName)) {
        return 'world';
      }
    }

    return 'private';
  }

  /**
   * 对输入文本进行L3实体标注
   */
  annotate(
    text: string,
    context: string,
    selfModel: SelfModelV1
  ): L3AnnotationResult {
    if (!text) return { entity_genes: [] };
    const entities = this.extractor.extract(text);
    // 🔴 批1（2026-11-07）：人名滑窗生成器已物理删除。
    //   历史缺陷：2~3 字 n-gram × 姓氏表，无证据要求，输出「阿珍一/水乳交/全芬倒」等跨词碎片，
    //   下游字面闸门与观察区 LLM 终审都在为它善后，但判定所需的信息在生成端已丢失。
    //   新准入（批2）由主回复调用输出「原文证据」，代码用 message.includes(evidence) 校验。
    // P1: FG 人名库兜底 — 只读匹配已登记人名（不产生新名字）
    // 🆕 扩展: 用 getAllPersonNamesWithAliases 支持简称/昵称匹配（"诗韵"→"徐诗韵"）
    if (this.fg) {
      try {
        const fgNameMap = (this.fg as any).getAllPersonNamesWithAliases?.()
          ?? new Map(this.fg.getAllPersonNames().map((n: string) => [n, n]));
        const existingNames = new Set(entities.map(e => e.name));
        // 遍历所有主名+别名，若文本包含则添加对应主名（别名归一化）
        for (const [aliasOrName, mainName] of fgNameMap.entries()) {
          if (aliasOrName.length < 1) continue;
          if (text.includes(aliasOrName) && !existingNames.has(mainName)) {
            existingNames.add(mainName);
            entities.push({ name: mainName, type: 'person', allele: aliasOrName, aliasOf: mainName } as any);
            if (aliasOrName !== mainName) {
              console.log(`[L3] FG 别名兜底: ${aliasOrName} → ${mainName}`);
            } else {
              console.log(`[L3] FG 人名兜底: ${mainName}`);
            }
          }
        }
      } catch (_) { /* FG 查询失败不阻塞 */ }
    }
    const fullContext = `${text} ${context}`;

    const entityGenes: EntityGene[] = entities.map((entity) => ({
      name: entity.name,
      type: entity.type,
      allele: entity.allele,
      phenotype: this.determinePhenotype(entity.name, entity.type, fullContext, selfModel),
      knowledge_type: this.determineKnowledgeType(entity.type, entity.name),
    }));

    return { entity_genes: entityGenes };
  }

  /**
   * P3: LLM 辅助增强实体提取（识别类工具，非创造类）
   */
  async annotateWithLLM(
    text: string,
    context: string,
    selfModel: SelfModelV1,
    _llmGenerate?: (prompt: string) => Promise<string>,
  ): Promise<L3AnnotationResult> {
    // 🔴 2026-11-08 批2（ADR-020）：独立 LLM 实体提取已物理退场 —— 取证并入主回复调用，
    //   由 m1/entity-admission 用「证据必须是原文连续子串」做硬校验。
    //   本方法保留签名（零调用方改动），但**不再接受第二个提取来源**：
    //   只返回确定性规则结果，杜绝"看起来像人名就入库"的旁路。
    return this.annotate(text, context, selfModel);
  }
}
