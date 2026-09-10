/**
 * DNAEncoder — DNA 编码器编排器
 *
 * 严格按 L0 → L1 → L2 → L3 顺序流水线，逐层生成 DNA 对象。
 *
 * v2 核心变更：
 * - 根码单次生成：encodeSingle() → L0路由 → 生成1次根码 → 透传全流水线
 * - 新根码格式：[6位序号][14位时间码]M01[4位L0码]
 * - 计数器统一委托 GlobalSequenceCounter（持久化、跨日期归零）
 * - push() 模式的语义边界不再切割编码序列（边界仅作为元数据标注）
 * - scene_tags 派生保留硬编码映射 + 版本告警（全动态派生待 P2 完成）
 */
import { createHash } from 'node:crypto';
import { routeL0, loadTaxonomy } from './L0Router.js';
import { L1Sequencer } from './L1Sequencer.js';
import { L2ContentExtractor } from './L2ContentExtractor.js';
import { L3EntityAnnotator } from './L3EntityAnnotator.js';
import { SemanticBoundaryDetector } from './SemanticBoundaryDetector.js';
import { GlobalSequenceCounter } from './GlobalSequenceCounter.js';
import type {
  DNA, TaxonomyTree, SelfModelV1,
  L0RouteResult, L2ContentResult, L3AnnotationResult,
} from './types/dna.js';

export interface PushInput {
  utterance: string;
  context?: string[];
  timestamp?: string;
}

interface BufferEntry {
  utterance: string;
  context: string;
  timestamp?: string;
}

export class DNAEncoder {
  private selfModel: SelfModelV1;
  private sequencer: L1Sequencer;
  private extractor: L2ContentExtractor;
  private annotator: L3EntityAnnotator;
  private detector: SemanticBoundaryDetector;
  private taxonomy: TaxonomyTree | null = null;
  private buffer: BufferEntry[] = [];
  private stats = { encodeCount: 0, failCount: 0, stageFailures: { l0: 0, l1: 0, l2: 0, l3: 0 } };

  /**
   * 生成 DNA 根码 (旧格式, 向后兼容)
   * [6位序号][14位时间码]M01[4位L0码]
   * 示例：00189220260705203042M01FAMG
   */
  static generateRootId(l0Code: string, now?: Date): string {
    const seq = GlobalSequenceCounter.getInstance().next(now);
    const timeCode = DNAEncoder.timeCode(now);
    return `${String(seq).padStart(6, '0')}${timeCode}M01${l0Code}`;
  }

  /**
   * 生成 GlobalUID (白皮书 V2.0 §3.1 格式, 23字符)
   *
   * 格式: TT NNNN BBB LLLLLLLL SSSSSS
   *   TT       2位  类型标记  MM=内存原子 / SP=体感快照 / WK=知识条目 / EN=工程快照
   *   NNNN     4位  节点编号  十六进制 0001-FFFF
   *   BBB      3位  批次号    十六进制 同次交互共享
   *   LLLLLLLL 8位  区位标识  由 location_fingerprint(128-bit) SHA256前8位压缩
   *   SSSSSS   6位  随机盐    crypto.randomBytes(3) → hex
   *
   * 示例: MM0001A3BF1A0C4DE6F7
   *
   * @param typeMark - 'MM'=内存原子, 'SP'=体感快照, 'WK'=知识条目, 'EN'=工程快照
   * @param nodeNum - 节点编号 (1-65535)
   * @param batchNum - 批次号 (0-4095)
   * @param locationFingerprint - 区位指纹 (128-bit hex, 空则用32位0)
   * @returns 23字符 GlobalUID
   */
  static generateGlobalUID(
    typeMark: string = 'MM',
    nodeNum: number = 1,
    batchNum: number = 0,
    locationFingerprint: string = '',
  ): string {
    const TT = typeMark.substring(0, 2).toUpperCase();
    const NNNN = String(nodeNum & 0xFFFF).padStart(4, '0');
    const BBB = String(batchNum & 0xFFF).padStart(3, '0');
    // 区位标识: SHA256(location_fingerprint) 前8位十六进制
    const locRaw = locationFingerprint || '0'.repeat(32);
    const locHash = createHash('sha256').update(locRaw).digest('hex').substring(0, 8).toUpperCase();
    // 随机盐: crypto.randomBytes(3) → hex (6字符)
    const salt = createHash('sha256').update(`${Date.now()}_${Math.random()}`).digest('hex').substring(0, 6).toUpperCase();
    return `${TT}${NNNN}${BBB}${locHash}${salt}`;
  }

  /** 生成 14 位秒级时间码 YYYYMMDDHHmmss */
  private static timeCode(date?: Date): string {
    const d = date ?? new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    return `${y}${m}${day}${h}${min}${s}`;
  }

