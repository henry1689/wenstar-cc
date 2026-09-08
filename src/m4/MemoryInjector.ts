/**
 * MemoryInjector — 统一记忆注入引擎 (V8.0)
 * ============================================
 * 统管砂金/金库/黑钻/知识库四条管线，按预算分配注入到 LLM 上下文。
 *
 * 设计原则：
 * - 四条管线竞争同一块上下文空间 → 改为统一调度
 * - 日常闲聊不再"零记忆" → 钙化分兜底确保至少 1-2 条记忆
 * - 去重 + 排序 + 截断 → 确保高质量记忆优先注入
 * - 后续所有记忆调参只在此模块一处完成
 */

// 🔴 P1 配置化: 权重/预算从 yaml 读取，消除硬编码魔法数字
import { getRetrievalFusionConfig } from '../config/retrieval-fusion-config.js';
// 🔴 P0-1 二次精筛: 记忆 vs 用户 query 相关性打分（纯算法，零外部依赖）
import { computeQueryRelevance } from './rerank/AlgorithmicCrossEncoder.js';

/** 记忆片段类别（第二阶段 P0: 精筛/条数上限的豁免依据） */
export type MemoryKind = 'diamond' | 'vault' | 'sand' | 'timeline' | 'context' | 'knowledge';

/** 记忆片段（统一表示） */
export interface MemoryItem {
  text: string;           // 记忆文本
  source: 'diamond' | 'vault' | 'sand' | 'knowledge' | 'timeline' | 'work';
  kind: MemoryKind;       // 🔴 P0-3: 类别标记（豁免依据）
  priority: number;       // 0-1, 越高越重要
}

/** 注入参数 */
export interface InjectOptions {
  /** retrieval-stage 产出的 memoryFragments（黑钻/时间检索/用户曾提到） */
  memoryFragments: string[];
  /** M4 memory_summary.timeline 压缩后的记忆锚点 */
  m4Timeline: Array<{ summary: string; calcium_level?: number }>;
  /** KnowledgeContextBuilder 产出的知识库文本 */
  knowledgeBaseText: string;
  /** 🆕 vault_log 金库检索结果 */
  vaultHits: string[];
  /** 总字符硬上限（默认 8000 = ~4000 tokens） */
  maxChars: number;
  /** 🆕 V10.1: 会晤模式下保留记忆片段的结构标签（【我的档案】【过去的对话记忆】等），不剥离 */
  preserveLabels?: boolean;
  /** V12.1: 当前活跃的实体名列表 — 用于在记忆上下文中标注归属 */
  entityNames?: string[];
  /** 🔴 P2 建议1: 事实查询增强 — 用户问"答应过/记得你说过"时拉高金库优先级 */
  vaultBoost?: boolean;
  /** 🔴 P0-1 二次精筛: 用户当前消息（query）。会晤模式不传 → 自动关闭精筛保护实体记忆 */
  query?: string;
  /** 🔴 P0-1: 强制跳过二次精筛（兜底用） */
  skipSecondaryFilter?: boolean;
}

/**
 * 统一注入：收集 → 去重 → 排序 → 截断 → 输出。
 */
