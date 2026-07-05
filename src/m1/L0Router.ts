/**
 * L0 基因组锚点 — 纯规则路由，禁止LLM介入
 *
 * v2:
 * - 情感词统一从 emotion_lexicon.json 加载（移除硬编码）
 * - 返回 L0 分类码用于根码编码
 * - 新增 taxonomy.json 中的 codes 映射
 * - 词表更新无需改代码，重启自动生效
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { L0RouteResult, TaxonomyTree } from './types/dna.js';
import { loadL0Rules, loadSet } from './LexiconLoader.js';

// ── 情感词从统一词表加载（与 M3/L3 同源） ──
const EMOTION_POSITIVE = loadSet('emotion_lexicon.json', 'positive_words');
const EMOTION_NEGATIVE = loadSet('emotion_lexicon.json', 'negative_words');

// ─── 当前文件所在目录 ───
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_TAXONOMY_PATH = join(__dirname, 'config', 'taxonomy_v1.json');

// ─── 默认兜底分类树 ───
const FALLBACK_TAXONOMY: TaxonomyTree & { codes?: Record<string, string> } = {
  version: '0.0-fallback',
  description: '内存默认分类树（文件加载失败时启用）',
  codes: {
    'family.general': 'FAMG', 'family.conflict': 'FAMF',
    'emotion.positive': 'EMOP', 'emotion.negative': 'EMON',
    'misc.default': 'MISC',
  },
  tree: {
    user: {
      family: ['general'],
      emotion: ['neutral'],
      work: ['general'],
      misc: ['default'],
    },
  },
};

interface KeywordRule {
  id: string;
  keywords: string[];
  domain: string;
  subcategory: string;
  priority: number;
}

const KEYWORD_RULES = loadL0Rules();

let cachedTaxonomy: (TaxonomyTree & { codes?: Record<string, string> }) | null = null;

/**
 * 加载认知分类树（惰性缓存）
 */
export function loadTaxonomy(customPath?: string): TaxonomyTree & { codes?: Record<string, string> } {
  if (!customPath && cachedTaxonomy) return cachedTaxonomy;
  const targetPath = customPath ?? DEFAULT_TAXONOMY_PATH;
  try {
    if (!existsSync(targetPath)) {
      console.warn(`[L0Router] taxonomy.json not found at ${targetPath}, using fallback.`);
      return FALLBACK_TAXONOMY;
    }
    const raw = readFileSync(targetPath, 'utf-8');
    const taxonomy = JSON.parse(raw);
    if (!taxonomy.version || !taxonomy.tree) {
      throw new Error('Invalid taxonomy structure: missing version or tree');
    }
    if (!customPath) cachedTaxonomy = taxonomy;
    return taxonomy;
  } catch (err) {
    console.warn(`[L0Router] Failed to load taxonomy: ${err instanceof Error ? err.message : String(err)}`);
    return FALLBACK_TAXONOMY;
  }
}

export function clearTaxonomyCache(): void {
  cachedTaxonomy = null;
}

/**
 * 获取 L0 分类码（从 taxonomy.json codes 映射）
 */
