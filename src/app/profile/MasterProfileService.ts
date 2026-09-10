/**
 * MasterProfileService — 主人大脑镜像服务
 *
 * 双翼架构：
 *   主观世界 — 主人是谁（精神/内心/感官/生活/娱乐/健康/学习）
 *   客观世界 — 主人与世界打交道（工作/人脉/事务/事件）
 *
 * 原则：
 *   - 只记主人主动说的/回答玉瑶问题的
 *   - 每条信息需通过审查关卡（钙质+实体）
 *   - 去重：相同内容更新置信度，不重复插入
 *
 * A1 重构(2026-09-05)：「整句存→事实提炼」
 *   - 画像=主人真实自我事实。规则命中≠存整句，规则只是"值得花 LLM"的候选门槛
 *   - 提炼三级：LLM 提炼(节流) → 规则短语兜底 → 宁缺勿存。任何路径都不再原句入库
 *   - 价值闸：扮演框架语/驱动命令语（对角色说的话）非主人自我陈述，直接拦截
 *   - 亲密/扮演内容守卫：intimateSkip(app-identity 单一源词表)命中→空（见 extract）
 *   - 会晤语境守卫在调用端(chat.ts !_meetingEntityName)，见存档 2026-09-05-wenstar-structure-mainline
 */
import type { SQLiteAdapter } from '../../m2/SQLiteAdapter.js';
import { FILTER_KEYWORDS } from '../../config/app-identity.js';

// ── 主观世界 8 维度关键词（A1 收窄：只认带"我"前缀的自我陈述，砍裸宽词） ──
const SUBJECTIVE_RULES: Array<{ category: string; keywords: RegExp[] }> = [
  { category: 'world_view', keywords: [/我[相认觉]/] },
  { category: 'inner_world', keywords: [/我感(觉|到|受)/, /我(害怕|焦虑|难过|开心|委屈|压[力抑])/, /我[需想]要/, /我(担[心忧]|恐[惧怕])/, /我最近(心情|状态)/, /我有点[烦累忙乱]/] },
  { category: 'sensory', keywords: [/我[喜爱]欢[吃喝听看闻]/, /我觉得(好吃|好听|好看|舒服|爽)/, /我(?:觉得|感觉)(?:很|挺|真)?(?:好吃|好喝|好听|好看|舒服|享受)/] },
  { category: 'life', keywords: [/我[^，。！？]{0,12}(?:家住|住在|家是)/, /我(?:平时|每天|经常|习惯)/, /我(?:的)?(?:女儿|儿子|孩子|闺女|宝宝|家人|父母|老婆|老公|妻子|丈夫)/, /我(?:的)?日常/] },
  { category: 'entertainment', keywords: [/我[喜爱](玩|打|看|追|听)/, /我的(爱[好]?|兴[趣]?)/, /我[在去](健[身]?|运[动]?|游[泳]?|跑[步]?)/, /我[喜爱]?[玩看][一-龥]*/] },
  { category: 'health', keywords: [/我(?:生病|失眠|头痛|哪里不舒服|不舒服|体检|吃药)/, /我(?:睡[不着]?|熬夜)/, /我[^，。！？]{0,10}(?:焦虑|失眠|压力大|很累|头痛|不舒服)/, /我(?:最近|一直|这段时间)[^，。！？]{0,8}(?:身体|状态)/] },
  { category: 'learning', keywords: [/我在[学看读]/, /我[学看读](书|课|画|琴|摄影)/, /我最[近]?在[学研究]/, /我在学/] },
  { category: 'spiritual', keywords: [/我[相认觉]为/, /我的(原则|信仰|价值观|人生观)/, /我(信仰|相信|觉得人)/] },
];