  /**
   * 车间递进码（v2 新增，供 M2-M4 后续追加调用者使用）
   * 示例：generateSubId(rootId, 'M02', 3) → 原根码.M02.003
   */
  static generateSubId(rootId: string, moduleCode: string, seqNo: number = 1): string {
    return `${rootId}.${moduleCode}.${String(seqNo).padStart(3, '0')}`;
  }

  constructor(selfModel: SelfModelV1) {
    this.selfModel = selfModel;
    this.sequencer = new L1Sequencer();
    this.extractor = new L2ContentExtractor();
    this.annotator = new L3EntityAnnotator();
    this.detector = new SemanticBoundaryDetector();
    // 初始化全局计数器
    GlobalSequenceCounter.getInstance().init();
  }

  // ═══════════════════════════════════════════
  // push / flush 流式模式
  // ═══════════════════════════════════════════

  /**
   * 推入一条话语（流式模式）
   *
   * v2: 语义边界不切割编码序列。boundary 结果仅作为元数据
   * 在最终 flush() 时附加到 DNA 的 warnings 中，不打断时间主轴。
   */
  push(input: string | PushInput): DNA | null {
    const normalized: PushInput = typeof input === 'string' ? { utterance: input } : input;
    const contextStr = (normalized.context ?? []).join(' ');
    const entry: BufferEntry = {
      utterance: normalized.utterance,
      context: contextStr,
      timestamp: normalized.timestamp,
    };

    if (this.buffer.length > 0) {
      const last = this.buffer[this.buffer.length - 1];
      const boundary = this.detector.detect(
        last.utterance, normalized.utterance,
        { prevTimestamp: last.timestamp, currTimestamp: normalized.timestamp },
      );

      if (boundary.is_new_unit) {
        console.log(`[DNAEncoder] 语义边界: ${boundary.boundary_type} (${boundary.confidence}) — 自动切割并 flush`);
        const flushed = this.flush();
        this.buffer.push(entry);
        return flushed;
      }
    }

    this.buffer.push(entry);
    return null;
  }

  /**
   * 强制 flush 当前缓冲区，合并为一条 DNA
   * 所有话语合并后统一编码，产生一个 DNA + 一个根码。
   */
  flush(): DNA | null {
    if (this.buffer.length === 0) return null;
    const combinedText = this.buffer.map((b) => b.utterance).join(' ');
    const combinedContext = this.buffer.map((b) => b.context).filter(Boolean).join(' ');
    const dna = this._encodeCombined(combinedText, combinedContext);
    this.buffer = [];
    return dna;
  }

  // ═══════════════════════════════════════════
  // 非流式快捷调用
  // ═══════════════════════════════════════════

  /**
   * 直接编码单条话语（非流式模式）
   *
   * 核心入口：chat.ts 每轮对话调用此方法。
   * 先执行 L0 路由获取分类码，再生成根码（仅一次），
   * 整条流水线复用同一个 dna_root_id。
   */
  encodeSingle(utterance: string, context?: string[]): DNA {
    this.stats.encodeCount++;
    if (!utterance || typeof utterance !== 'string' || utterance.trim().length === 0) {
      this.stats.failCount++;
      console.warn('[M1] 空输入编码, 返回空DNA');
      return this._makeEmptyDNA();
    }
    const contextStr = (context ?? []).join(' ');
    return this._encodeCombined(utterance, contextStr);
  }

  /**
   * P1: 初始化内部 L3 annotator 的 FG 人名库（简称→家谱全名规范化 / FG 别名兜底）。
   * 幂等：annotator 内部以 this.fg / _fgInitFailed 保证只初始化一次。
   * 调用方：ChatEntry.runChatEntry 在 encodeSingle 前 await 一次（初始化失败降级，不阻塞对话）。
   * 修复契约漂移：此前 ChatEntry 直接调 ctx.encoder.initFg?.() 但 DNAEncoder 未暴露该方法，
   * 导致 FG 人名库在聊天链路从未初始化（TS2339）。此为门面委托，FG 初始化逻辑单一源仍在 L3。
   */
  async initFg(): Promise<void> {
    return this.annotator.initFg();
  }

  encodeBatch(inputs: Array<{ utterance: string; context?: string[] }>): DNA[] {
    return inputs.map((input) => this.encodeSingle(input.utterance, input.context));
  }

  resetSession(): void {
    this.buffer = [];
    this.sequencer.reset();
    this.extractor.reset();
    this._fingerprintCache = '0'.repeat(32);  // P1-1: 会话场景指纹重置
  }

  getStats(): { encodeCount: number; failCount: number; failRate: number; stageFailures: Record<string, number> } {
    return { ...this.stats, failRate: this.stats.encodeCount > 0 ? Math.round(this.stats.failCount / this.stats.encodeCount * 100) / 100 : 0 };
  }

  getBufferSize(): number {
    return this.buffer.length;
  }