function resolveL0Code(domain: string, subcategory: string, taxonomy: any): string {
  const key = `${domain}.${subcategory}`;
  const code = taxonomy.codes?.[key];
  if (code && typeof code === 'string' && code.length === 4) return code;
  // 主域存在但子类无对应码 → 同域第一个码兜底
  for (const [ckey, cval] of Object.entries(taxonomy.codes ?? {})) {
    if (ckey.startsWith(domain + '.')) return cval as string;
  }
  return 'MISC';
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

interface BestMatchResult {
  rule: KeywordRule;
  matchedKeywords: string[];
}

function findBestMatchingRule(text: string): { best: BestMatchResult | null; secondBest: BestMatchResult | null } {
  const lowerText = text.toLowerCase();
  const matched: BestMatchResult[] = [];

  for (const rule of KEYWORD_RULES) {
    const matchedKws = rule.keywords.filter((kw) => lowerText.includes(kw.toLowerCase()));
    if (matchedKws.length > 0) {
      matched.push({ rule, matchedKeywords: matchedKws });
    }
  }

  if (matched.length === 0) return { best: null, secondBest: null };

  matched.sort((a, b) => {
    const priorityDiff = a.rule.priority - b.rule.priority;
    if (priorityDiff !== 0) return priorityDiff;
    return b.matchedKeywords.length - a.matchedKeywords.length;
  });

  return { best: matched[0], secondBest: matched.length > 1 ? matched[1] : null };
}

function validatePath(tree: any, domain: string, subcategory: string): string {
  const domainNode = tree.tree?.user?.[domain];
  if (!domainNode) return 'user.misc.default';
  if (!domainNode.includes(subcategory)) {
    if (domainNode.includes('general')) return `user.${domain}.general`;
    return `user.${domain}.${domainNode[0]}`;
  }
  return `user.${domain}.${subcategory}`;
}

/**
 * L0 基因组锚点 — 确定性路由
 *
 * 返回含 l0_code 的完整路由结果，用于后续根码编码。
 * 情感词全部从统一词表加载，零硬编码。
 */
export function routeL0(
  utterance: string,
  taxonomyTree?: any
): L0RouteResult {
  const tree = taxonomyTree ?? loadTaxonomy();
  const text = normalizeText(utterance);

  if (!text) {
    return {
      locus_path: 'user.misc.default',
      taxonomy_version: tree.version,
      l0_code: 'MISC',
      rule_id: 'empty-input-fallback',
      is_fallback: true,
    };
  }

  // 第一阶段：关键词规则匹配
  const { best: bestMatch, secondBest: secondMatch } = findBestMatchingRule(text);

  if (bestMatch) {
    const { rule } = bestMatch;
    const locus_path = validatePath(tree, rule.domain, rule.subcategory);
    const l0_code = resolveL0Code(rule.domain, rule.subcategory, tree);

    let ambiguity_score = 0;
    if (secondMatch) {
      const priorityGap = secondMatch.rule.priority - rule.priority;
      if (priorityGap <= 0) {
        ambiguity_score = 0.7 + Math.min(0.3, (1 - secondMatch.matchedKeywords.length / Math.max(1, bestMatch.matchedKeywords.length)) * 0.3);
      } else if (priorityGap === 1) {
        ambiguity_score = 0.4;
      } else {
        ambiguity_score = 0.1;
      }
    }

    return {
      locus_path,
      taxonomy_version: tree.version,
      l0_code,
      rule_id: rule.id,
      is_fallback: false,
      ambiguity_score,
    };
  }

  // 第二阶段：纯情感极性探测（词表驱动，统一从 emotion_lexicon.json 加载）
  const hasStrongNeg = [...EMOTION_NEGATIVE].some((w) => text.includes(w));
  const hasStrongPos = [...EMOTION_POSITIVE].some((w) => text.includes(w));

  if (hasStrongNeg && !hasStrongPos) {
    const path = validatePath(tree, 'emotion', 'negative');
    const code = resolveL0Code('emotion', 'negative', tree);
    return {
      locus_path: path,
      taxonomy_version: tree.version,
      l0_code: code,
      rule_id: 'emotion-negative-fallback',
      is_fallback: false,
    };
  }
  if (hasStrongPos && !hasStrongNeg) {
    const path = validatePath(tree, 'emotion', 'positive');
    const code = resolveL0Code('emotion', 'positive', tree);
    return {
      locus_path: path,
      taxonomy_version: tree.version,
      l0_code: code,
      rule_id: 'emotion-positive-fallback',
      is_fallback: false,
    };
  }

  // 第三阶段：完全未匹配 → misc兜底
  return {
    locus_path: 'user.misc.default',
    taxonomy_version: tree.version,
    l0_code: 'MISC',
    rule_id: 'misc-default-fallback',
    is_fallback: true,
  };
}
