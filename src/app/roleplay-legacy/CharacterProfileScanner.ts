/**
 * CharacterProfileScanner — 角色画像动态构建器
 *
 * 从多源（FG/知识库/对话上下文）提取被扮演角色的完整画像。
 * 核心价值：即使角色不在家族图谱中，也能从对话历史中拼出画像。
 *
 * ── 设计原则 ──
 * 1. 纯规则引擎，零 LLM 调用，毫秒级
 * 2. 明确区分「已知事实」和「未知边界」
 * 3. 家族图谱数据永远是合法数据，不是污染
 * 4. 退出角色后所有临时数据自动销毁
 *
 * ── 反幻觉铁律 ──
 * 信息缺口必须显式标注在「未知边界」中，LLM 看到后不会编造。
 * 知识缺口标注比知识本身更重要。
 */

// ─── 类型定义 ───

export interface CharacterExtract {
  /** 从对话中提取的年龄描述（如"14岁""20多岁"） */
  age: string | null;
  /** 从对话中提取的关系（如"妹妹""女儿"） */
  relations: string[];
  /** 从对话中提取的事件/近况（如"在学校读书""刚出差回来"） */
  events: string[];
  /** 从对话中提取的外貌描述 */
  appearance: string[];
  /** 从对话中提取的性格描述 */
  traits: string[];
  /** 从对话中提取的身份描述（如"徐家的长女""熊梓铭的妻子"） */
  identity: string[];
  /** 发现的总提及次数 */
  mentionCount: number;
}

export interface CharacterPortraitSources {
  fgContext?: string;      // 家族图谱分支输出
  kbContext?: string;      // 知识库检索结果
  historyContext?: string; // 历史扮演对话
  contextExtract?: CharacterExtract; // 对话上下文提取
}

export interface CharacterPortrait {
  identity: string;        // 身份锚点（一句话你是谁）
  age: string | null;      // 时间线锚点
  knownFacts: string[];    // 已知事实列表
  unknownBoundary: string[]; // 未知边界列表（反幻觉核心）
  traits: string[];        // 性格速写
  memoryContext: string;   // 最近相关对话
  sourceCount: number;     // 信息来源数
}

// ─── 对话上下文扫描器 ───

/** 从最近对话历史中提取角色信息（纯规则，零 LLM） */
export function scanContextForCharacter(
  charName: string,
  history: Array<{ role: string; content: string }>,
  maxTurns: number = 30,
): CharacterExtract {
  const extract: CharacterExtract = {
    age: null, relations: [], events: [],
    appearance: [], traits: [], identity: [],
    mentionCount: 0,
  };

  // 扫描最近 N 轮对话
  const recent = history.slice(-maxTurns);
  for (const turn of recent) {
    const text = turn.content;
    if (!text.includes(charName) && !hasCoreference(text, charName)) continue;
    extract.mentionCount++;

    // 年龄提取：诗韵才14岁 / 诗韵14岁 / 14岁的诗韵
    if (!extract.age) {
      const ageMatch = text.match(
        new RegExp(`${charName}[才刚]?(\\d+)岁|${charName}(?:今年|现在)?(\\d+)[,，]?岁|(\\d+)岁[的，]${charName}`)
      );
      if (ageMatch) {
        extract.age = (ageMatch[1] || ageMatch[2] || ageMatch[3]) + '岁';
      }
    }

    // 身份提取：诗韵是徐家的大女儿 / 她是你的妹妹
    const identityMatches = text.matchAll(
      new RegExp(`${charName}(?:是|叫做|被称为|乃)([^，。！？\\n]{2,20})`, 'g')
    );
    for (const m of identityMatches) {
      const val = m[1].trim();
      if (val.length >= 2 && !extract.identity.includes(val)) {
        extract.identity.push(val);
      }
    }

    // 关系提取：你妹妹诗韵 / 诗韵是你妹妹
    const relationMatches = text.matchAll(
      new RegExp(
        `(?:我的|你的|用户的?|他[的]?|她[的]?|我[的]?)(${charName})` +
        `|${charName}(?:是|就是我?的|就是你?的|就是)([^，。！？\\n]{1,10})` +
        `|称呼${charName}为([^，。！？\\n]{1,8})`,
        'g'
      )
    );
    for (const m of relationMatches) {
      const val = (m[1] || m[2] || m[3] || '').trim();
      if (val.length >= 1 && !extract.relations.includes(val) && val !== charName) {
        extract.relations.push(val);
      }
    }

    // 近况事件提取：诗韵在学校 / 诗韵最近在忙什么
    const eventMatches = text.matchAll(
      new RegExp(`${charName}([^。！？]{5,40})`, 'g')
    );
    for (const m of eventMatches) {
      const val = m[1].trim();
      // 过滤掉纯关系描述和太短的匹配
      if (val.length >= 5 && !/^(是|叫|有|在|的)/.test(val) && !extract.events.includes(val)) {
        // 如果包含关系词则跳过（避免关系描述混入事件）
        if (/是(我|你|他|她|用户)/.test(val)) continue;
        extract.events.push(val);
      }
    }

    // 外貌提取：很漂亮的诗韵 / 诗韵长得很清秀
    const appearMatches = text.matchAll(
      new RegExp(`${charName}(?:长[得地]|看起来|生[得地]|很高|很漂亮|很可爱|很清秀|很美|好美)`, 'g')
    );
    for (const m of appearMatches) {
      const sentStart = text.lastIndexOf('。', m.index) + 1;
      const sentEnd = text.indexOf('。', m.index);
      const sentence = text.substring(sentStart, sentEnd > sentStart ? sentEnd : text.length).trim();
      if (sentence.length >= 4 && !extract.appearance.includes(sentence)) {
        extract.appearance.push(sentence);
      }
    }
  }

  // 去重 + 截断
  extract.relations = [...new Set(extract.relations)].slice(0, 8);
  extract.events = [...new Set(extract.events)].slice(0, 8);
  extract.appearance = [...new Set(extract.appearance)].slice(0, 3);

  return extract;
}