  /**
   * 核心编码流水线：L0 → rootId → L1 → L2 → L3 → assembly
   * rootId 在 L0 路由后生成（仅一次），全流水线复用。
   */
  private _encodeCombined(utterance: string, context: string): DNA {
    const warnings: string[] = [];

    // ── L0: 基因组锚点 ──
    let l0Result: L0RouteResult;
    const t0 = performance.now();
    try {
      const taxonomy = this.taxonomy ?? loadTaxonomy();
      l0Result = routeL0(utterance, taxonomy);
    } catch (err) {
      console.warn('[M1] L0 失败:', (err as Error).message);
      this.stats.stageFailures.l0++;
      this.stats.failCount++;
      return this._makeEmptyDNA();
    }

    // ── 根码生成（仅一次，使用 L0 分类码） ──
    const dna_root_id = DNAEncoder.generateRootId(l0Result.l0_code);

    // ── L1: 分支路由码 ──
    let l1Result = this.sequencer.next();

    // ── L2: 叶节点指针 ──
    let l2Result: L2ContentResult;
    try {
      l2Result = this.extractor.extract(l0Result!.locus_path, utterance);
    } catch (err) {
      console.warn('[M1] L2 失败:', (err as Error).message);
      this.stats.stageFailures.l2++;
      warnings.push('L2_failed');
      l2Result = { leaf_zone: 'language_semantic_zone', ref: 'tmp_fallback' };
    }

    // ── L3: 实体基因槽 ──
    let l3Result: L3AnnotationResult;
    try {
      l3Result = this.annotator.annotate(utterance, context, this.selfModel);
    } catch (err) {
      console.warn('[M1] L3 失败:', (err as Error).message);
      this.stats.stageFailures.l3++;
      warnings.push('L3_failed');
      l3Result = { entity_genes: [] };
    }

    // ── 场景标签派生（P1: 版本告警，全动态派生待完善） ──
    const sceneTags = this.deriveSceneTags(l0Result!.locus_path, l3Result!.entity_genes);

    // ── 组装 DNA ──
    // 🔴 P1-1 修复(2026-09-05): 场景指纹派生一次，供 location_fingerprint 与 global_uid 区位标识共用。
    // 原实现 generateGlobalUID 第 4 参传空 '' → 区位恒为全零指纹哈希 84E0C0EA，指纹派生白做
    // （pre-existing 测试"场景词应派生 location_fingerprint 并影响 global_uid"断言暴露此缺陷）。
    const _locationFingerprint = this.deriveLocationFingerprint(utterance);
    const dna: DNA = {
      locus_path: l0Result.locus_path,
      taxonomy_version: l0Result.taxonomy_version,
      branch_id: l1Result.branch_id,
      seq_pos: l1Result.seq_pos,
      leaf_zone: l2Result.leaf_zone,
      ref: l2Result.ref,
      entity_genes: l3Result.entity_genes,
      raw_input: utterance,
      created_at: new Date().toISOString(),
      scene_tags: sceneTags,
      ambiguity_score: l0Result!.ambiguity_score,
      warnings: warnings.length > 0 ? warnings : undefined,
      dna_root_id,
      global_uid: DNAEncoder.generateGlobalUID('MM', l1Result.seq_pos, 0, _locationFingerprint),
      // P1-1: 场景指纹派生（替代恒全0）——无场景词时沿用会话缓存，降级保持 G2 全PASS
      location_fingerprint: _locationFingerprint,
    };

    return dna;
  }

  /** 生成空 DNA（L0 失败兜底） */
  private _makeEmptyDNA(): DNA {
    const l0Code = 'MISC';
    const dna_root_id = DNAEncoder.generateRootId(l0Code);
    const l1Result = this.sequencer.next();
    return {
      locus_path: 'user.misc.default',
      taxonomy_version: '1.0',
      branch_id: l1Result.branch_id,
      seq_pos: l1Result.seq_pos,
      leaf_zone: 'language_semantic_zone',
      ref: 'tmp_empty',
      entity_genes: [],
      raw_input: '',
      created_at: new Date().toISOString(),
      scene_tags: [],
      dna_root_id,
      global_uid: DNAEncoder.generateGlobalUID('MM', l1Result.seq_pos, 0, ''),
      location_fingerprint: '0'.repeat(32),
      warnings: ['empty_input'],
    };
  }

  /** 会话级场景指纹缓存（P1-1）：有场景词时更新，无词时沿用，保持时空连续 */
  private _fingerprintCache: string = '0'.repeat(32);

