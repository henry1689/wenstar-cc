/**
 * persistence-stage — 对话持久化（从 chat.ts 拆分）
 *
 * 职责：对话写入 conversationHistory 和 SQLite
 * 包含：话题标记、持久化、内存裁剪
 */
import type { DNA } from '../../m1/types/dna.js';
import type { Perception24D } from '../../m3/types/perception.js';
import type { EnhancedDNA } from '../../m3/types/perception.js';
import type { M3Decision } from '../../m3/types/perception.js';
import type { ChatContext } from '../chat.js';

export interface PersistInput {
  ctx: ChatContext;
  message: string;
  reply: string;
  seqPos: number;
  dna: DNA;
  p: Perception24D;
  decision: M3Decision;
  currentRoleplay: string | null;
}

/** 话题标记关键词 */
const TOPIC_KW: Record<string, RegExp> = {
  '健身': /健[身康]|运动|跑步|深蹲|健身|增肌|减脂/,
  '工作': /工作|项目|代码|开发|调试|bug|加班|会议|客户|方案/,
  '情感': /想|爱|思念|难过|开心|快乐|委屈|焦虑|压力|累/,
  '家庭': /妈|爸|家|家人|父母|亲戚|姐姐|妹妹/,
  '亲密': /操|干|日|插|高潮|抱|吻|摸|亲热/,
  '知识': /知识库|看过|知道|记得|查|找资料/,
  '健康': /生病|感冒|失眠|睡|药|医院|体检/,
};

/** 话题追踪 */
function detectTopic(message: string): string {
  for (const [t, re] of Object.entries(TOPIC_KW)) {
    if (re.test(message)) return t;
  }
  return '';
}

/**
 * 持久化用户消息和回复
 * 对应原 chat.ts L1978-L1997 段
 */
export async function persistConversation(input: PersistInput): Promise<void> {
  const nowTs = new Date().toISOString();
  const topic = detectTopic(input.message);

  input.ctx.conversationHistory.push({
    role: 'user',
    content: input.message,
    timestamp: nowTs,
    topic: topic,
  } as any);
  input.ctx.saveConversationHistory();

  // 裁剪内存：只保留最近 500 条
  if (input.ctx.conversationHistory.length > 500) {
    input.ctx.conversationHistory.splice(0, input.ctx.conversationHistory.length - 500);
  }

  try {
    input.ctx.conversationDB?.insertConversation('user', input.message, {
      seqPos: input.seqPos,
      topic: topic,
      entityNames: input.dna.entity_genes
        .filter((g: { type: string }) => g.type !== 'self')
        .map((g: { name: string }) => g.name),
      perception: {
        pleasure: input.p.pleasure,
        arousal: input.p.arousal,
        intimacy: input.p.intimacy,
      },
      calciumScore: input.decision.enhanced.calcium_score,
      dnaRootId: (input.dna as any).dna_root_id,
      isTest: input.ctx.testMode ? 1 : 0,
      roleplayChar: input.currentRoleplay || undefined,
    });
  } catch {}

  try {
    input.ctx.conversationDB?.insertConversation('assistant', input.reply, {
      seqPos: input.seqPos + 1,
      topic: topic,
      calciumScore: input.decision.enhanced.calcium_score,
      dnaRootId: (input.dna as any).dna_root_id,
      roleplayChar: input.currentRoleplay || undefined,
    });
  } catch {}

  input.ctx.conversationHistory.push({
    role: 'assistant',
    content: input.reply,
    timestamp: nowTs,
    topic: topic,
  } as any);

  input.ctx.saveConversationHistory();
}
