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
import { encodeEmotionVector, encodeEmotionVectorWithFingerprint } from '../../m2/EmotionVectorCodec.js';
import { encodePerceptionV40 } from '../../m2/PerceptionVector40DCodec.js';
import { buildFallbackV40 } from '../../m2/YaoguangNormalizer.js';
import type { PerceptionV40 } from '../../m3/types/perception-40d.js';
import type { M3Decision } from '../../m3/types/perception.js';
import { detectForesight } from '../../m3/ForesightDetector.js';
import { enqueueYaoguangBackfill } from './yaoguang-backfill.js';
import { detectWork } from '../../app/works/WorkDetector.js';
import { WorkRepository } from '../../app/works/WorkRepository.js';
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

/** V13: 使用文本指纹编码，确保中性文本也有微量可区分的向量基线 */
function buildPerceptionJson(p: Perception24D, text?: string): string {
  if (text) return encodeEmotionVectorWithFingerprint(p, text);
  return encodeEmotionVector(p);
}

/**
 * V3: 写 perception_40d 列 — M3 直接产出的 40D 语义维（严格走 24D 原路径）。
 * 优先用 `perceptionV40`（M3 decide 产出，与 24D 同源）；缺失时回退 buildFallbackV40。
 * 客观维（D01-D08/D21-D32）由瑶光异步回填（yaoguang-backfill），此处语义维已就绪。
 */
function writePerceptionV40Dual(
  sqlite: { writeRaw(sql: string, ...params: unknown[]): void },
  id: string,
  p: Perception24D,
  perceptionV40?: PerceptionV40,
): void {
  try {
    const p40 = perceptionV40 ?? buildFallbackV40(p);
    sqlite.writeRaw(
      'UPDATE memories SET perception_40d = ? WHERE id = ?',
      encodePerceptionV40(p40),
      id,
    );
  } catch (e) {
    console.error('[Persist] ⚠️ 40D 双轨写入失败:', (e as Error)?.message);
  }
}