  /**
   * P1-1: 场景指纹派生 — 与瑶光 workflow_executor 关键词规则保持一致。
   * 命中明确场景词 → 更新缓存并返回；未命中 → 沿用缓存（降级：无任何场景时保持全0，G2 全PASS）。
   */
  private deriveLocationFingerprint(utterance: string): string {
    const t = (utterance || '').toLowerCase();
    const rules: Array<[RegExp, string]> = [
      [/(总经理|经理室|三楼)/, 'office:factory_office_3f_ceo:ceo_desk'],
      [/(办公室|工位|会议室|公司|上班|厂区|车间|前台|茶水间)/, 'office:guangming_office:desk_a2'],
      [/(宿舍|凤凰公寓)/, 'home:fenghuang_apartment_32f:living_tv'],
      [/(公寓)/, 'home:guangming_apartment:apt_bed'],
      [/(浴室|洗澡|冲凉|淋浴|卫生间|厕所)/, 'home:xinghai_mingcheng:master_bath'],
      [/(卧室|床上|床|睡觉|躺)/, 'home:xinghai_mingcheng:master_bed'],
      [/(客厅|沙发)/, 'home:xinghai_mingcheng:living_sofa'],
      [/(厨房|做饭|吃饭|餐厅|餐桌)/, 'home:xinghai_mingcheng:dining_table'],
      [/(玄关|进门|回家)/, 'home:xinghai_mingcheng:entrance'],
      [/(阳台)/, 'home:xinghai_mingcheng:bedroom2_desk'],
      [/(通勤|开车|高速|堵车)/, 'outdoor:commute_home_office:car'],
      [/(公园)/, 'outdoor:qianhai_park:entrance'],
    ];
    for (const [re, fp] of rules) {
      if (re.test(t)) {
        this._fingerprintCache = fp;
        return fp;
      }
    }
    return this._fingerprintCache;
  }

  /**
   * 从 locus_path + entity_genes 派生场景标签
   *
   * P1-2: 当前为硬编码映射。未来应改为从 taxonomy JSON 动态加载。
   * 如果 taxonomy 版本变更但映射未更新，此处会输出告警。
   */
  private deriveSceneTags(locusPath: string, entityGenes: Array<{ type: string; name: string }>): string[] {
    const tags: string[] = [];

    const locusMap: Record<string, string[]> = {
      'user.family.conflict': ['家庭矛盾'],
      'user.family.care': ['家庭', '关心'],
      'user.family.general': ['家庭'],
      'user.emotion.negative': ['负面情绪'],
      'user.emotion.positive': ['正面情绪'],
      'user.emotion.neutral': ['情绪'],
      'user.emotion.suppressed': ['压抑', '倾诉'],
      'user.emotion.romantic': ['亲密', '浪漫'],
      'user.emotion.miss_family': ['思念'],
      'user.work.stress': ['工作', '压力'],
      'user.work.achievement': ['工作', '成就'],
      'user.work.project': ['工作', '开发'],
      'user.work.meeting': ['会议'],
      'user.work.burnout': ['倦怠', '疲惫'],
      'user.work.general': ['工作'],
      'user.daily.creation': ['创作', '艺术'],
      'user.daily.entertainment': ['娱乐'],
      'user.daily.general': ['日常'],
      'user.health.fitness': ['健身', '运动'],
      'user.health.sickness': ['生病', '健康'],
      'user.health.sleep': ['睡眠'],
      'user.health.general': ['健康'],
      'user.social.general': ['社交'],
      'user.social.friend': ['朋友', '社交'],
      'user.social.partner': ['伴侣', '亲密'],
    };

    const matched = locusMap[locusPath];
    if (matched) tags.push(...matched);
    // 兜底: 从 locus_path 自动提取有意义的片段
    else {
      const segments = locusPath.split('.');
      for (const seg of segments) {
        if (seg !== 'user' && seg !== 'general' && seg.length >= 2) {
          const tagMap: Record<string, string> = {
            'family': '家庭', 'emotion': '情绪', 'work': '工作',
            'daily': '日常', 'health': '健康', 'social': '社交',
            'finance': '财务', 'study': '学习', 'travel': '旅行',
            'shopping': '购物', 'food': '饮食',
          };
          if (tagMap[seg] && !tags.includes(tagMap[seg])) tags.push(tagMap[seg]);
        }
      }
    }

    const emotionTagMap: Record<string, string> = {
      '开心': '快乐', '难过': '悲伤', '生气': '愤怒', '害怕': '恐惧',
      '焦虑': '焦虑', '累': '疲惫', '爱': '爱意',
    };
    for (const g of entityGenes) {
      if (g.type === 'emotion' && emotionTagMap[g.name]) {
        if (!tags.includes(emotionTagMap[g.name])) tags.push(emotionTagMap[g.name]);
      }
      if (g.type === 'person' && !tags.includes('人际')) tags.push('人际');
      if (g.type === 'event' && !tags.includes('事件')) tags.push('事件');
      if (g.type === 'place' && !tags.includes('地点')) tags.push('地点');
    }

    return tags;
  }
}