// ── 客观世界关键词（A1：保留，命中后经提炼/短语兜底把关） ──
const OBJECTIVE_RULES: Array<{ table: string; category: string; keywords: RegExp[] }> = [
  { table: 'affairs', category: 'project', keywords: [/我[^，。！？]{0,14}(?:项目|负责|跟进|对接|客户|合同|开会|汇报|方案)/] },
  { table: 'affairs', category: 'decision', keywords: [/我考[虑]?[要]?跳[槽]/ , /我在(?:考想)要不要/, /我决[定]/, /我选[择择]/] },
  { table: 'network', category: 'person', keywords: [/我(同事|客[户]|合[作伙]|老[板]|上[司]|朋[友友])/, /我(?:的)?(?:同事|朋友|老板|上司|客户)/] },
  { table: 'events', category: 'achievement', keywords: [/我(?:搞[定]|成[功]|完[成]|拿[下]|终于|毕[业]|入[职职]|升[职职])/, /我(?:最近|今天|这周)?(?:搞定|完成|拿下)/] },
  { table: 'events', category: 'milestone', keywords: [/我(?:上[个月]|去[年]|之[前前]|以[前前]|第[一]次|记[得]|有[一]次)/] },
];

// ── A1 价值闸：扮演框架 / 驱动命令 → 对角色说的话，非主人自我事实，拦截 ──
const DIALOGUE_DRIVEN: RegExp[] = [
  /以.{1,10}(?:的)?口吻/,               // "用8岁小女孩的口吻给我说说"
  /扮演|角色扮演|cosplay/i,            // 扮演指令
  /假装你是/,
  /你来(?:当|做|演)/,
  /给我(?:好好|仔细)?(?:说说|讲讲|描述|介绍|看看)/,   // "给我好好说说你的身子"
  /你想(?:要)?我(?:现在)?(?:做|干|给|说|讲|回答|表演)/, // "你想我现在做什么吗"
  /说(?:说)?(?:你|一下)(?:的)?(?:身体|身材|感觉|里面)/,  // 驱动对方描述身体
];

// ── A1 降级短语抽取器：无 LLM / LLM 失败/节流时兜底 ──
// 只认高确定性主人事实模式（每条恰好 1 个捕获组 = 要沉淀的短语）。
// 抽不到 = 该句不沉淀（宁缺勿污；等 LLM 恢复，同类句未来再现仍可提炼）。
// 触发样例 → 期望短语：
//   "我是一名产品经理" → 产品经理      "我家住在深圳南山区" → 深圳南山区
//   "我女儿今年上小学二年级" → 今年上小学二年级  "我最近在学摄影" → 摄影
//   "我最近压力大" → 压力大             "我平时喜欢去公园跑步" → 公园跑步
const FACT_FALLBACKS: RegExp[] = [
  /我(?:是|现在做|现在是)(?:一个|一名|个)?([一-龥]{2,6}(?:师|经理|员|工程师|老师|医生|会计|律师|主管|总监|老板|设计师|编辑|记者))/,   // 职业
  /我(?:家|老家)?(?:住在|住)([一-龥0-9]{2,16}(?:省|市|区|县|镇|村|路|小区|公寓|花园|苑))/,   // 住址
  /我(?:的)?(?:女儿|儿子|孩子|闺女|宝宝)([一-龥0-9]{2,18})/,   // 子女近况
  /我(?:在|正在|最近在|最近)?(?:学|练|读|研究)([一-龥0-9]{1,14})/,   // 学习内容
  /我(?:最近|这段时间|一直)(?:都)?(?:很|挺|有点)?(焦虑|失眠|压力大|不舒服|很累|头痛|难过|开心|烦)/,   // 近况情绪
  /我(?:平时|每天|经常|习惯|下班后|周末)(?:都)?(?:会|在)?(?:喜欢|爱)?(?:去|打|看|玩|听|画|读|跑|健|游)([一-龥0-9]{1,14})/,   // 习惯
];