/** 🔧 V10.5: 从 assistant 回复中检测说话者 UUID（自称匹配） */
// P1-2: _detectSpeakerUUID 已废弃 — EntityOwnershipResolver.resolveOwnership(role='assistant') 覆盖全部自称检测模式

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
  // P1-C: 记录真实 conversations.id（增量索引 source_id 需与回填索引一致，非 dna_root_id）
  let _convUserRowId: number | null = null;
  let _convAsstRowId: number | null = null;

  // ── Step 1: conversationHistory（内存）──
  input.ctx.conversationHistory.push({ role: 'user', content: input.message, timestamp: nowTs, topic } as any);
  input.ctx.saveConversationHistory();
  if (input.ctx.conversationHistory.length > 500) {
    input.ctx.conversationHistory.splice(0, input.ctx.conversationHistory.length - 500);
  }

  // ── Step 2: conversations.db（对话历史库） ──
  // P0-4+P1-2: 统一实体归属解析 — EntityOwnershipResolver 单一入口
  // 🔴 户籍管理法（第五条 会晤写入强制）: 会晤模式 belong_entity_uuid 强制 = 会晤实体 UUID，
  // 禁止 entity_genes 推断覆盖（用户消息提到他人时不应把对话归属他人）。
  // 🔴 P0-2: belong_entity_uuid 权威 = 当前聊天对象 UUID
  // 私聊（会晤激活）→ 聊天对象 UUID；群聊 → 当前发言者 UUID（_meetingUUID 随 switchTo 切换）
  // 非会晤（_meeting=null）→ 玉瑶 UUID（默认私聊对象，category='S' 本体）
  // resolveOwnership 不再决定 belong，仅输出 mentioned_entity_uuids[]（供 FG 图谱/PAE/M4 分析）
  const _meetingUUID = input.ctx._entityMeeting?.getEntityUUID?.() ?? null;
  const { resolveOwnership, OWNER_UUID } = await import('../../app/entity/EntityOwnershipResolver.js');
  const _fg = input.ctx.m4?.getFamilyGraph?.();
  const _yuyaoUUID = _fg?.getUUIDByName?.('玉瑶') ?? null;
  // 归属 = 聊天对象 UUID（会晤激活/群聊当前发言者）或 玉瑶 UUID（默认私聊）
  // 🔴 转场彻底隔离(2026-08-23): 退出轮 _meeting=null（_em.exit 已清空），belong 兜底原实体 UUID
  //   ——退出消息归原实体，绝不污染玉瑶历史（玉瑶转场后=全新会话，看不到转场消息）
  let belongUUID: string | null = _meetingUUID ?? (input.ctx as any)?._exitEntityUuid ?? _yuyaoUUID;
  let asstUUID: string | null = _meetingUUID ?? _yuyaoUUID;
  let ownerEntityName: string | null = _meetingUUID ? (input.ctx._entityMeeting?.getEntityName?.() ?? null) : '玉瑶';
  // 强制 belong 非空（杜绝脏数据；world_domain_id 预留接口本次不落地）
  if (!belongUUID) {
    console.warn('[Persist] ⚠️ belong_entity_uuid 为空，兜底玉瑶');
    belongUUID = _yuyaoUUID ?? OWNER_UUID;
    asstUUID = _yuyaoUUID ?? OWNER_UUID;
    ownerEntityName = '玉瑶';
  }
  // 🔴 P0-2: 实体识别结果独立输出 mentioned_entity_uuids[]（不干预 belong，供 FG 图谱/PAE/M4）
  // 识别来源：消息/回复提到的人（resolveOwnership 分级解析）+ entity_genes person 实体
  const mentionedEntityUuids: string[] = [];
  try {
    const _mentionUser = resolveOwnership(input.message, input.dna.entity_genes, _fg, 'user');
    const _mentionAsst = resolveOwnership(input.reply, input.dna.entity_genes, _fg, 'assistant');
    for (const _m of [_mentionUser, _mentionAsst]) {
      if (_m.uuid && !mentionedEntityUuids.includes(_m.uuid)) mentionedEntityUuids.push(_m.uuid);
    }
    for (const _g of input.dna.entity_genes || []) {
      if (_g.type === 'person' && _g.name && _g.name !== '我' && _g.name !== '玉瑶') {
        const _u = _fg?.getUUIDByName?.(_g.name);
        if (_u && !mentionedEntityUuids.includes(_u)) mentionedEntityUuids.push(_u);
      }
    }
  } catch (_e: any) { console.warn('[Persist] mentioned 实体识别失败:', _e?.message); }
  // P0-4: mentioned_entity_uuids 图谱消费（异步推 FG，不阻塞主流程）
  // 消息提到的人（非当前聊天对象）→ 建 acquaintance 边，供 FG 图谱/PAE 丰富档案
  if (mentionedEntityUuids.length > 0) {
    try {
      const _fgC = input.ctx.m4?.getFamilyGraph?.();
      if (_fgC && typeof _fgC.integrateSocialRelation === 'function') {
        for (const _mu of mentionedEntityUuids) {
          if (_mu === belongUUID) continue;  // 跳过当前聊天对象（对话已归属）
          try {
            const _ent = _fgC.getEntityByUUID?.(_mu);
            const _name = _ent?.name;
            if (_name) {
              _fgC.integrateSocialRelation(_name, 'acquaintance_of', input.message).catch((_e: any) => console.warn('[Persist] 图谱消费失败:', _e?.message));
            }
          } catch (_e: any) { console.warn('[Persist] 单实体图谱消费失败:', _e?.message); }
        }
      }
    } catch (_e: any) { console.warn('[Persist] 图谱消费异常:', _e?.message); }
  }

  try {
    const _convUserId = input.ctx.conversationDB?.insertConversation('user', input.message, {
      seqPos: input.seqPos, topic,
      entityNames: input.dna.entity_genes.filter((g: any) => g.type !== 'self').map((g: any) => g.name),
      perception: { pleasure: input.p.pleasure, arousal: input.p.arousal, intimacy: input.p.intimacy },
      calciumScore: input.decision.enhanced.calcium_score,
      dnaRootId: (input.dna as any).dna_root_id,
      globalUid: input.dna.global_uid || (input.dna as any).dna_root_id,
      locationFingerprint: input.dna.location_fingerprint || '',
      isTest: input.ctx.testMode ? 1 : 0,
      belongEntityUuid: belongUUID || undefined,
      mentionedEntityUuids: mentionedEntityUuids,
    });
    if (_convUserId) _convUserRowId = _convUserId;
    const _convAsstId = input.ctx.conversationDB?.insertConversation('assistant', input.reply, {
      seqPos: input.seqPos + 1, topic,
      // 🔴 D1 修复(2026-09-11): assistant 轮补 entityNames。
      // 实测：该字段原缺失 → 全库 assistant 轮 entity_names 100% 为空（833/833）。
      // ❗ 真实消费方（经两轮 S4 独立评审校正，勿再写错）：
      //   - SleepTimeConsolidator.ts:229 —— 弹性晋升的实体多样性加成（读 conversations.entity_names）
      //   - SleepTimeConsolidator.ts:513 —— 跨 session 关联
      //     （WHERE entity_names IS NOT NULL AND entity_names != ''）→ 此前 assistant 行被整体排除
      //   - MemoryAssessor.ts:183/216 —— **是**该字段消费方（parseConversationEntities(conv.entity_names)），
      //     但被 :203 的 `if (conv.role !== 'user') continue;` 限定为**只吃 user 行**，
      //     故 assistant 轮补齐不影响它。
      //   - 【另案登记】SleepTimeConsolidator.ts:345 亦写 entity_names，但打的是 memories 表
      //     （该表无 entity_names 列，只有 fg_entity_names）→ 语句 prepare 即报错被 :476 catch 吞掉，
      //     该情景→语义归纳路径恒为 0。属本次范围外的独立缺陷，待另立任务。
      // 与 user 轮同源（同一 DNA 的 entity_genes），保证同一轮两行的实体视图一致。
      entityNames: input.dna.entity_genes.filter((g: any) => g.type !== 'self').map((g: any) => g.name),
      // 🔴 D2 修复(2026-09-11): assistant 轮补 perception。
      // 实测：该字段原缺失 → 全库 assistant 轮 perception_summary 100% 为空（833/833）。
      // ❗ 性质说明（S4 评审校正）：这是一项**对称性/前瞻性**补齐，而非修复当前可见缺失——
      //   conversations.perception_summary 的主消费方 MemoryAssessor 同样只处理 user 行；
      //   两行取同一次感知（input.p），保持 conversations 表两行字段完整同构。
      perception: { pleasure: input.p.pleasure, arousal: input.p.arousal, intimacy: input.p.intimacy },
      calciumScore: input.decision.enhanced.calcium_score,
      dnaRootId: (input.dna as any).dna_root_id,
      globalUid: input.dna.global_uid || (input.dna as any).dna_root_id,
      locationFingerprint: input.dna.location_fingerprint || '',
      belongEntityUuid: asstUUID || undefined,
      // S3 补充(同一缺陷类，S2 范围外，待 S4 评审确认): user 轮传 isTest，assistant 轮未传
      // → 测试模式下 assistant 行 is_test=0，会把测试数据混入生产记忆。补齐使两行对称。
      isTest: input.ctx.testMode ? 1 : 0,
      mentionedEntityUuids: mentionedEntityUuids,
    });
    if (_convAsstId) _convAsstRowId = _convAsstId;
  } catch (e: any) {
    console.error('[Persist] ❌ conversations.db 写入失败:', e?.message);
    hadError = true;
  }

  // ── Step 3: 砂金库 memories 表（fusion_memory.db）使用公共 API 写入 ──
  try {
    const sqlite = input.ctx.storage.getSQLite();
    const pJson = buildPerceptionJson(input.p, input.message);
    const calciumScore = input.decision.enhanced.calcium_score ?? 0.5;
    const calciumLevel = input.decision.enhanced.calcium_level ?? 1;
    const locusPath = (input.dna as any).locus_path || 'chat';
    const now = new Date().toISOString();
    const primaryEmotion = topic || 'chat';
    // V12.7(批1): 会晤（扮演他人）记忆写库显式打 roleplay 标记 — 隔离保障。
    // 会晤实体对话 = 玉瑶扮演他人，此前硬编码 'episodic' → 读侧过滤先天无标记可滤，
    // 实时 roleplay 碎片以普通记忆身份泄漏进户主检索。此处显式标记供读侧排除。
    const memoryKind = _meetingUUID ? 'roleplay' : 'episodic';

    // V13: Foresight 前瞻时态检测
    const foresight = detectForesight({ content: input.message, timestampMs: Date.now() });

    // 写用户消息 — 改造②：使用 SQLiteAdapter.writeMemory() 公共 API
    const idUser = `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    if (!sqlite.writeMemory({
      id: idUser, seqPos: input.seqPos, createdAt: now,
      perceptionJson: pJson, calciumScore, calciumLevel,
      locusPath, leafZone: 'user', rawInput: input.message,
      primaryEmotion, memoryType: 'dialog',
      memoryKind,
      lifecycleState: calciumLevel >= 2 ? 'active' : 'candidate',
      confidenceScore: 0.6,
      stabilityScore: calciumLevel >= 2 ? 0.45 : 0.2,
      threadId: (input.dna as any).dna_root_id ?? idUser,
      sourceConversationIds: [input.seqPos],
      dnaRootId: (input.dna as any).dna_root_id ?? null,          // P0-1: DNA根码落库
      entityGenes: (input.dna as any).entity_genes ?? null,       // P0-2: L3实体基因落库
      globalUid: input.dna.global_uid, locationFingerprint: input.dna.location_fingerprint,
      dialogGroupId: null, topicLabel: null,
      belongEntityUuid: belongUUID || undefined,  // V10.4: 实体归属标注
      isForesight: foresight.isForesight,         // V13: 前瞻标记
      validUntilMs: foresight.validUntilMs ?? null,
      foresightStatus: foresight.status,
    })) {
      hadError = true;
    }
    // V3: 40D — 用户消息写 perception_40d（M3 直接产出的语义维，瑶光客观维异步回填）
    writePerceptionV40Dual(sqlite, idUser, input.p, input.decision.enhanced.perceptionV40);

    // 🔴 V22 作品召回: 检测用户消息是否为作品（小说/文章），命中则写入 works 表。
    // 这是"长文召回"的元数据桥——让"那篇小说"这类指称词可被解析。
    try {
      const workRepo = new WorkRepository(sqlite);
      // S5-评审: 传 existingWorkId 让 isContinuation 正确（同 dialog_group 已有作品 = 续写）
      const _dgId = (input.dna as any).dialog_group_id ?? null;
      const _existingWork = _dgId ? workRepo.findByDialogGroup(_dgId) : null;
      const workDet = detectWork(input.message, input.dna, _existingWork?.work_id ?? null);
      if (workDet.isWork && workDet.confidence !== 'low') {
        const work = await workRepo.upsertWork({
          title: workDet.title,
          workType: workDet.workType || 'story',
          fullText: input.message,
          belongEntityUuid: belongUUID,
          dnaRootId: (input.dna as any).dna_root_id,
          sourceConversationIds: [idUser],
          dialogGroupId: _dgId,
          summary: workDet.summary,
          firstSentence: workDet.firstSentence,
        });
        // 回填 work_id 到刚写的记忆
        sqlite.writeRaw('UPDATE memories SET work_id = ? WHERE id = ?', work.work_id, idUser);
        console.log(`[WorkDetector] ✅ 识别作品《${work.title}》(${work.work_type}, 置信度=${workDet.confidence})`);
      }
    } catch (e) { console.warn('[WorkDetector] 作品检测跳过:', (e as Error)?.message); }

    // 写助理回复 — 剥离场景描写后再存储
    //     LLM 的回复含"（我趴在浴缸边…）"等动作描写。这是生成产物，不是语义记忆。
    //     原样存储 → 下次检索注入 → LLM 读到自己的场景文本 → 重新走进那个场景 → 死循环。
    //     存储时剥离括号场景描写，只保留语义内容（"我记得那次你说…我姐…"）。
    const idAssist = `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const cleanReply = input.reply.replace(/（[^）]*）/g, '').trim();
    const asstPJson = buildPerceptionJson(input.p, cleanReply);
    if (!sqlite.writeMemory({
      id: idAssist, seqPos: input.seqPos + 1, createdAt: now,
      perceptionJson: asstPJson, calciumScore, calciumLevel,
      locusPath, leafZone: 'assistant', rawInput: cleanReply,
      primaryEmotion, memoryType: 'dialog',
      memoryKind,
      lifecycleState: calciumLevel >= 2 ? 'active' : 'candidate',
      confidenceScore: 0.6,
      stabilityScore: calciumLevel >= 2 ? 0.45 : 0.2,
      threadId: (input.dna as any).dna_root_id ?? idAssist,
      sourceConversationIds: [input.seqPos + 1],
      dnaRootId: (input.dna as any).dna_root_id ?? null,          // P0-1: DNA根码落库
      entityGenes: (input.dna as any).entity_genes ?? null,       // P0-2: L3实体基因落库
      globalUid: input.dna.global_uid, locationFingerprint: input.dna.location_fingerprint,
      dialogGroupId: null, topicLabel: null,
      belongEntityUuid: asstUUID || undefined,  // P1-2: 统一走 EntityOwnershipResolver
    })) {
      hadError = true;
    }
    // V3: 40D — 助理回复写 perception_40d（M3 直接产出的语义维，瑶光客观维异步回填）
    writePerceptionV40Dual(sqlite, idAssist, input.p, input.decision.enhanced.perceptionV40);

    // ── V3: 瑶光客观维异步回填（fire-and-forget，绝不同步阻塞 chat） ──
    // M3 已直接产出 40D 语义维写入 perception_40d；此处异步补 D01-D08/D21-D32 客观维。
    try {
      const v40Semantic = input.decision.enhanced.perceptionV40 ?? buildFallbackV40(input.p);
      enqueueYaoguangBackfill(input.ctx, {
        dnaRootId: (input.dna as any).dna_root_id ?? input.dna.branch_id ?? '',
        globalUid: input.dna.global_uid,
        locationFingerprint: input.dna.location_fingerprint ?? '0'.repeat(32),
        sceneTags: input.dna.scene_tags,
        interpersonalLabels: input.dna.entity_genes
          ?.filter((g: any) => g.type === 'person' && g.name !== '我')
          .map((g: any) => g.name),
        rawInputText: input.message,
        memoryIds: [idUser, idAssist],
        p40Semantic: v40Semantic,
      });
    } catch (e) {
      console.warn('[Persist] 瑶光回填入队跳过:', (e as Error)?.message);
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
      const dhResult = writeToDualHelix(dhsqlite.rawDb, {
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
      if (!dhResult.success) {
        console.warn('[DualHelix] 写入失败 (将在下次定时重试):', dhResult.error);
      }
    } catch (e) { console.warn('[DualHelix] 写入跳过:', (e as Error).message); }
    try { dhsqlite.flushNow?.(); } catch { /* flush optional */ }
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

  // V13: 对话→事实归纳 — 写入 vault_log（金库）而非 knowledge_base
  // knowledge_base 仅用于用户上传的文件/文档知识，对话归纳属于金库记忆体系
  try {
    const _msg = input.message;
    const _patterns = [
      { re: /我(?:在|住在|家[住在])[^\s，。？！]{2,20}(?:[^\s，。？！]{0,5})?/, cat: '地址' },
      { re: /我(?:公?司|在)[^\s，。？！]{2,30}(?:公司|上班|工作|科技|工厂|企业)/, cat: '工作' },
      { re: /我(?:儿子|女儿|孩子|小孩|宝宝)[^\s，。？！叫]{0,10}(?:叫|是|名字)[^\s，。？！]{2,10}/, cat: '家人' },
      { re: /我(?:老婆|老公|妻子|丈夫|对象|男朋友|女朋友)[^\s，。？！叫]{0,10}(?:叫|是|在)[^\s，。？！]{2,20}/, cat: '家人' },
      { re: /我(?:爸|妈|父亲|母亲|爸爸|妈妈)[^\s，。？！叫]{0,10}(?:叫|是|名字)[^\s，。？！]{2,10}/, cat: '家人' },
    ];
    for (const { re, cat } of _patterns) {
      const _match = _msg.match(re);
      if (_match) {
        const _fact = _match[0].trim();
        if (_fact.length >= 4) {
          // V13: 写入 vault_log 金库（不再写入 knowledge_base）
          const vlId = 'vl_induct_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6);
          input.ctx.storage.getSQLite()?.writeRaw(
            "INSERT INTO vault_log (id, operation, source_type, detail, content_md, belong_entity_uuid, created_at) VALUES (?, 'auto_induct', 'conversation', ?, ?, ?, ?)",
            [vlId, `[对话归纳·${cat}] ${_fact}`, `鸿艺曾说过：${_msg}`, belongUUID || undefined, new Date().toISOString()],
          );
          console.log('[KB·Induct→Vault] ' + cat + ' → "' + _fact.substring(0, 30) + '"');
        }
        break; // 一条消息只提取最优先的
      }
    }
  } catch (_indErr) { /* 归纳失败不阻塞 */ }

  // ── V11.0: 增量n-gram索引写入（异步，fire-and-forget）──
  try {
    const _sqlite = input.ctx.storage?.getSQLite();
    if (_sqlite?.rawDb) {
      const { indexDocument } = await import('../../m4/SearchIndexBuilder.js');
      // P1-C 修复: source_id 用真实 conversations.id（与 rebuildAllIndexes 一致），
      // 不再用 dna_root_id（两者不同，导致增量索引关联错乱、检索 source 串号）。
      // 索引用户消息
      if (input.message?.length > 5) {
        indexDocument(_sqlite.rawDb, 'conversation', String(_convUserRowId ?? 'conv_' + Date.now()), input.message, (input.dna as any)?.belong_entity_uuid);
      }
      // 索引助手回复
      if (input.reply?.length > 5) {
        indexDocument(_sqlite.rawDb, 'conversation', String(_convAsstRowId ?? 'conv_' + Date.now()), input.reply, (input.dna as any)?.belong_entity_uuid);
      }
    }
  } catch { /* 索引写入不阻塞主流程 */ }

  // ── V12.1: 新实体即时UUID回填（P0-2: 仅 FG 未收录的新 person 触发回填，保留 PAE 建档能力，避免每次全扫描）──
  const _paFg = input.ctx.m4?.getFamilyGraph?.();
  if (_paFg && input.dna.entity_genes?.some((g: any) => g.type === 'person' && g.name !== '我' && g.name.length >= 2 && g.name !== ownerEntityName && !_paFg.getUUIDByName?.(g.name))) {
    try {
      const _fg = input.ctx.m4?.getFamilyGraph?.();
      const _si = input.ctx.storage?.getSQLite?.();
      if (_fg && _si?.rawDb) {
        const { backfillAllEntities } = await import('../../m4/household/EntityUUIDBackfill.js');
        backfillAllEntities(_si.rawDb, _fg);
      }
    } catch { /* 即时回填不阻塞 */ }
  }

  // ── V12.2: 记录最后活跃实体 — 供跨重启上下文锚定 ──
  if (belongUUID && ownerEntityName) {
    try {
      const _si = input.ctx.storage?.getSQLite?.();
      if (_si) {
        const { EntityContextStore } = await import('../../app/entity/EntityContextStore.js');
        const _store = new EntityContextStore(_si);
        _store.saveLastActiveEntity(belongUUID, ownerEntityName);
      }
    } catch { /* 非关键 */ }
  }
}
