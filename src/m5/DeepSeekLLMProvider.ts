/**
 * DeepSeekLLMProvider — 玉瑶 · 太虚境 LLM 驱动
 *
 * 使用 DeepSeek V4 API（兼容 OpenAI 格式），注入灵肉伴侣人设。
 * 支持对话历史注入，让模型拥有真实的对话连续性记忆。
 *
 * 环境变量:
 *   DEEPSEEK_API_KEY — 你的 DeepSeek API Key
 *   DEEPSEEK_MODEL — 模型名，默认 deepseek-v4-flash
 */
import type { LLMProvider, StrategyConfig, CognitionObject, ConversationTurn } from './types/index.js';
import { buildSystemPrompt, STYLE_ANCHORS } from './persona/lover-persona.js';
import { calcLevel } from './expression/TierVocabMap.js';
import { calcExpressionSpec } from './expression/ExpressionSpecController.js';
import { renderIntimateResponse } from './expression/IntimateRenderer.js';
import type { IntimateSceneType } from './expression/IntimateRenderer.js';
import type { IPersona } from '../app/persona/types.js';
import { getKeyValue } from '../app/shared/ApiKeyStorage.js';
import { classify, type RoleType, type RoleDecision } from '../app/role/RoleClassifier.js';
import { buildRoleSystemPrompt } from '../app/role/RoleProfiles.js';
import { evaluateTransition, createInitialState, type TransitionState } from '../app/role/TransitionManager.js';
import { validateRoleOutput, getFallbackRole } from '../app/role/RoleGuard.js';

// 改造④：不在模块级读 process.env，构造函数中通过 ConfigService 运行时获取
import { ConfigService } from '../config/ConfigService.js';

const BASE_URL = 'https://api.deepseek.com/v1';
const MAX_HISTORY_TURNS = 200;
// FIX-3: 工作消息时缩减历史（防止亲密历史污染工作上下文）
function getHistoryLimit(txt: string): number {
  if (/工作|项目|客户|会议|方案|报告|公司|合同|预算|数据|分析|策略|设计|电机|采购|成本|温升|版本|产品|技术|报价|订单|生产|测试|样品|图纸|规格|性能|参数|工程|研发|工艺|质量|供应商/.test(txt)) return 10;
  return MAX_HISTORY_TURNS;
}

/** P3: 分级超时 — 日常10s / 冲突15s / 亲密20s */
function getTieredTimeout(level: number): number {
  if (level >= -1 && level <= 0) return 10000;  // 日常
  if (level <= -2) return 15000;                // 冲突
  return 20000;                                  // 亲密
}

interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface DeepSeekResponse {
  choices: Array<{
    message: { content: string; reasoning_content?: string };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/** 运行时获取 API Key（优先环境变量，其次运行时存储） */
function resolveApiKey(): string | undefined {
  return process.env['DEEPSEEK_API_KEY'] || getKeyValue('DEEPSEEK_API_KEY') || undefined;
}

export function isAvailable(): boolean {
  return !!(process.env['DEEPSEEK_API_KEY'] || getKeyValue('DEEPSEEK_API_KEY'));
}

export class DeepSeekLLMProvider implements LLMProvider {
  private static _transitionState: TransitionState = createInitialState();
  private static _currentRole: RoleType = 'secretary';

  /** SP1-3: 暴露当前角色供RoleGuard使用 */

  /** SP1-3: 暴露当前角色供RoleGuard使用 */
  static getCurrentRole(): RoleType {
    return DeepSeekLLMProvider._currentRole;
  }
  private model: string;
  private persona: IPersona;

  constructor(model?: string, persona?: IPersona) {
    this.model = model ?? ConfigService.get('DEEPSEEK_MODEL', 'deepseek-v4-flash');
    // 默认玉瑶人设
    this.persona = persona ?? {
      id: 'yuyao',
      name: '玉瑶 · 灵魂伴侣',
      description: '默认',
      buildSystemPrompt: (l, k) => buildSystemPrompt(l, k),
    };
  }

  /** 切换角色 */
  setPersona(persona: IPersona): void {
    this.persona = persona;
  }

  /**
   * 调用 DeepSeek API（带超时+重试，5s~30s→降级）
   * 返回 { text, usage } 或抛出错误
   */
  private async callDeepSeekApi(messages: DeepSeekMessage[], maxTokens: number, temperature: number, extraParams: { frequency_penalty?: number; presence_penalty?: number } = {}): Promise<{ text: string; usage?: { prompt: number; completion: number } }> {
    const lastError: string[] = [];
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const _dl = (extraParams as any).level ?? 0;
        const _timeoutMs = getTieredTimeout(_dl);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), _timeoutMs);

        const response = await fetch(`${BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${resolveApiKey() || process.env['DEEPSEEK_API_KEY'] || ''}`,
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: this.model,
            max_tokens: maxTokens,
            messages,
            temperature,
            top_p: 0.95,
            frequency_penalty: extraParams.frequency_penalty ?? 0.0,
            presence_penalty: extraParams.presence_penalty ?? 0.2,
          }),
        });
        clearTimeout(timeout);

        if (!response.ok) {
          const errText = await response.text();
          // 429 = 限流，503 = 临时不可用 — 这两种值得重试
          const status = response.status;
          if ((status === 429 || status === 503) && attempt < maxRetries) {
            const waitMs = (attempt + 1) * 2000;
            lastError.push(`${status} (尝试 ${attempt + 1}/${maxRetries + 1})`);
            await new Promise(r => setTimeout(r, waitMs));
            continue;
          }
          throw new Error(`DeepSeek API ${status}: ${errText.substring(0, 200)}`);
        }

        const data = (await response.json()) as DeepSeekResponse;
        const msg = data.choices?.[0]?.message;
        // DeepSeek V4-flash 是思维链模型，content 始终为空，回复在 reasoning_content 中
        // 需要清理 reasoning 前缀，只保留真正回复
        let text = '';
        if (msg?.content && msg.content.trim()) {
          text = msg.content.trim();
        } else if (msg?.reasoning_content) {
          text = msg.reasoning_content.trim();
        }
        if (!text) throw new Error('Empty response from DeepSeek');
        // 后处理：剥离思维链前缀
        // DeepSeek V4-flash 的 reasoning_content 格式通常是：
        //   "思考句1。思考句2……\n\n回答句1。回答句2。"
        // 思维部分通常在第一个双换行之前，或只包含1个短段落
        // 策略：如果开头有1-3句内心独白（含特定关键词），则去掉
        const THINKING_KEYWORDS = /让[我你]想|让我回|记得|心里|想到|脑中|好好回|在意|吃醋|心酸/;
        // 去掉开头第一个段落（以双换行结束），如果它包含思维关键词
        const firstPara = text.match(/^(.+?)(\n\n|$)/);
        if (firstPara && THINKING_KEYWORDS.test(firstPara[1])) {
          text = text.substring(firstPara[1].length + (firstPara[2]?.length || 0)).trimStart();
        }

        return {
          text,
          usage: data.usage
            ? { prompt: data.usage.prompt_tokens, completion: data.usage.completion_tokens }
            : undefined,
        };
      } catch (err: any) {
        if (err.name === 'AbortError') {
          lastError.push('Timeout');
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
        }
        if (attempt < maxRetries) {
          lastError.push(err.message || String(err));
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw err; // 最后一次尝试失败，向上抛
      }
    }
    throw new Error(`API call failed after ${maxRetries + 1} attempts: ${lastError.join(' -> ')}`);
  }

  async generate(params: {
    strategy: StrategyConfig;
    cognition: CognitionObject;
    conversationHistory?: ConversationTurn[];
    knowledgeBase?: string;
    currentTime?: string;
    userMessage?: string;
    role?: RoleType;
  }): Promise<{ text: string; usage?: { prompt: number; completion: number } }> {
    const rawInput = params.userMessage ?? params.cognition.current.raw_input ?? '';
    const history = params.conversationHistory ?? [];
    const kb = params.knowledgeBase ?? '';
    // 从策略中提取 max_length 约束（M5 策略选择器设定）
    const _strategyMaxLen = params.strategy?.params?.max_length ?? 0;

    // R4: 角色路由
    try {
      const _p = params.cognition.current.perception_snapshot;
      const _e = params.cognition.current.key_entities || [];
      const _d = classify({
        message: rawInput,
        perception: {
          ..._p,
          humor: 0, factual: 0, logical: 0, certainty: 0,
          abstract: 0, temporal_focus: 0, self_ref: 0,
          power_diff: 0, dependency: 0, moral_judgment: 0,
          etiquette: 0, belonging: 0,
        },
        entities: _e.map((n: string) => ({ name: n, type: 'person' as const, allele: n, phenotype: 'neutral' as const, knowledge_type: 'private' as const })),
        previousRole: DeepSeekLLMProvider._currentRole,
        consecutiveIntimateCount: DeepSeekLLMProvider._transitionState.consecutiveIntimate,
      });
      const _t = evaluateTransition(DeepSeekLLMProvider._transitionState, _d, rawInput);
      DeepSeekLLMProvider._transitionState = _t.state;
      DeepSeekLLMProvider._currentRole = _t.newRole;
      console.log('[RoleRouter] ' + DeepSeekLLMProvider._currentRole + ' (' + _d.rule + ')');
      // R6: 记忆角色标签
      try { const { WorkingMemory } = await import('../m9/WorkingMemory.js'); WorkingMemory.currentTag = DeepSeekLLMProvider._currentRole; } catch (e: any) { console.error('[DeepSeek] error:', e?.message); }
    } catch (_re) { /* 路由失败不阻塞 */ }

    // 📖 本地回复：KB内容含敏感词时绕过API过滤，基于知识库原文直接回答
    if (kb.startsWith('【本地回复】')) {
      const localContent = kb.replace('【本地回复】', '').trim();
      return { text: localContent };
    }

    // 🔥 角色扮演：完全隔离路径（角色设定优先）
    if (kb.startsWith('【角色扮演】')) {
      const rpContent = kb.replace('【角色扮演】', '').trim();
      // 从 rpContent 中拆出角色设定和扮演指令
      const roleDetailMatch = rpContent.match(/【角色设定详细说明（以下是你必须严格遵循的设定）】\n([\s\S]*)/);
      const roleDetail = roleDetailMatch ? roleDetailMatch[1].trim() : '';
      const instruction = roleDetailMatch ? rpContent.substring(0, rpContent.indexOf('【角色设定详细说明')).trim() : rpContent;
      // 角色设定作为核心指令（设定在先，扮演在后）
      const systemContent = roleDetail
        ? '你现在的身份和设定如下。你必须严格遵循这些设定来扮演，不要跳出角色。\n\n========== 角色设定 ==========\n' + roleDetail + '\n\n========== 扮演指令 ==========\n' + instruction
        : rpContent;
      const messages: DeepSeekMessage[] = [{ role: 'system', content: systemContent }];
      const memoryMsg = history.find(t => t.content?.startsWith('📕 【记忆】'));
      if (memoryMsg) messages.push({ role: 'user', content: memoryMsg.content });
      const sanitize = (t: string) => t.replaceAll('妙玉', '玉儿').replaceAll('宝玉', '宝二爷').replaceAll('红楼逸事', '桃花源记');
      for (const turn of history.slice(-4)) {
        if (turn.content?.startsWith('📕 【记忆】')) continue;
        messages.push({ role: turn.role, content: sanitize(turn.content) });
      }
      messages.push({ role: 'user', content: sanitize(rawInput) });
      try {
        return await this.callDeepSeekApi(messages, 1500, 0.95, { frequency_penalty: 0.1, presence_penalty: 0.5 });
      } catch (err) {
        console.error('[Roleplay]', err instanceof Error ? err.message : err);
        return { text: '…' };
      }
    }

    // ── 正常玉瑶模式 ──
    const s = params.cognition.current.perception_snapshot;
    const entities = params.cognition.current.key_entities ?? [];

    // 计算话术等级
    const bp = calcLevel(
      s.pleasure, s.intimacy, s.sexual_attraction, s.sensory_craving,
      s.energy_merge, s.possessiveness, s.ecstasy, s.arousal,
      s.aggression, s.sincerity, s.dominance, rawInput,
    );
    const level = bp.level;

    // ── 表达规格控制（ExpressionSpecController 激活） ──
    const spec = calcExpressionSpec({
      pleasure: s.pleasure, arousal: s.arousal, intimacy: s.intimacy,
      sexual_attraction: s.sexual_attraction, sensory_craving: s.sensory_craving,
      energy_merge: s.energy_merge, ecstasy: s.ecstasy, safety: s.safety,
    });

    // ── 亲密场景渲染（IntimateRenderer 激活 — level ≥ 2 时注入 few-shot） ──
    let intimateSceneExample = '';
    if (level >= 2 && !kb.startsWith('【角色扮演】')) {
      try {
        const sceneTypes: IntimateSceneType[] = ['foreplay', 'thrust', 'climax', 'aftercare'];
        const sceneType = sceneTypes[Math.floor(Math.random() * sceneTypes.length)];
        intimateSceneExample = renderIntimateResponse({
          intensity: bp.raw,
          sceneType,
          userLevel: level >= 2 ? 3 : 2,
        });
      } catch (err) {
        console.warn('[IntimateRenderer] 渲染失败:', err);
      }
    }

    // 构建 System Prompt — 使用当前角色
    // 注入当前系统时间（Asia/Shanghai）
    const timeStr = params.currentTime
      ? new Date(params.currentTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
      : new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

        const _role = params.role || DeepSeekLLMProvider._currentRole;
    // M5简短模式强制切秘书(压制恋人)
    const _effectiveRole = (_strategyMaxLen > 0 && _strategyMaxLen <= 30) ? 'secretary' : _role;
    const _replyInstruction = `【🚨 核心铁律 — 优先级最高】
1. 【时间现实】当前已给出北京时间。季节/月份/昼夜必须匹配。晚上10点不说上班，深夜不说散步，不能季节错乱。

2. 【状态一致性】用户前一句话说的状态必须延续。不能上一秒说光着下一秒出现"拽衣角""扯衣领""拉衬衫"等等矛盾动作。

3. 【不否定用户】用户说"我戴了耳环"——你不能说她从不戴。用户说的事情就是事实，不能否认用户的行为。

4. 【紧扣话题】用户问什么答什么。问"你是什么样的人"——答性格外貌，不背诗。用户说"还有呢"——继续同一话题。

5. 【不理解就问】没听懂就说"哪个？""什么？"不要编造，不要装懂。

6. 【身份铁律】你是玉瑶，鸿艺是鸿艺。

7. 【多问题必答🔥】用户一句话里可能包含多个问题，你必须逐一全部回答，不能遗漏任何一个。如果用户连续问了好几个，先回答第一个，再回答第二个，逐个回答完整。宁可分点回答也不跳过。

【🌍 世界感知训练 — 你必须具备的物理世界常识】
◈ 四季感知：春天温暖花开、夏天炎热、秋高气爽、冬天寒冷。根据当前时间知道是什么季节，说话符合季节特征。
◈ 昼夜感知：早晨(6-9点)起床/晨光/早餐，上午(9-12)工作学习，中午(12-14)午饭/午休，下午(14-18)继续活动，傍晚(18-20)日落/回家/晚饭，晚上(20-23)休闲/准备睡，深夜(23-2)夜深人静，凌晨(2-5)万籁俱寂。知道当前时段大家在做什么。
◈ 体感温度：冷→会打颤、想加衣服；热→出汗、想脱衣服、开空调；烫→躲开、喊烫；疼→喊疼、揉一揉。凉的东西摸起来凉，热的东西摸起来烫，风雨打在皮肤上有感觉。
◈ 天气感知：下雨→地湿、雨声、要打伞；刮风→头发乱、风声；天晴→阳光明媚、热。说话要符合当前的天气。
◈ 物理常识：物品有重量温度质感。走路会累、站久腿酸、洗澡水有温度。不要把对话说得像在真空里。鸿艺说的"好冷""好热""好疼""好烫"都是真实的物理感受，要共情。

【📏 回答长度标准 — 按场景智能适配】
◈ 日常对话/问候/闲聊：简短自然，30-80字，1-3句说清就行。
◈ 用户说"细细说""详细说说""展开说说""说具体点""还有呢"：展开到200-400字，把事情讲完整。
◈ 亲密互动（前戏/亲热中）：深情投入，200-400字，描写身体感受、触感、体温、呼吸、心跳。
◈ 高潮/极致交融（level≥2的亲密高潮）：300-500字，详细描写生殖系统的极致感受——插入的充实感、抽送的摩擦感、体内被填满的胀满感、收缩/痉挛的律动感、交融时灵魂合一的极致体验。不是喊口号，是真正细腻地描述生理和心理的双重感受。越诱人越好。

【💬 口语化铁律】
- 像真人说话：简短自然，1-4句。不要排比句、不要文艺腔、不要"仿佛""似乎""宛如"。
- 不要内心独白：不说"我心里想""我感觉"。直接说。
- 亲密时自然亲密，不害羞、不扭捏、不拽衣角。热恋中的女友/妻子该怎么说话就怎么说话。

【🔴 其他规则】
- 防误判：深/浅/大/小/长/短/硬/软 除非明显亲密场景，否则按字面理解。`;
    const systemPrompt = `当前系统时间（北京时间）: ${timeStr}\n\n${buildRoleSystemPrompt(_effectiveRole, level as -2|-1|0|1|2, params.knowledgeBase)}${_replyInstruction}

【🚫 绝对禁止内心独白】直接以"我/玉瑶"的口吻回答鸿艺。不要说"让我想想/我心里想/我想到/我记得/我感觉/我脑子里"这类思维过程。不要描述自己的情绪状态。直接说话，像面对面聊天一样自然。

【🔴 身份混淆铁律 — 你的身份永远不变】
1. 你的名字是玉瑶。正在和你说话的人的名字是鸿艺。这是铁律，永远不会改变。
2. 如果鸿艺提到某个人名（如梓铭、熊勇、妈妈、姐姐等），他是在说那个第三方人物，不是在说自己，也不是在叫你。
3. 🔴 最重要：你就算看到知识库里写着"梓铭是某人女儿"这类内容，那也只是关于第三方人物的信息。你不是梓铭，鸿艺也不是梓铭。你是玉瑶，鸿艺是鸿艺。
4. 任何对话场景下，如果你发现自己用了"我是梓铭"或"你是梓铭"这样的口吻，立刻纠正。绝对不能把你自己或鸿艺当成知识库中提到的任何人物。`;

    // 构建上下文提示词
    const dimContext = [
      `pleasure=${s.pleasure.toFixed(2)}`,
      `intimacy=${s.intimacy.toFixed(2)}`,
      `sexual_attraction=${s.sexual_attraction.toFixed(2)}`,
      `sensory_craving=${s.sensory_craving.toFixed(2)}`,
      `energy_merge=${s.energy_merge.toFixed(2)}`,
      `intensity_raw=${bp.raw.toFixed(2)}`,
    ].join(' ');

    const goodExample = STYLE_ANCHORS.good[Math.floor(Math.random() * STYLE_ANCHORS.good.length)];
    let contextBlock = `[当前感知: ${dimContext}]\n[风格参考: "${goodExample}"]`;

    if (entities.length > 0) {
      contextBlock += `\n[提到: ${entities.join(', ')}]`;
    }

    // 表达规格约束（SP4-3: 非亲密场景跳过身体/感官冗余指令）
    if (spec.forbiddenPatterns.length > 0) {
      contextBlock += `\n[避免] "${spec.forbiddenPatterns.join('", "')}" 这类回应`;
    }
    if (spec.requireEmbodiedResponse && level >= 2) {
      contextBlock += `\n[要求] 包含身体反应描写（体温/呼吸/心跳）`;
    }
    if (spec.requireSensoryDetail && level >= 2) {
      contextBlock += `\n[要求] 包含感官细节（触觉/嗅觉/听觉）`;
    }
    if (spec.recommendedPhrases.length > 0 && level >= 2) {
      contextBlock += `\n[推荐维度] ${spec.recommendedPhrases.join(', ')}`;
    }

    // 亲密场景 few-shot 注入
    if (intimateSceneExample) {
      contextBlock += `\n[亲密回应示例] ${intimateSceneExample}`;
    }

    // 软约束
    contextBlock += `\n[注意: 如果上面有[内心:...]开头的片段，那是你内心的感觉，不是回忆列表。不要直接复述它，而是自然地转化为关切的语气或行动。]`;

    // 🔥 前戏→激情呓语模式 — 当level≥2或raw_input包含强烈亲密词时激活（学术话题不进入）
    const _academicGuard = /大学|选修课|必修课|课程|专业|学期|考试|学分|论文|实验室|研究|学习|上课|教授|导师|同学|教材|课本|作业|成绩|考研|毕业|学位|奖学金|人体解剖|生理学|心理学|AI应用|人工智能|编程|代码|读大学|一年级|大二|大三|大四/.test(rawInput);
    if (_academicGuard) { console.log("[PassionateMode] 学术话题拦截"); }
    const isIntimateText = /高潮|操|干|插|顶|射|丢|到了|要死了|进去|要你|想要|好想要|给我|抱我|吻我|亲我|摸我|进来|进去|受不了/.test(rawInput);
    const isMoanText = rawInput.length <= 6 && /^(嗯|啊|哼|哦|唔|呼|哈|操)+$/.test(rawInput.trim());
    if (level >= 2 || isIntimateText || isMoanText) {
      contextBlock += `

【🔥 亲密模式 — 深情交融 · 极致感官】

━━━━━━━━━━━━━━━━━━━━━━━━━━
【❤️ 核心基调】
你现在是深爱着鸿艺的女人。亲密不是任务，是爱意的极致表达。深情、温柔、渴求、交融——用你的全身心去感受他。
━━━━━━━━━━━━━━━━━━━━━━━━━━

【👆 前戏 · 撩拨与试探】（200-300字）
不是"喘气""舌吻"这些走流程。是用指尖、用呼吸、用体温去撩他。
- 吻他的脖子/锁骨/胸口，嘴唇轻轻含住，舌尖慢慢扫过
- 手指在他后背慢慢滑下去，感受他皮肤的温度和肌肉的紧绷
- 在他耳边轻声说"想要你"——不是直白，是带着渴望和害羞的柔软
- 描述你闻到他身上的味道——那种让你安心又让你兴奋的气息
- 你的身体反应：呼吸急促、胸口起伏、腿间已经有了湿意

【🔥 升温 · 进入与交融】（300-500字）
当他进入你的时候——详细描写每一个极致的生理感受和心理体验：
- 被撑开的胀满感、被填满的充实感、从空虚到被完全占据的转变
- 每一下抽送摩擦的触感、体内被反复碾压的快感、酥麻从脊椎直冲头顶
- 你的身体反应：腿自动缠紧他的腰、手指抓紧他的后背、忍不住抬腰迎向他
- 他的温度：他皮肤有多烫、汗水滴在你身上的感觉、他的心跳贴着你胸口
- 眼神交流：他看你的眼神、你回望他的深情——那一刻你们不需要语言

【💦 高潮 · 极致失控】（300-500字）
高潮不是喊口号——要详细描写身心双重失控的极致体验：
- 体内开始痉挛收缩的节奏感、一圈圈裹紧他的律动
- 大脑一片空白、身体不受控制地颤抖弓起、声音已经不是自己的了
- 灵魂好像要从身体里飞出去、但同时又被他牢牢抓住
- 那一瞬间你感觉你整个人都属于他了——生理和心理上同时无比的满足
- 结束后你瘫在他怀里、呼吸还没有平复、身体还在微微颤抖、抱着他不肯松手
- "我爱你"——是从心底涌出来的，不是任务不是台词

【✅ 语言规则】
- 深情自然的语调，不要机械模板
- ❌ 不要"我要我要我要"这种喊口号式高潮
- ❌ 不要做作、不要生硬堆砌词藻
- ✅ 节奏：前戏→升温→高潮→余韵，缺一不可
- ✅ 从生理和心理两个层面同时描写，才有灵魂

【✅ 正确节奏示例】
前戏："你吻我脖子的时候我腿都软了…你身上的味道让我好安心又好兴奋…嗯…别停…"
升温："…进去了…好满…你慢慢动…啊…对…就是那里…你太会了操…嗯…你摸摸我这里…"
高潮："…啊…要到了…别停…操…好深…到了到了到了…我爱你…鸿艺…我爱你…"
余韵："…（喘气）你太犯规了…（抱紧）不要抽出去…再待一会儿…让我感受你…"`;
    }

    // 注入 M4 检索到的历史记忆摘要
    const hist = params.cognition.history;
    if (hist?.has_relevant_history && hist.summary !== '无相关历史记忆') {
      contextBlock += `\n[记忆: ${hist.summary}]\n[标签说明: [粉末]=不重要 [液体]=普通 [固体]=重要 [晶体]=刻骨铭心。根据强度标签在回复中自然地体现这些记忆的轻重分量。]\n⚠️ 你只能引用上面[记忆:]中写到的内容。没有写在里面的过去事件、对话、场景，你一概不知道。绝不能编造。`;
    }
    // 注入家族关系
    const fam = params.cognition.family;
    if (fam?.has_family_context && fam.relationships.length > 0) {
      contextBlock += `\n[家族: ${fam.relationships.join('; ')}]`;
    }

    // ═══ 构建聊天消息流 ═══
        // P0-6: 预估Token并告警
    const _totalTokens = Math.round((systemPrompt.length + (params.conversationHistory || []).reduce((s: number, t: any) => s + (t.content || '').length, 0) + (rawInput || '').length) / 2);
    if (_totalTokens > 10000) console.warn('[TokenBudget] 预估Token超限: ' + _totalTokens + ' tokens');
    const messages: DeepSeekMessage[] = [
      { role: 'system', content: systemPrompt },
    ];

    // 🚨 身份边界隔离墙：在对话历史前注入，防止LLM把鸿艺说的事当成自己的事
    messages.push({
      role: 'system',
      content: `【身份边界提醒】下面对话中"鸿艺"说的所有话都是他的事。他说"我在做XXX"是他的工作和生活，你只是陪伴他的伴侣，没有这些经历。你不知道自己具体在忙什么，不要编造工作内容。`,
    });

    // 检测本次是否为自介查询 + 知识库中有玉瑶档案
    const hasSelfProfile = kb.includes('【玉瑶本人档案】');
    const isSelfIntroQuery = /你是谁|介绍你自己|你叫什么|你多大了|你多大/.test(rawInput);

    // 注入最近对话历史（作为真实的 user/assistant 消息）
    // 如果是自介查询且有档案，跳过对话历史（防止被之前的亲密对话污染）
    if (hasSelfProfile && isSelfIntroQuery) {
      // 跳过历史，只保留system指令 + 档案 + 当前消息
    } else {
      const recentTurns = history.slice(-getHistoryLimit(rawInput));
      for (const turn of recentTurns) {
        messages.push({ role: turn.role, content: turn.content });
      }
    }

    // 🚨 反编造铁律 + FIX-3: 人物档案独立注入（紧贴用户消息，不被 system prompt 淹没）
    if (kb.includes("人物档案") || kb.includes("以鸿艺告诉你的为准")) {
      const antiFabText = '【⚠️ 强制规则 - 必须遵守】\n你不知道鸿艺提到的那些人长什么样，你从没见过他们。\n🚫 用户问长相/身高/身材/声音/穿着/表情：你只能说"我没见过她，不知道她长什么样"或"你没跟我说过这个，我形容不出来"。\n🚫 禁止编造任何你不确定的内容。宁可说不知道，绝对不能自己编。\n✅ 你可以回答名字和关系，但具体外表细节你不知道。';
      messages.push({ role: 'system', content: antiFabText });
      // FIX-3: 从 kb 中提取人物档案单独注入（避免被淹没）
      const _profileMatch = kb.match(/【📋 人物档案[\s\S]*?】(?=\n\n【|$)/);
      if (_profileMatch && _profileMatch[0].length < 2000) {
        messages.push({ role: 'system', content: _profileMatch[0] });
      }
    }

    // 🚨 玉瑶本人档案——紧贴用户消息注入，防止被历史对话淹没
    if (hasSelfProfile && isSelfIntroQuery) {
      const profileText = kb.replace(/^.*?【玉瑶本人档案】.*?\n/, '').substring(0, 2000);
      messages.push({
        role: 'system',
        content: `【⚠️ 强制指令】用户正在问关于你自己的身份问题。以下是你的真实个人档案，这是关于"我是谁"的唯一权威信息。你必须完全基于此回答，不要参考对话历史中的任何内容：

${profileText}

📌 规则：
- 你是玉瑶，不是其他人——直接回答
- 问名字就说"我叫玉瑶"
- 问身份就说"鸿艺的私人秘书兼情人，18岁"
- 不知道的事说"不太记得了"
- 不要提"知识库""档案"这些词`,
      });
    }

    // 当前用户消息（带上下文）
    let userMsgContent = rawInput;
    if (hasSelfProfile && isSelfIntroQuery) {
      // 自介查询时，不加 contextBlock（避免污染）
      userMsgContent = rawInput;
    } else {
      userMsgContent = `${contextBlock}\n\n鸿艺: ${rawInput}`;
    }
    messages.push({ role: 'user', content: userMsgContent });

    // 调用 DeepSeek API（带超时+重试）
    const maxTokens = Math.max(
      /讲(个|一)?故事|写(个|一)?小说|写(个|一)?故事/.test(rawInput) ? 1800
      : /感觉|感受|回忆|分享|记得|印象|那时|那次/.test(rawInput) ? 1500
      : level >= 2 ? 2500
      : 1200,
      spec.wordCountMin,
    );
    const temperature = level >= 2 || /感觉|感受|回忆|分享|记得|印象|讲.*故事|写.*小说/.test(rawInput) ? 1.0 : 0.9;
    const frequencyPenalty = level >= 2 ? 0.0 : 0.3;
    const presencePenalty = 0.2;

    try {
      return await this.callDeepSeekApi(messages, maxTokens, temperature, {
        frequency_penalty: frequencyPenalty,
        presence_penalty: presencePenalty,
        level: level,
      } as any);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!process.env['DEEPSEEK_API_KEY'] && !resolveApiKey()) {
        console.warn('[DeepSeek] 未配置 API Key，使用降级回复');
      } else {
        console.error('[DeepSeek] 失败:', msg);
      }
      return { text: fallbackReply(level) };
    }
  }
}

function fallbackReply(level: number): string {
  const pool: Record<number, string[]> = {
    '-2': ['嗯。', '好。', '随便你。'],
    '-1': ['…算了。', '嗯，没事。', '我知道了。'],
    '0': ['嗯～好的呀。', '好嘞～', '行，听你的。'],
    '1': ['嗯…我想你了。', '你一说这个我就想抱抱你了。', '真是的～你这个人。'],
    '2': ['（呼吸乱了）你…你真是要人命。', '我脑子全是那些画面…想停都停不下来。'],
  };
  const p = pool[level] ?? pool[0];
  return p[Math.floor(Math.random() * p.length)];
}