// ── A1 LLM 提炼 prompt：把句子提炼成"主人稳定自我事实短语"，剥对白/命令/扮演成分 ──
const PROFILE_EXTRACT_PROMPT = (text: string) => {
  const categories = 'world_view(精神)/inner_world(内心)/sensory(感官)/life(生活)/entertainment(娱乐)/health(健康)/learning(学习)/spiritual(精神)';
  const objCategories = 'project(项目)/decision(决策)/person(人脉)/achievement(成就)/milestone(事件)';
  return `你是主人的记忆管家。从下面这句"主人说的话"中，提炼出关于主人的【稳定自我事实】（如职业、家人、住址、习惯、偏好、近况、观点、进行中的事）。
规则：
1. 只提炼事实，去掉对白语气/命令/请求/扮演成分（"给我…""你想…""以…口吻"这类全去掉）。
2. 若整句只是互动语言/扮演语言/对角色说的话，没有可沉淀的主人事实，返回 {"extracted": false}。
3. 事实用简洁中文短语（≤40字），主语用"我"。
类别(主观): ${categories}  类别(客观): ${objCategories}
文本: "${text}"
输出JSON: {"extracted": true, "category": "类别", "subcategory": "可空", "content": "提炼后的事实短语", "table": "affairs|network|events|(主观可省)", "personName": "若人脉类给人名，否则省略"}`;
};

export interface ExtractResult {
  /** 主观世界条目 */
  subjective: Array<{ category: string; subcategory?: string; content: string }>;
  /** 客观世界条目 */
  objective: Array<{ table: 'affairs' | 'network' | 'events'; category: string; content: string; personName?: string }>;
}

// ── A1 节流：LLM 提炼成本窗口（默认 60s 内最多 3 次） ──
const LLM_WINDOW_MS = 60_000;
const LLM_MAX_PER_WINDOW = 3;

export class MasterProfileService {
  private sqlite: SQLiteAdapter;
  private _llmBudget = { windowStart: 0, count: 0 };

  constructor(sqlite: SQLiteAdapter) {
    this.sqlite = sqlite;
  }

  /** A1：LLM 提炼节流闸——窗口内超次数则本次不调用（宁缺，画像更新可稍候） */
  private _canUseLlm(): boolean {
    const now = Date.now();
    if (now - this._llmBudget.windowStart > LLM_WINDOW_MS) {
      this._llmBudget = { windowStart: now, count: 0 };
    }
    if (this._llmBudget.count >= LLM_MAX_PER_WINDOW) return false;
    this._llmBudget.count++;
    return true;
  }

  /** A1：价值闸——扮演框架/驱动命令语是"对角色说的话"，非主人自我陈述 */
  private _isDialogueDriven(text: string): boolean {
    return DIALOGUE_DRIVEN.some((re) => re.test(text));
  }

  /** A1：降级短语抽取——抽主人第一人称稳定事实短语；抽不到返回空（宁缺） */
  private _fallbackExtract(text: string): string | null {
    for (const re of FACT_FALLBACKS) {
      const m = text.match(re);
      if (m && m[1]) {
        const phrase = m[1].trim();
        // 短语质量：≥2字、不含驱动/疑问/语气尾
        if (phrase.length >= 2 && phrase.length <= 26
            && !/[你我看]?(?:好不好|吧|呢|啊|呀)$/.test(phrase)
            && !/^(?:我|你)/.test(phrase)) {
          return phrase;
        }
      }
    }
    return null;
  }