export function injectMemories(opts: InjectOptions): string {
  const {
    memoryFragments = [],
    m4Timeline = [],
    knowledgeBaseText = '',
    vaultHits = [],
    maxChars = 5000,  // 2026-08-24 提速: 8000→5000（上下文瘦身）
    preserveLabels = false,
    vaultBoost = false,
    query,
    skipSecondaryFilter = false,
  } = opts;

  // 🔴 P1 配置化: 权重/预算从 yaml 读取（无魔法数字）
  const cfg = getRetrievalFusionConfig();
  const PRI = cfg.inject_priority;
  const TW = cfg.timeline_weight;
  const BUD = cfg.budget;
  const hardMax = BUD.hard_max_chars;

  const items: MemoryItem[] = [];
  // V22 作品: 完整作品文本（最多 1 篇，独立预算，不参与 250 截断）
  let workFullText = '';
  // V23 长文: 对话原文（最多 1 条，独立预算，不参与 250 截断）
  let longText = '';
  // 🔴 S2-R5: 知识库档案全文（【知识库档案】前缀，独立预算，不参与 250 截断）
  let archiveText = '';

  // ── 来源 1: memoryFragments（砂金+黑钻+作品+长文，来自 retrieval-stage） ──
  for (const frag of memoryFragments) {
    // S2-T1: 过滤编造/矛盾记忆 — LLM 单方面编造的过去细节(白粥/咸鸭蛋/围裙/丰田) +
    // 否定真实记录的矛盾记忆(不是十四岁/记混/没敢/看背影)，避免 LLM 采信否认知识库真实14岁记录。
    const FABRICATION_PATTERNS = /海边|比基尼|营销总监|全职太太|来月经|身体开始变|刻骨铭心|从零到一|泳衣|穿拖鞋|白粥|咸鸭蛋|围裙|丰田|银色|双闪|不是十四岁|记混|没敢|看背影|十五岁|什么都没做|煮了泡面|盖外套|风扇|灰T恤|抹眼泪|阳台上|衣服后面|骑[车]?来|六月末|鸡蛋|生日.*宿舍/;
    if (/【[^】]*(记忆|对话)[^】]*】/.test(frag) && FABRICATION_PATTERNS.test(frag)) {
      continue;
    }

    // 🆕 V22 作品召回: 【作品】开头的 fragment 走独立预算（完整作品进上下文）
    if (frag.startsWith('【作品】')) {
      if (!workFullText) {
        workFullText = frag;  // 最多保留 1 篇完整作品
        console.log(`[MemoryInjector] 作品独立注入: ${frag.substring(0, 40)}… (${frag.length}字符)`);
      }
      continue;
    }
    // 🆕 V23 长文: 【对话原文】开头的 fragment 走独立预算（长文完整返回）
    if (frag.startsWith('【对话原文】')) {
      // 实测修复: 合并多条长文（同一纪实的多段/多篇），而非只保留第1条
      // 原逻辑只留1条 → 梓玥章等被丢弃 → LLM 靠记忆编造（扯进吴波等无关人物）
      if (longText) {
        longText = longText + '\n\n' + frag;
        console.log(`[MemoryInjector] 长文合并注入: +${frag.length}字符 (总计${longText.length})`);
      } else {
        longText = frag;  // 第1条
        console.log(`[MemoryInjector] 长文独立注入: ${frag.substring(0, 40)}… (${frag.length}字符)`);
      }
      continue;
    }
    // 🔴 S2-R5: 【知识库档案】开头的 fragment 走独立预算（知识库档案全文完整返回，不截断）
    // 覆盖【知识库档案】与【知识库档案·权威记录】两种前缀
    if (frag.startsWith('【知识库档案')) {
      archiveText = archiveText ? archiveText + '\n\n' + frag : frag;
      console.log(`[MemoryInjector] 知识库档案独立注入: ${frag.substring(0, 40)}… (${frag.length}字符)`);
      continue;
    }
    // 🆕 V10.1: 会晤模式下保留结构标签，LLM 可区分档案/记忆/家人
    const labelMatch = preserveLabels ? frag.match(/^(【[^】]+】)/) : null;
    const preservedLabel = labelMatch ? labelMatch[1] : '';
    const clean = frag
      .replace(/【[^】]*】/g, '')        // 去标签
      .replace(/（[^）]*）/g, '')        // 去括号场景
      .replace(/——.*$/, '')              // 去后缀说明
      .trim();
    if (clean.length < 5) continue;
    const isDiamond = frag.includes('珍藏记忆') || frag.includes('💎');
    // V10.1: 保留标签时，以标签文本作为内容前缀
    const displayText = preserveLabels && preservedLabel
      ? preservedLabel + ' ' + clean.substring(0, 300)
      : clean.substring(0, 250);
    // 🔴 P0-1 + P1 配置化: 金库【金库记忆】识别为 vault，优先级从 yaml 读取。
    // 优先级: 档案 > 黑钻 > 实体记忆 > 金库 > 普通砂金（数值见 retrieval-fusion.config.yaml）
    // 🔴 P2 建议2: 从原始 frag 判断金库（normal 模式也识别【金库记忆】，不再依赖 preservedLabel）。
    // 🔴 D1 修复: 只认【金库记忆】标签（金库真实来源 formatHit/SQL 均带此标签），
    // 去掉 '📌' — 它与【📌重要记忆】(钙化≥2 砂金) 冲突，导致高钙化记忆被误判为金库降权。
    const isVault = frag.includes('金库');
    // 🔴 P0-3 kind 判定: 基于原始 frag 标签（清洗已在 L96-100 剥离标签），豁免依据
    // context = 当前会话上下文/实体自有记忆（绝对优先，不精筛不计数）
    const kind: MemoryKind = isDiamond ? 'diamond' : isVault ? 'vault' :
      frag.startsWith('📖') ? 'knowledge' :
      /^(【用户曾提到】|【用户状态】|【时间检索】|【回忆】|【对话·|【.+的记忆】)/.test(frag) ? 'context' : 'sand';
    let priority = PRI.memory_normal;
    if (isDiamond) priority = PRI.black_diamond;
    else if (frag.includes('档案') || preservedLabel.includes('档案')) priority = PRI.archive_tag;
    // 🔴 P2 建议1: 事实查询增强 — vaultBoost 时金库优先级临时拉高（上浮 0.2，封顶 0.95）
    else if (isVault) priority = vaultBoost ? Math.min(PRI.vault + 0.2, 0.95) : PRI.vault;  // 金库（事实/承诺）
    else if (frag.includes('记忆') || preservedLabel.includes('记忆')) priority = PRI.memory_normal + 0.25;  // 实体记忆
    items.push({
      text: displayText,
      source: isDiamond ? 'diamond' : isVault ? 'vault' : 'sand',
      kind,
      priority,
    });
  }

  // ── 来源 2: M4 timeline（钙化分排序的记忆锚点） ──
  for (const t of m4Timeline) {
    const calcium = t.calcium_level ?? 1;
    const clean = (t.summary || '').replace(/（[^）]*）/g, '').trim();
    if (clean.length < 5) continue;
    // 钙化等级越高优先级越高；🔴 P1 修复倒挂: timeline 最低不低于普通砂金
    const priority = Math.max(
      Math.min(TW.base + calcium * TW.scale, TW.cap),
      TW.min_val,
    );
    items.push({ text: clean.substring(0, 120), source: 'timeline', kind: 'timeline', priority });
  }

  // ── 来源 3: vault_log 金库（用户说过的事实/承诺） ──
  for (const v of vaultHits) {
    const clean = v.trim();
    if (clean.length < 5) continue;
    items.push({
      text: clean.substring(0, 150),
      source: 'vault',
      kind: 'vault',
      priority: PRI.vault,  // 🔴 P1 配置化: 金库优先级从 yaml
    });
  }

  // ── 🔴 P0-1 二次精筛: 记忆 vs 用户 query 相关性过滤（在去重之前，避免高优先无关记忆被 dedup 保留） ──
  // 豁免: diamond/context/knowledge 不删（作品/长文已在收集阶段路由独立预算，天然不碰）
  //       vaultBoost 命中时额外豁免 vault（"答应过"场景金库不被滤）
  //       text.length > 600 豁免（长记忆保护）
  //       会晤模式不传 query → 自动跳过
  const SPF = cfg.speed_filter;
  let _filtered = items;
  if (query && !skipSecondaryFilter && query.trim().length >= 4) {
    // 动态 import 避免循环依赖（computeQueryRelevance 与 injectMemories 同属 m4 检索域）
    _filtered = _filtered.filter(it => {
      if (it.kind === 'diamond' || it.kind === 'context' || it.kind === 'knowledge') return true;
      if (it.kind === 'vault' && vaultBoost) return true;
      // 注: 无 >600 豁免 —— MemoryItem.text 收集时已截断(250/300/120/150)，
      // 长文本保护由【作品】/【对话原文】独立预算承载（收集阶段路由，天然不精筛）。
      const rel = computeQueryRelevance(query, it.text);
      const pass = rel >= SPF.second_filter_threshold;
      if (process.env.RETRIEVAL_DEBUG === 'true') {
        console.log(`[MemoryInjector] 精筛 kind=${it.kind} rel=${rel.toFixed(2)} ${pass ? '保留' : '剔除'} (阈值${SPF.second_filter_threshold}) "${it.text.substring(0, 20)}"`);
      }
      return pass;
    });
    if (_filtered.length !== items.length) {
      console.log(`[MemoryInjector] 二次精筛: ${items.length} → ${_filtered.length} 条 (query="${query.substring(0, 20)}")`);
    }
  }

  // ── 🔴 P0-3 普通碎片上限: sand/timeline 最多 N 条，其余按 priority 丢弃 ──
  // 🔴 2026-09-09 记忆碎片化修复(共性): 会晤场景(preserveLabels=true)条数上限放宽
  //   max_normal_memory_count:10 → meeting_max_normal_memory_count:20 —— 实体会晤需承载
  //   "昨天一天记忆"，10 条(配合曾拆行成 ~40 字碎片)根本不够；玉瑶态保持 10 不撑爆普通预算。
  // 豁免: diamond/vault/knowledge/context（金库对条数豁免，但对 query 相关性仍受精筛）
  const _normalCap = opts.preserveLabels === true
    ? (SPF.meeting_max_normal_memory_count ?? SPF.max_normal_memory_count)
    : SPF.max_normal_memory_count;
  const _capped: MemoryItem[] = [];
  const _normal: MemoryItem[] = [];
  for (const it of _filtered) {
    if (it.kind === 'sand' || it.kind === 'timeline') _normal.push(it);
    else _capped.push(it);
  }
  if (_normal.length > _normalCap) {
    _normal.sort((a, b) => b.priority - a.priority);
    _normal.length = _normalCap;
    console.log(`[MemoryInjector] 普通碎片上限: 超${_normalCap}条，按 priority 保留前${_normalCap}条${opts.preserveLabels === true ? ' (会晤放宽)' : ''}`);
  }
  _filtered = [..._capped, ..._normal];

  // ── 去重：Jaccard 相似度 > 0.4 视为重复，保留优先级更高的 ──
  const deduped = deduplicate(_filtered);

  // ── 按优先级降序 ──
  deduped.sort((a, b) => b.priority - a.priority);

  // ── 预算分配：V10.1 记忆 60% + 知识库 40%（原 50/50）──
  // 实测修复: 有长文时压缩记忆/KB预算，给完整纪实让路（否则合并长文被截断 → LLM 编造）
  // 🔴 P0-4 修复: 知识库预算动态让渡——KB 无有效命中时，额度全部给记忆。
  // 🔴 P1 配置化: 预算比例从 yaml 读取
  // 🔴 S2-R5: 知识库档案全文也触发"长文本预算"（有档案时压缩记忆/KB，给档案全文让路）
  const _hasLongText = !!longText || !!archiveText;
  const _hasKbHit = !!(knowledgeBaseText && knowledgeBaseText.trim().length > 20);
  // 🔴 D4 修复: kbBudget 用 kb_ratio_normal（yaml 配置真实生效，而非 maxChars - memBudget）
  let memBudget = _hasLongText ? Math.floor(maxChars * BUD.mem_ratio_longtext) : Math.floor(maxChars * BUD.mem_ratio_normal);
  let kbBudget = _hasLongText ? Math.floor(maxChars * BUD.kb_ratio_longtext) : Math.floor(maxChars * BUD.kb_ratio_normal);
  // 无 KB 命中 → KB 预算让渡给记忆（记忆拿满，提升关键记忆召回）
  // 🔴 D7 修复: 让渡时扣除作品占用（workFullText 独立预算），避免硬上限从头部截断吃掉记忆
  if (!_hasKbHit && !_hasLongText) {
    const _workReserve = workFullText ? Math.min(BUD.work_max_chars, Math.floor(maxChars * 0.4)) : 0;
    memBudget = Math.max(0, maxChars - _workReserve);   // 记忆拿除作品外的全部预算
    kbBudget = 0;
  }

  // ── 截断记忆 ──
  const memParts: string[] = [];
  let memChars = 0;
  for (const item of deduped) {
    // V10.1: 会晤模式保留原始结构标签，非会晤模式用 emoji 前缀
    const hasPreservedLabel = preserveLabels && /^【[^】]+】/.test(item.text);
    const label = hasPreservedLabel ? '' :
                  item.source === 'diamond' ? '💎' :
                  item.source === 'vault' ? '📌' :
                  item.source === 'timeline' ? '🕐' : '💭';
    const line = hasPreservedLabel ? item.text : `${label} ${item.text}`;
    // 🔴 P2 建议3: 调试日志 — 打印每条记忆 source/priority/截断长度（排查记忆丢失/截断）
    if (process.env.RETRIEVAL_DEBUG === 'true') {
      console.log(`[MemoryInjector] item source=${item.source} priority=${item.priority.toFixed(2)} chars=${item.text.length} total=${memChars + line.length}/${memBudget}`);
    }
    if (memChars + line.length > memBudget) break;
    memParts.push(line);
    memChars += line.length + 1;
  }

  // ── 截断知识库 ──
  let kbText = '';
  if (knowledgeBaseText) {
    kbText = knowledgeBaseText.length > kbBudget
      ? knowledgeBaseText.substring(0, kbBudget) + '\n…(已截断)'
      : knowledgeBaseText;
  }

  // ── 组装 ──
  const parts: string[] = [];
  if (memParts.length > 0) {
    // V12.1: 标注实体归属 — 当有明确实体时，提示 LLM 区分记忆来源
    const _entityPrefix = opts.entityNames && opts.entityNames.length > 0
      ? '【关于 ' + opts.entityNames.join('、') + ' 的记忆】\n'
      : '';
    const _notes: string[] = [];
    _notes.push('🔴 共情指南：');
    _notes.push('1）这些记忆片段记录了鸿艺过去的情绪和经历。如果他现在说的事情与某个记忆中的情绪相似（比如都是疲惫、都是焦虑），用那段记忆来理解他此刻的感受——不要只是"引用"，而是"共鸣"。');
    _notes.push('2）表达公式：你当下感受 + 记忆中类似经历 → "是不是又像上次那样……""我懂这种感觉，你之前……的时候也是这样"');
    _notes.push('3）记忆中没有的细节不要自己编造。');
    parts.push(_entityPrefix + '【相关记忆】\n' + memParts.join('\n') +
      '\n（' + _notes.join(' ') + '）');
  }
  if (kbText) {
    parts.push(kbText);
  }

  // ── V22/V23 作品+长文: 优先保留（放最前，硬截断时不被砍） ──
  // 🔴 S5-评审修复(🟡-4): 原顺序 [记忆,KB,作品,长文]，硬截断从头保留 → 长文最后被整段丢弃。
  // 修复: 长文/作品放最前 + 长文预算提高（detail 4305 字不丢结尾）。
  // 注: 长文与作品同时命中时，长文优先（用户当前明确要看长文）。
  const _priorityParts: string[] = [];
  if (longText) {
    // 实测修复: 合并多篇纪实（4305+1814+1290=7409字），预算需覆盖完整系列
    // 🔴 P1 配置化: 长文预算比例从 yaml
    const longBudget = Math.max(BUD.work_max_chars, Math.floor(maxChars * BUD.longtext_max_ratio));
    _priorityParts.push(longText.length > longBudget
      ? longText.substring(0, longBudget) + '\n…(对话原文超长已截断)'
      : longText);
  }
  // 🔴 S2-R5: 知识库档案全文独立预算（优先级 长文 > 档案 > 作品）
  if (archiveText) {
    const archiveBudget = Math.max(BUD.work_max_chars, Math.floor(maxChars * BUD.longtext_max_ratio));
    _priorityParts.push(archiveText.length > archiveBudget
      ? archiveText.substring(0, archiveBudget) + '\n…(知识库档案超长已截断)'
      : archiveText);
  }
  if (workFullText && !longText && !archiveText) {  // 长文/档案已占用预算时，作品降级为摘要不完整注入
    // 🔴 P1 配置化: 作品预算从 yaml
    const workBudget = Math.min(BUD.work_max_chars, Math.floor(maxChars * 0.4));
    _priorityParts.push(workFullText.length > workBudget
      ? workFullText.substring(0, workBudget) + '\n…(作品超长已截断)'
      : workFullText);
  }
  parts.unshift(..._priorityParts);

  const result = parts.join('\n\n');
  if (memParts.length > 0) {
    console.log(`[MemoryInjector] ${deduped.length} items → ${memParts.length} injected (${memChars} chars), KB ${kbText.length} chars`);
  }

  // S5-评审: 总输出硬约束 — 记忆+知识库+作品合计不超过预算（优先保记忆，其次作品）
  // 🔴 P1 配置化: 硬上限 = min(调用方 maxChars, 配置 hard_max_chars)，尊重请求预算
  const _effectiveCap = Math.min(hardMax, maxChars);
  if (result.length > _effectiveCap) {
    const truncated = result.substring(0, _effectiveCap);
    console.log(`[MemoryInjector] 总输出超预算 ${result.length}→${_effectiveCap} 截断`);
    return truncated + '\n…(上下文超预算已截断)';
  }

  return result;
}

/** 简单去重：两两 Jaccard > 0.4 视为重复 */
function deduplicate(items: MemoryItem[]): MemoryItem[] {
  if (items.length <= 1) return items;

  const result: MemoryItem[] = [];
  for (const item of items) {
    let isDup = false;
    for (const existing of result) {
      if (jaccardSimilarity(item.text, existing.text) > 0.4) {
        // 保留优先级更高的
        if (item.priority > existing.priority) {
          result.splice(result.indexOf(existing), 1, item);
        }
        isDup = true;
        break;
      }
    }
    if (!isDup) result.push(item);
  }
  return result;
}

/** Jaccard 相似度（基于 2-gram 字符级） */
function jaccardSimilarity(a: string, b: string): number {
  const aSet = new Set<string>();
  const bSet = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) aSet.add(a.substring(i, i + 2));
  for (let i = 0; i < b.length - 1; i++) bSet.add(b.substring(i, i + 2));
  const intersection = [...aSet].filter(x => bSet.has(x)).length;
  const union = new Set([...aSet, ...bSet]).size;
  return union === 0 ? 0 : intersection / union;
}

export default injectMemories;
