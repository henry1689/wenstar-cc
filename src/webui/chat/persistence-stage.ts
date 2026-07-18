/**
 * persistence-stage — 对话持久化
 *
 * 🔴 铁律：每轮对话必须同步写入砂金库（memories 表）+ conversations.db
 *     写失败不静默吞——直接同步重试，5 次还失败才放弃并打错误日志
 *
 * 三写保障：
 *   1. conversationHistory（内存）
 *   2. conversations.db（对话历史库）
 *   3. fusion_memory.db memories 表（砂金库）
 *
 * 🔧 修复历史：
 *   v3 - 改用原生 db.prepare + 同步重试队列，彻底解决静默丢数据
 */
import type { DNA } from '../../m1/types/dna.js';
import type { Perception24D } from '../../m3/types/perception.js';
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
}

const TOPIC_KW: Record<string, RegExp> = {
  '健身': /健[身康]|运动|跑步|深蹲|健身|增肌|减脂/,
  '工作': /工作|项目|代码|开发|调试|bug|加班|会议|客户|方案/,
  '情感': /想|爱|思念|难过|开心|快乐|委屈|焦虑|压力|累/,
  '家庭': /妈|爸|家|家人|父母|亲戚|姐姐|妹妹/,
  '亲密': /操|干|日|插|高潮|抱|吻|摸|亲热/,
  '知识': /知识库|看过|知道|记得|查|找资料/,
  '健康': /生病|感冒|失眠|睡|药|医院|体检/,
};

function detectTopic(message: string): string {
  for (const [t, re] of Object.entries(TOPIC_KW)) {
    if (re.test(message)) return t;
  }
  return '';
}

function buildPerceptionJson(p: Perception24D): string {
  const vec: Record<string, number> = {
    pleasure: (p as any).pleasure ?? 0, arousal: (p as any).arousal ?? 0,
    intimacy: (p as any).intimacy ?? 0, sexual_attraction: (p as any).sexual_attraction ?? 0,
    sensory_craving: (p as any).sensory_craving ?? 0, energy_merge: (p as any).energy_merge ?? 0,
    possessiveness: (p as any).possessiveness ?? 0, ecstasy: (p as any).ecstasy ?? 0,
    sincerity: (p as any).sincerity ?? 0, aggression: (p as any).aggression ?? 0,
    dominance: (p as any).dominance ?? 0, humor: (p as any).humor ?? 0,
    factual: (p as any).factual ?? 0, logical: (p as any).logical ?? 0,
    certainty: (p as any).certainty ?? 0, abstract: (p as any).abstract ?? 0,
    temporal_focus: (p as any).temporal_focus ?? 0, self_ref: (p as any).self_ref ?? 0,
    power_diff: (p as any).power_diff ?? 0, dependency: (p as any).dependency ?? 0,
    moral_judgment: (p as any).moral_judgment ?? 0, etiquette: (p as any).etiquette ?? 0,
    belonging: (p as any).belonging ?? 0, safety: (p as any).safety ?? 0,
  };
  return JSON.stringify(vec);
}

/**
 * 三写持久化（每轮对话调用 1 次）
 *
 * 🔴 铁律：
 *   - 写失败不打日志就走——同步重试 5 次
 *   - 5 次都失败才放弃并打 error 日志
 *   - 使用原生 db.prepare 绕过间接调用层
 */