  /**
   * 提取主人信息（A1 重构：规则粗筛候选 → LLM 事实提炼 → 短语兜底 → 宁缺）
   *
   * 存储形态翻转：规则命中不再直接把整句当 content 入库。
   * content 只可能是：① LLM 提炼出的事实短语 ② 规则捕获组抽出的短语。
   * 两条路都失败 → 返回空，这条消息不沉淀为画像（宁缺勿污）。
   */
  async extract(text: string, calciumScore: number, llmGenerate?: (prompt: string) => Promise<string>): Promise<ExtractResult> {
    // 🔴 A' 自我语境守卫(2026-09-05): 亲密/性扮演语境的消息不提取用户画像。
    // 用户在会晤亲密互动中的话（命中 intimateSkip 亲密词表）是互动语言，不是真实自我陈述——
    // 提取会污染 master_profile（用户真实画像），进而玉瑶注入画像时被带偏/回复异常。
    // intimateSkip 为 app-identity 单一源词表（同知识归纳过滤），画像守卫复用其语义：亲密内容不入长期画像。
    // 宁缺勿污：命中的消息多为无画像价值的互动短句，拦错代价远小于污染画像。
    if (FILTER_KEYWORDS.intimateSkip.some(w => text.includes(w))) {
      return { subjective: [], objective: [] };
    }
    // 🔴 A1 价值闸：扮演框架/驱动命令语对角色说的话不入主人画像（"用8岁的口吻…"等在此拦截）
    if (this._isDialogueDriven(text)) {
      return { subjective: [], objective: [] };
    }

    const result: ExtractResult = { subjective: [], objective: [] };

    // 1. 主人自称门槛：画像=主人第一人称自我事实；无"我"的句子（纯发问/陈述他人/客观播报）不沉淀。
    //    （会晤中对角色的互动语言已在调用端 !_meetingEntityName 守卫拦截）
    if (!/我/.test(text)) return result;

    // 2. 规则粗筛 → 归类（仅供 LLM 不可用/失败时 fallback 的类目归属；不再阻塞 LLM 提炼，
    //    真实 category 优先由 LLM 判定）
    let hitCategory: { side: 'subjective' | 'objective'; category: string; table?: string } | null = null;
    for (const rule of SUBJECTIVE_RULES) {
      if (rule.keywords.some((kw) => kw.test(text))) { hitCategory = { side: 'subjective', category: rule.category }; break; }
    }
    if (!hitCategory) {
      for (const rule of OBJECTIVE_RULES) {
        if (rule.keywords.some((kw) => kw.test(text))) { hitCategory = { side: 'objective', category: rule.category, table: rule.table as any }; break; }
      }
    }

    // 3. LLM 事实提炼（节流）：成功且 extracted → 存提炼短语
    if (llmGenerate && this._canUseLlm()) {
      try {
        const llmRaw = await Promise.race([
          llmGenerate(PROFILE_EXTRACT_PROMPT(text)),
          new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
        ]);
        const parsed = JSON.parse(llmRaw);
        if (parsed && parsed.extracted === true && parsed.content && String(parsed.content).trim().length > 0) {
          const content = String(parsed.content).trim().substring(0, 40);
          const cat = String(parsed.category || hitCategory?.category || 'life');
          const isSubjective = ['world_view','inner_world','sensory','life','entertainment','health','learning','spiritual'].includes(cat);
          if (isSubjective) {
            result.subjective.push({ category: cat, subcategory: parsed.subcategory ? String(parsed.subcategory) : undefined, content });
          } else {
            const table = parsed.table === 'network' ? 'network' : parsed.table === 'events' ? 'events' : 'affairs';
            const obj: { table: 'affairs' | 'network' | 'events'; category: string; content: string; personName?: string } = {
              table: table as any, category: cat, content,
            };
            if (parsed.personName) obj.personName = String(parsed.personName).substring(0, 12);
            result.objective.push(obj);
          }
          return result;
        }
        // extracted:false → LLM 判定无画像价值，宁缺
        return { subjective: [], objective: [] };
      } catch { /* LLM 失败/超时 → 走短语兜底降级 */ }
    }

    // 4. 短语兜底（无 LLM / 节流 / LLM 失败）：抽不到 → 宁缺勿存
    const phrase = this._fallbackExtract(text);
    if (phrase) {
      // 无规则命中时归 subjective/life（短语本身即主人生活事实，不猜客观表避免错建事务）
      if (!hitCategory || hitCategory.side === 'subjective') {
        result.subjective.push({ category: hitCategory ? hitCategory.category : 'life', content: phrase });
      } else {
        const table = (hitCategory.table as any) || 'affairs';
        result.objective.push({ table: table as any, category: hitCategory.category, content: phrase });
      }
    }
    return result;
  }

