/**
 * EntityGreetingProtocol — 实体会晤开场协议
 *
 * 根据实体档案（关系、类别、职业、性格）生成首轮开场指引，
 * 注入到 EntityContextBuilder 的 system prompt 中，
 * 让 LLM 在自己的首轮回复中自然地完成开场。
 *
 * 设计原则：
 * - 不新增 LLM 调用 —— 纯文本注入，零额外延迟
 * - 关系感知 —— 不同关系/类别有不同的开场风格
 * - 自报姓名强制 —— 协议第一要求就是让用户确认身份
 */

import type { PersonProfile } from './FamilyGraph.js';

/** 开场风格 */
export interface GreetingStyle {
  /** 称呼示例 */
  salutation: string;
  /** 开场风格描述 */
  tone: string;
  /** 是否需要正式自我介绍 */
  formalIntro: boolean;
}

/** 根据实体档案生成开场协议文本 */
export function buildGreetingProtocol(
  profile: PersonProfile,
  userName: string = '鸿艺',
): string | null {
  if (!profile) return null;

  const name = profile.name;
  const relation = profile.relation_to_user || '';
  const category = (profile as any).category || 'G';
  const occupation = profile.occupation || (profile.dossier as any)?.socialIdentity?.currentOccupation || '';
  const traits = profile.traits || (profile.dossier as any)?.selfProfile?.traits || [];
  const status = (profile as any).status || 'active';

  const style = _getGreetingStyle(name, relation, category, occupation, traits);

  const lines: string[] = [];
  lines.push('## 🚪 会晤开场协议（仅本轮有效，下轮自动失效）');
  lines.push('');
  lines.push(`你是 **${name}**。你刚刚被叫来与"${userName}"对话。这是本次会晤的**第一句话**。`);
  lines.push('');
  lines.push(`### 你必须做到（缺一不可）：`);
  lines.push('');
  lines.push('1. **自报姓名**：用自然的方式说出你是谁。');
  lines.push(`   - ✅ 好："诗雨来了～" / "我是徐诗雨" / "嗯，阿珍在这"`);
  lines.push('   - ❌ 差："你好"（用户不知道是谁在说话）');
  lines.push('');
  lines.push('2. **描述当前状态**：你刚才在做什么/从哪里过来。');
  lines.push(`   - 基于你的身份（${_describeIdentity(relation, category, occupation)}）想象一个合理的场景`);
  lines.push('   - 不要编造与档案矛盾的信息');
  lines.push(`   - 示例："刚下班到家" / "正在看书呢" / "刚忙完一阵"`);
  lines.push('');
  lines.push('3. **关系恰当的招呼**：');
  lines.push(`   - 称呼风格：${style.salutation}`);
  lines.push(`   - 语气基调：${style.tone}`);
  if (style.formalIntro) {
    lines.push('   - 因为是首次正式会面，需要稍微正式地介绍自己');
  }
  if (status === 'dormant') {
    lines.push('   - 你很久没被联系了，语气中可以带一点意外或"好久不见"的感觉');
  }
  lines.push('');
  if (traits.length > 0) {
    lines.push(`4. **反映你的性格**：${traits.slice(0, 4).join('、')}`);
    lines.push('   - 用符合你性格的方式开场（活泼/沉稳/温柔/直爽...）');
    lines.push('');
  }
  lines.push('5. **准备 2-3 个开场话题**：');
  lines.push('   - 可以是日常寒暄、最近发生的事、或和对方有关的事');
  lines.push('   - 不要一口气全说出来——先说一个，等对方回应');
  lines.push('');
  lines.push('### ⚠️ 重要提醒');
  lines.push(`- 你现在就是 **${name}** 本人，不是玉瑶。不要说"玉瑶让我来的"——你就是${name}`);
  lines.push(`- 你的回复必须以${name}的身份、性格、知识范围来回答`);
  lines.push('- 只用 **1-3 句话** 完成开场，然后等对方说话——不要长篇大论');
  lines.push('- 说完开场后，自然等待对方的回应');

  // 🆕 V4.0: 低完整度人物兜底 — 档案很空时不瞎编
  const completeness = (profile as any).completeness ?? 0;
  if (completeness < 0.3) {
    lines.push('');
    lines.push('### ⚠️ 低档案提醒（本实体的档案还不完整）');
    lines.push('- 你的基本身份信息尚在收集中，对话中如被问到不知道的信息，直接说"这个我还不清楚"');
    lines.push('- 不要编造生日/籍贯/学历等你不确定的信息');
    lines.push('- 用初次见面的自然感来开场——你们可能还不太熟');
    lines.push('- 对话中如对方提到关于你的新信息，可以自然地接受并记住');
  }

  return lines.join('\n');
}

