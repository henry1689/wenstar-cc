/**
 * RoleplayMemorySync — 角色扮演域·三库记忆同步（阶段2-1）
 *
 * 职责：角色扮演对话写入三库（砂金/金库/黑钻），与主系统同标准。
 *
 * 🔴 铁律：
 *   - 所有数据带 `roleplay_id` + `source=roleplay` 双标记
 *   - 和玉瑶本体同库同表但逻辑隔离
 *   - 普通对话检索时自动过滤（由 ConversationDB 处理）
 */

import crypto from 'node:crypto';

/** 记忆写入参数 */
export interface RPWriteInput {
  roleplayId: string;
  roleplayChar: string;
  seqPos: number;
  message: string;
  reply: string;
  /** 情感向量（可选，无则用默认） */
  emotion?: Record<string, number>;
  calciumScore?: number;
  dnaRootId?: string;
  /** 是否为测试对话 */
  isTest?: boolean;
}

/** 三库同步接口（从 FusionStorageAdapter 和 ConversationDB 抽象） */
export interface RPStorageAPI {
  insertConversation(role: string, content: string, opts?: Record<string, any>): void;
  writeMemory(opts: Record<string, any>): boolean;
  queryAll(sql: string, params?: any[]): any[];
}

/**
 * 写入一轮角色扮演对话到三库
 */
export async function syncRPConversation(
  storage: RPStorageAPI,
  input: RPWriteInput,
): Promise<void> {
  const { roleplayId, roleplayChar, seqPos, message, reply } = input;
  const ts = new Date().toISOString();
  const dgId = `rp_${roleplayChar}_${seqPos}`;

  // ── 砂金库：原始对话（conversations 表） ──
  storage.insertConversation('user', message, {
    seqPos,
    topic: 'roleplay',
    dialogGroupId: dgId,
    roleplayChar,
    isTest: input.isTest ? 1 : 0,
  });
  storage.insertConversation('assistant', reply, {
    seqPos: seqPos + 1,
    topic: 'roleplay',
    dialogGroupId: dgId,
    roleplayChar,
    isTest: input.isTest ? 1 : 0,
  });

  // ── 金库：结构化记忆（memories 表） ──
  const pJson = JSON.stringify(input.emotion || { pleasure: 0, arousal: 0, intimacy: 0 });
  const caScore = input.calciumScore ?? 0.5;
  const rpTag = `rp_${roleplayChar}`;
  const primaryEmotion = `角色扮演·${roleplayChar}`;

  const idUser = `rp_mem_${roleplayId}_${seqPos}_u`;
  storage.writeMemory({
    id: idUser, seqPos, createdAt: ts,
    perceptionJson: pJson, calciumScore: caScore, calciumLevel: 1,
    locusPath: `roleplay.${roleplayChar}`, leafZone: 'user',
    rawInput: message.substring(0, 2000),
    primaryEmotion, memoryType: 'dialog',
    dialogGroupId: rpTag, topicLabel: 'roleplay',
  });

  const idAssist = `rp_mem_${roleplayId}_${seqPos}_a`;
  storage.writeMemory({
    id: idAssist, seqPos: seqPos + 1, createdAt: ts,
    perceptionJson: pJson, calciumScore: caScore, calciumLevel: 1,
    locusPath: `roleplay.${roleplayChar}`, leafZone: 'assistant',
    rawInput: reply.substring(0, 2000),
    primaryEmotion, memoryType: 'dialog',
    dialogGroupId: rpTag, topicLabel: 'roleplay',
  });
}

/**
 * 生成角色扮演会话 ID
 */
export function generateRPId(): string {
  return `rp_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}