  /**
   * 审查关卡：钙质 >= 0.5 且 有实体 → 通过
   */
  review(text: string, calciumScore: number, hasEntity: boolean): boolean {
    if (!text || text.length < 3) return false;
    if (calciumScore >= 0.5 && hasEntity) return true;
    // 钙质较低但有明确的主人自称声明也通过
    if (/我/.test(text) && /[是在学的做想去有会能爱喜恨感]/.test(text) && text.length > 5) return true;
    if (/我的/.test(text) && text.length > 4) return true;
    // 中文话题式表达：描述自身状态/行为（含"了"、"在"、"觉得"、"最近"等）
    if (/在[学做画看听玩]/.test(text) || /觉得/.test(text) || /最近/.test(text)) return true;
    // 表达主观感受
    if (/很喜欢|想[学去玩]|有点[烦累忙]|太[好了累烦]|不错|有意思|喜欢/.test(text)) return true;
    return false;
  }

  /**
   * 存储：写入对应表（content 已是提炼后的事实短语，A1 不再原句入库）
   */
  store(text: string, result: ExtractResult): void {
    console.log('[Mirror] storing:', JSON.stringify({subj: result.subjective.length, obj: result.objective.length}));
    if (result.subjective.length > 0) console.log('[Mirror] subj[0]:', JSON.stringify(result.subjective[0]));
    if (result.objective.length > 0) console.log('[Mirror] obj[0]:', JSON.stringify(result.objective[0]));
    const now = new Date().toISOString();

    // 主观世界 → master_profile
    for (const item of result.subjective) {
      if (!item.category) continue;
      const existing = this.sqlite.queryAll(
        'SELECT id, mention_count, confidence FROM master_profile WHERE category = ? AND content LIKE ? ORDER BY last_seen DESC LIMIT 1',
        [item.category, '%' + item.content.substring(0, 30) + '%']
      );
      if (existing.length > 0) {
        this.sqlite.writeRaw(
          'UPDATE master_profile SET mention_count = mention_count + 1, confidence = MIN(1.0, confidence + 0.05), last_seen = ? WHERE id = ?',
          now, existing[0].id
        );
      } else {
        const id = 'prof_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6);
        try {
          this.sqlite.writeRaw(
            'INSERT INTO master_profile (id, category, subcategory, content, source, confidence, calcium_score, mention_count, first_seen, last_seen, tags) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)',
            id, String(item.category || 'unknown'), item.subcategory || '', String(item.content), 'auto_extract', 0.5, now, now, JSON.stringify(['auto_extract'])
          );
        } catch(e) { console.warn('[Mirror] store failed:', String(item.category), String(item.content).substring(0,20), e instanceof Error ? e.message : String(e)); }
      }
    }

    // 客观世界 → master_affairs / master_network / master_events
    for (const item of result.objective) {
      if (!item.category) continue;
      if (item.table === 'affairs') {
        // 去重：相同标题+活跃状态不重复创建
        const existing = this.sqlite.queryAll(
          "SELECT id FROM master_affairs WHERE status = 'active' AND title LIKE ?",
          ['%' + item.content.substring(0, 20) + '%']
        );
        if (existing.length === 0) {
          const id = 'aff_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6);
          this.sqlite.writeRaw(
            'INSERT INTO master_affairs (id, category, title, status, description, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            id, String(item.category), String(item.content).substring(0, 60), 'active', String(item.content), 'auto_extract', now, now
          );
        }
      }
      if (item.table === 'network') {
        // A1 宁缺：人脉建档只认 LLM 提炼的 personName（具体人名）。
        // 无 personName 不猜测建档——旧版从整句抽 2-3 字当人名，曾把"有个笑"当人名入库。
        const foundName = item.personName || null;
        if (foundName) {
          const existing = this.sqlite.queryAll('SELECT id FROM master_network WHERE person_name = ?', [foundName]);
          if (existing.length === 0) {
            const id = 'net_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6);
            this.sqlite.writeRaw(
              'INSERT INTO master_network (id, person_name, relation_type, context, importance, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
              id, foundName, String(item.category), String(item.content), now, now
            );
          }
        }
      }
      if (item.table === 'events') {
        const id = 'evt_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6);
        this.sqlite.writeRaw(
          'INSERT INTO master_events (id, event_type, title, summary, created_at) VALUES (?, ?, ?, ?, ?)',
          id, String(item.category), String(item.content).substring(0, 60), String(item.content), now
        );
      }
    }
  }