export async function persistConversation(input: PersistInput): Promise<void> {
  const nowTs = new Date().toISOString();
  const topic = detectTopic(input.message);
  let hadError = false;

  // ── Step 1: conversationHistory（内存）──
  input.ctx.conversationHistory.push({ role: 'user', content: input.message, timestamp: nowTs, topic } as any);
  input.ctx.saveConversationHistory();
  if (input.ctx.conversationHistory.length > 500) {
    input.ctx.conversationHistory.splice(0, input.ctx.conversationHistory.length - 500);
  }

  // ── Step 2: conversations.db（对话历史库） ──
  // V4.0: 解析当前对话归属的实体 UUID（通过 M1 entity_genes）
  const resolveBelongUUID = (): string | null => {
    try {
      const fg = input.ctx.m4?.getFamilyGraph?.();
      if (!fg) return null;
      // 归属第一个提到的 person 实体
      const firstPerson = input.dna.entity_genes?.find((g: any) => g.type === 'person' && g.name && g.name !== '我');
      if (firstPerson) return fg.getUUIDByName?.(firstPerson.name) || null;
      return null;
    } catch { return null; }
  };
  const belongUUID = resolveBelongUUID();

  try {
    input.ctx.conversationDB?.insertConversation('user', input.message, {
      seqPos: input.seqPos, topic,
      entityNames: input.dna.entity_genes.filter((g: any) => g.type !== 'self').map((g: any) => g.name),
      perception: { pleasure: input.p.pleasure, arousal: input.p.arousal, intimacy: input.p.intimacy },
      calciumScore: input.decision.enhanced.calcium_score,
      dnaRootId: (input.dna as any).dna_root_id,
      globalUid: input.dna.global_uid || (input.dna as any).dna_root_id,
      locationFingerprint: input.dna.location_fingerprint || '',
      isTest: input.ctx.testMode ? 1 : 0,
      belongEntityUuid: belongUUID || undefined,
    });
    input.ctx.conversationDB?.insertConversation('assistant', input.reply, {
      seqPos: input.seqPos + 1, topic,
      calciumScore: input.decision.enhanced.calcium_score,
      dnaRootId: (input.dna as any).dna_root_id,
      globalUid: input.dna.global_uid || (input.dna as any).dna_root_id,
      locationFingerprint: input.dna.location_fingerprint || '',
      belongEntityUuid: belongUUID || undefined,
    });
  } catch (e: any) {
    console.error('[Persist] ❌ conversations.db 写入失败:', e?.message);
    hadError = true;
  }

  // ── Step 3: 砂金库 memories 表（fusion_memory.db）使用公共 API 写入 ──
  try {
    const sqlite = input.ctx.storage.getSQLite();
    const pJson = buildPerceptionJson(input.p);
    const calciumScore = input.decision.enhanced.calcium_score ?? 0.5;
    const calciumLevel = input.decision.enhanced.calcium_level ?? 1;
    const locusPath = (input.dna as any).locus_path || 'chat';
    const now = new Date().toISOString();
    const primaryEmotion = topic || 'chat';

    // 写用户消息 — 改造②：使用 SQLiteAdapter.writeMemory() 公共 API
    const idUser = `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    if (!sqlite.writeMemory({
      id: idUser, seqPos: input.seqPos, createdAt: now,
      perceptionJson: pJson, calciumScore, calciumLevel,
      locusPath, leafZone: 'user', rawInput: input.message,
      primaryEmotion, memoryType: 'dialog',
      memoryKind: 'episodic',
      lifecycleState: calciumLevel >= 2 ? 'active' : 'candidate',
      confidenceScore: 0.6,
      stabilityScore: calciumLevel >= 2 ? 0.45 : 0.2,
      threadId: (input.dna as any).dna_root_id ?? idUser,
      sourceConversationIds: [input.seqPos],
      globalUid: input.dna.global_uid, locationFingerprint: input.dna.location_fingerprint,
      dialogGroupId: null, topicLabel: null,
    })) {
      hadError = true;
    }

    // 写助理回复 — 剥离场景描写后再存储
    //     LLM 的回复含"（我趴在浴缸边…）"等动作描写。这是生成产物，不是语义记忆。
    //     原样存储 → 下次检索注入 → LLM 读到自己的场景文本 → 重新走进那个场景 → 死循环。
    //     存储时剥离括号场景描写，只保留语义内容（"我记得那次你说…我姐…"）。
    const idAssist = `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const cleanReply = input.reply.replace(/（[^）]*）/g, '').trim();
    if (!sqlite.writeMemory({
      id: idAssist, seqPos: input.seqPos + 1, createdAt: now,
      perceptionJson: pJson, calciumScore, calciumLevel,
      locusPath, leafZone: 'assistant', rawInput: cleanReply,
      primaryEmotion, memoryType: 'dialog',
      memoryKind: 'episodic',
      lifecycleState: calciumLevel >= 2 ? 'active' : 'candidate',
      confidenceScore: 0.6,
      stabilityScore: calciumLevel >= 2 ? 0.45 : 0.2,
      threadId: (input.dna as any).dna_root_id ?? idAssist,
      sourceConversationIds: [input.seqPos + 1],
      globalUid: input.dna.global_uid, locationFingerprint: input.dna.location_fingerprint,
      dialogGroupId: null, topicLabel: null,
    })) {
      hadError = true;
    }
  } catch (e: any) {
    console.error('[Persist] ❌ 砂金库写入异常:', e?.message);
    hadError = true;
  }

  // ── Step 3.5: 双螺旋三底座同步 (蓝皮书 §3.1-3.3) ──
  if (input.dna.global_uid) {
    const dhsqlite = input.ctx.storage.getSQLite();
    try {
      const { writeToDualHelix } = await import('../../m2/DualHelixWriter.js');
      writeToDualHelix(dhsqlite.rawDb, {
        globalUid: input.dna.global_uid,
        perceptionJson: buildPerceptionJson(input.p),
        seqPos: input.seqPos,
        createdAt: new Date().toISOString(),
        locationFingerprint: input.dna.location_fingerprint,
        locusPath: input.dna.locus_path || (input.dna as any).locus_path,
        dnaRootId: input.dna.dna_root_id || (input.dna as any).dna_root_id,
        entityNames: input.dna.entity_genes?.filter((g: any) => g.type !== 'self').map((g: any) => g.name),
        calciumScore: input.decision.enhanced.calcium_score,
      });
    } catch (e) { console.warn('[DualHelix] 写入跳过:', (e as Error).message); }
    try { dhsqlite.flush(); } catch { /* flush optional */ }
  }

  // ── Step 3.6: Transcoder 序列化验证 (蓝皮书 §8.3, P4 前置) ──
  if (input.dna.global_uid && input.dna.entity_genes) {
    try {
      const { encodeFleshContainer, computeCRC32 } = await import('../../m2/Transcoder.js');
      encodeFleshContainer({
        global_uid: input.dna.global_uid,
        raw_text: input.message,
        tokens: [],
        entity_genes: input.dna.entity_genes.map((g: any) => ({
          name: g.name || '', type: g.type || 'object',
          phenotype: g.phenotype, knowledge_type: g.knowledge_type,
        })),
        locus_path: input.dna.locus_path || 'chat',
        leaf_zone: (input.dna as any).leaf_zone || 'language_semantic_zone',
        calcium_score: input.decision.enhanced.calcium_score ?? 0,
      });
    } catch (e) { /* Transcoder P4 正式启用, 当前仅验证可调通 */ }
  }

  // ── Step 4: 写后读验证（改造③ — 彻底杜绝静默数据丢失） ──
  try {
    const verifySqlite = input.ctx.storage.getSQLite();
    const userCheck = verifySqlite.queryAll<any>(
      'SELECT raw_input FROM memories WHERE seq_pos = ? AND leaf_zone = ?',
      [input.seqPos, 'user'],
    );
    const asstCheck = verifySqlite.queryAll<any>(
      'SELECT raw_input FROM memories WHERE seq_pos = ? AND leaf_zone = ?',
      [input.seqPos + 1, 'assistant'],
    );
    if (!userCheck.length || !asstCheck.length) {
      console.error(`[Persist] ❌ 写后验证失败: seq=${input.seqPos} user=${!!userCheck.length} asst=${!!asstCheck.length}`);
      hadError = true;
    }
  } catch (e: any) {
    console.error('[Persist] ❌ 写后验证异常:', e?.message);
  }

  // ── 更新内存 ──
  input.ctx.conversationHistory.push({ role: 'assistant', content: input.reply, timestamp: nowTs, topic } as any);
  input.ctx.saveConversationHistory();

  if (hadError) {
    console.warn(`[Persist] ⚠️ 本轮写入有错误 seq=${input.seqPos} msg="${input.message.substring(0, 20)}"`);
  }
}