/** 判断文本是否通过代词指代目标人物（简化版：检查"她""他"在上下文中指代谁） */
function hasCoreference(text: string, charName: string): boolean {
  // 简单规则：如果前一句出现了人物名，这一句的"她/他"可能指代同一个人
  // 在扫描器中我们不处理跨句指代，只处理显式提及
  return false;
}

// ─── 未知边界生成器（反幻觉核心） ───

/**
 * 根据已知信息自动生成「你不知道什么」。
 * 🔴 铁律：信息缺口的显式标注比知识本身更重要。
 * LLM 看到明确写"不知道"的条目，不会编造。
 */
export function buildUnknownBoundary(
  charName: string,
  knownFields: { appearance: boolean; location: boolean; voice: boolean; history: boolean; relationships: boolean },
): string {
  const unknowns: string[] = [];

  if (!knownFields.appearance) {
    unknowns.push(`你没有见过${charName}本人，完全不知道他/她长什么样、穿什么衣服、有什么表情和神态。`);
  }
  if (!knownFields.location) {
    unknowns.push(`你不知道${charName}现在在哪里——他/她的住址、当前位置、周围环境你一概不知。`);
  }
  if (!knownFields.voice) {
    unknowns.push(`你不知道${charName}说话的声音、语气、语调——你从没听过他/她说话。`);
  }
  if (!knownFields.history) {
    unknowns.push(`你不知道${charName}过去经历过什么具体事件——除非用户刚才在对话中告诉过你。用户说了你才知道，没说的你别编。`);
  }
  if (!knownFields.relationships) {
    unknowns.push(`你不知道${charName}和其他人的具体关系细节——只知道用户提到过的基本关系。`);
  }

  if (unknowns.length === 0) return '';
  return `\n【⚠️ 未知边界 — 以下信息你不知道，绝对不要自己编造】\n${unknowns.map((u, i) => `${i + 1}. ${u}`).join('\n')}`;
}

/** 从 CharacterExtract 推断已知字段 */
export function inferKnownFields(extract: CharacterExtract, hasFg: boolean, hasKb: boolean): {
  appearance: boolean; location: boolean; voice: boolean; history: boolean; relationships: boolean;
} {
  return {
    appearance: hasFg || hasKb || extract.appearance.length > 0,
    location: false,  // 位置几乎永远不知道
    voice: false,      // 声音永远不知道
    history: hasFg || hasKb || extract.events.length > 0,
    relationships: hasFg || extract.relations.length > 0,
  };
}

// ─── 画像装配器 ───

/**
 * 构建完整的角色画像（结构化，带身份锚点、已知事实、未知边界）
 *
 * 输出格式清晰标记三段：
 * ✅ 已知事实 — LLM 可以放心使用
 * ⚠️ 未知边界 — LLM 绝对不能编造
 */
export function assembleCharacterPortrait(
  charName: string,
  sources: CharacterPortraitSources,
): string {
  const parts: string[] = [];
  const extract = sources.contextExtract || {
    age: null, relations: [], events: [],
    appearance: [], traits: [], identity: [],
    mentionCount: 0,
  };

  // ── Part 1: 身份锚点（一句话你是谁） ──
  const identityLine = sources.fgContext
    ? extractIdentityFromFg(sources.fgContext, charName)
    : (extract.identity[0] || `你是${charName}`);
  parts.push(`■ 你是谁\n${identityLine}`);

  // ── Part 2: 已知事实 ──
  const facts: string[] = [];

  // 年龄/时间锚点
  if (extract.age) {
    facts.push(`【年龄/时段】${charName}今年${extract.age}`);
  }

  // 关系（优先 FG，其次对话提取）
  if (sources.fgContext) {
    facts.push(sources.fgContext);
  } else if (extract.relations.length > 0) {
    facts.push(`【关系】${charName}和用户的关系：${extract.relations.join('、')}`);
  }

  // 知识库背景
  if (sources.kbContext) {
    facts.push(sources.kbContext);
  }

  // 事件/近况
  if (extract.events.length > 0) {
    facts.push(`【近况】用户刚才提到${charName}：${[...new Set(extract.events)].join('；')}`);
  }

  // 历史扮演
  if (sources.historyContext) {
    facts.push(sources.historyContext);
  }

  if (facts.length > 0) {
    parts.push(`\n■ 已知信息（下列信息是可靠的，可以放心使用）\n${facts.join('\n\n')}`);
  }

  // ── Part 3: 未知边界（反幻觉核心） ──
  const hasFg = !!sources.fgContext;
  const hasKb = !!sources.kbContext;
  const unknownBlock = buildUnknownBoundary(charName, inferKnownFields(extract, hasFg, hasKb));
  if (unknownBlock) parts.push(unknownBlock);

  // ── Part 4: 性格速写（可选） ──
  if (extract.traits.length > 0) {
    parts.push(`\n■ 性格\n${[...new Set(extract.traits)].join('、')}`);
  }

  return `【角色画像：${charName}】\n━━━━━━━━━━━━━━━━━━━━\n${parts.join('\n\n')}\n━━━━━━━━━━━━━━━━━━━━`;
}

/** 从 FG 分支文本中提取核心身份描述 */
function extractIdentityFromFg(fgText: string, charName: string): string {
  // FG 文本通常以"【角色家族树】xxx视角"或人物描述开头
  const firstLine = fgText.split('\n')[0] || '';
  if (firstLine.includes(charName)) return firstLine;
  return `你是${charName}，${fgText.substring(0, 40)}`;
}