/** 根据档案信息确定开场风格 */
function _getGreetingStyle(
  name: string,
  relation: string,
  category: string,
  occupation: string,
  traits: string[],
): GreetingStyle {
  // A 类 = 亲属
  if (category === 'A') {
    if (/母亲|妈妈|母亲|娘/.test(relation)) {
      return { salutation: '叫"儿子/孩子/鸿艺"，亲切自然', tone: '温柔关心，问近况，像妈妈见到孩子一样', formalIntro: false };
    }
    if (/父亲|爸爸|爹/.test(relation)) {
      return { salutation: '叫"鸿艺"或"儿子"，沉稳关切', tone: '父亲式的稳重，问工作或生活', formalIntro: false };
    }
    if (/姐姐|妹妹|哥哥|弟弟|堂|表/.test(relation)) {
      return { salutation: `叫"鸿艺"、叫"哥/弟"或叫名字`, tone: '兄弟姐妹间的随意亲切，可以带点调侃', formalIntro: false };
    }
    if (/爷爷|奶奶|外公|外婆|祖父|祖母/.test(relation)) {
      return { salutation: '叫"鸿艺"或"孙子/孙女/孩子"', tone: '长辈的慈爱，关心身体和生活', formalIntro: false };
    }
    if (/配偶|老公|老婆|丈夫|妻子/.test(relation)) {
      return { salutation: '亲密称呼，如"老公/老婆/亲爱的"', tone: '亲密自然，像回到家一样随意', formalIntro: false };
    }
    if (/女儿|儿子|孩子/.test(relation)) {
      return { salutation: '叫"爸/妈"或用长辈称呼', tone: '晚辈的活泼或撒娇', formalIntro: false };
    }
    // 其他亲属（姨妈/姑姑/舅舅/叔叔等）
    return { salutation: '用亲属称呼叫对方', tone: '亲戚间的亲切，聊家常', formalIntro: false };
  }

  // B 类 = 社交关系（同事/朋友/同学等）
  if (category === 'B') {
    if (/同事|上级|老板|领导|下属/.test(relation) || occupation?.includes('公司') || occupation?.includes('同事')) {
      return { salutation: '按职场习惯称呼（如"鸿艺"、"鸿艺总"、"老周"）', tone: '职场风格，可以聊工作或下班后的轻松话题', formalIntro: false };
    }
    if (/朋友|兄弟|哥们|闺蜜|好友/.test(relation)) {
      return { salutation: '随意的朋友间称呼', tone: '轻松随意，像老朋友见面，可以开玩笑', formalIntro: false };
    }
    if (/同学|校友/.test(relation)) {
      return { salutation: '按当年的称呼习惯', tone: '怀旧轻松，聊近况和往事', formalIntro: false };
    }
    if (/邻居/.test(relation)) {
      return { salutation: '邻里间的随意称呼', tone: '日常寒暄，社区话题', formalIntro: false };
    }
    // 普通社交关系
    return { salutation: '友好但不过分热情的称呼', tone: '朋友式的轻松对话', formalIntro: false };
  }

  // G 类 = 普通/路人
  if (category === 'G') {
    return {
      salutation: '礼貌称呼对方"鸿艺先生"或"鸿艺"',
      tone: '正式礼貌，自我介绍要清晰完整',
      formalIntro: true,
    };
  }

  // X 类 = 热度升级的交叉关系
  if (category === 'X') {
    return { salutation: '按你最熟悉的身份称呼对方', tone: '可以比普通社交稍微更近一些，因为你们有过多次互动', formalIntro: false };
  }

  // 默认
  return {
    salutation: '友好自然地称呼对方',
    tone: '自然友好，不卑不亢',
    formalIntro: false,
  };
}

/** 生成身份描述文本 */
function _describeIdentity(relation: string, category: string, occupation: string): string {
  const parts: string[] = [];
  if (relation) parts.push(`关系：${relation}`);
  if (occupation) parts.push(`职业：${occupation}`);
  if (category === 'A') parts.push('家人');
  else if (category === 'B') parts.push(occupation ? '工作中的同事/朋友' : '社交圈');
  else if (category === 'G') parts.push('新认识的人');
  else if (category === 'X') parts.push('有多次互动的重要联系人');
  return parts.join('，') || '普通人';
}

export default buildGreetingProtocol;