  /**
   * 检索：获取关于主人的信息摘要（用于回复前注入）
   */
  retrieveAboutYou(limit = 6): string {
    // 主观世界：高置信度优先
    const profile = this.sqlite.queryAll(
      'SELECT category, content, confidence FROM master_profile ORDER BY confidence DESC, last_seen DESC LIMIT ?',
      [limit]
    );
    // 客观世界：活跃事务优先
    const affairs = this.sqlite.queryAll(
      "SELECT title, category FROM master_affairs WHERE status = 'active' ORDER BY priority DESC, updated_at DESC LIMIT 3"
    );
    // 最近事件
    const events = this.sqlite.queryAll(
      'SELECT title, event_type FROM master_events ORDER BY created_at DESC LIMIT 2'
    );
    // 重要人脉
    const network = this.sqlite.queryAll(
      'SELECT person_name, relation_type, organization FROM master_network WHERE importance >= 1 OR importance IS NULL ORDER BY last_contact DESC LIMIT 3'
    );

    const lines: string[] = [];
    const cats: Record<string, string> = { world_view:'精神', inner_world:'内心', sensory:'感官', life:'生活', entertainment:'娱乐', health:'健康', learning:'学习', spiritual:'精神', project:'项目', client:'客户', decision:'决策', person:'人脉', achievement:'成就', milestone:'事件' };

    for (const p of profile) {
      const label = cats[p.category as string] || p.category;
      lines.push('- ' + (p.content as string).substring(0, 60) + '（' + label + '）');
    }
    for (const a of affairs) {
      lines.push('- 在做' + (a.title as string).substring(0, 40) + '（工作）');
    }
    for (const e of events) {
      const label = cats[e.event_type as string] || e.event_type;
      lines.push('- ' + (e.title as string).substring(0, 40) + '（' + label + '）');
    }
    for (const n of network) {
      const org = n.organization ? '(' + n.organization + ')' : '';
      lines.push('- ' + n.person_name + org + '（人脉）');
    }

    if (lines.length === 0) return '';
    return '【关于你】我知道的你：\n' + lines.slice(0, limit).join('\n') + '\n';
  }

  /**
   * 轻量写入（供 SleepTimeConsolidator 语义归纳回写用户画像）
   * 仅写 master_profile 表，去重 + 置信度递增
   */
  upsert(params: {
    category: string;
    subcategory?: string;
    content: string;
    source?: string;
    confidence?: number;
  }): void {
    const { category, subcategory, content, source, confidence } = params;
    if (!category || !content) return;
    const now = new Date().toISOString();
    const existing = this.sqlite.queryAll(
      'SELECT id, mention_count, confidence FROM master_profile WHERE category = ? AND content LIKE ? ORDER BY last_seen DESC LIMIT 1',
      [category, '%' + content.substring(0, 30) + '%']
    );
    if (existing.length > 0) {
      this.sqlite.writeRaw(
        'UPDATE master_profile SET mention_count = mention_count + 1, confidence = MIN(1.0, confidence + ?), last_seen = ? WHERE id = ?',
        confidence || 0.05, now, existing[0].id
      );
    } else {
      const id = 'prof_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6);
      try {
        this.sqlite.writeRaw(
          'INSERT INTO master_profile (id, category, subcategory, content, source, confidence, calcium_score, mention_count, first_seen, last_seen, tags) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)',
          id, category, subcategory || '', content, source || 'sleep_consolidation', confidence || 0.5, now, now,
          JSON.stringify(['auto_inducted', source || 'sleep_consolidation'])
        );
      } catch (e) { console.warn('[MasterProfile] upsert失败', category, e instanceof Error ? e.message : String(e)); }
    }
  }
}
