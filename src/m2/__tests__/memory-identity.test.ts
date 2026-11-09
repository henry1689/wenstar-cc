/**
 * memory-identity.test.ts — 记忆身份键与强制字段（MEM-UNIFY-V1 批3）
 * ==================================================================
 * 锁定：
 *   - 归一文本只做 NFKC / 零宽 / 空白折叠，不做相似度；
 *   - 角色映射：user/assistant 互不混同；taxonomy zone → dialog；note/roleplay/knowledge_vault 独立；
 *   - 去重键 = (belong, role, normalized_text)；
 *   - 强制字段矩阵：belong / entity_genes / source 锚点 / 40D / dna_root 的缺失处置与豁免。
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeMemoryText,
  deriveMemoryRole,
  buildDedupeKey,
  validateMemoryWriteFields,
} from '../memory-identity.js';

describe('A. normalizeMemoryText', () => {
  it('NFKC 全半角归一 + 空白折叠 + trim', () => {
    expect(normalizeMemoryText('  ＡＢＣ   你好\t\n世界 ')).toBe('ABC 你好 世界');
  });

  it('去零宽字符', () => {
    expect(normalizeMemoryText('你​好﻿')).toBe('你好');
  });

  it('不做相似度/标点清洗（NFKC 只归全半角与空白，不删标点）', () => {
    // NFKC 会把全角「！」归一为半角「!」；标点本身保留、不删除
    expect(normalizeMemoryText('你好！')).toBe('你好!');
    expect(normalizeMemoryText('你好')).not.toBe(normalizeMemoryText('你好！'));
  });
});

describe('B. deriveMemoryRole', () => {
  it('user / assistant 独立成角色（互不拦截）', () => {
    expect(deriveMemoryRole({ leafZone: 'user' })).toBe('user');
    expect(deriveMemoryRole({ leafZone: 'assistant' })).toBe('assistant');
  });

  it('taxonomy zone → dialog（跨 zone 同一角色）', () => {
    expect(deriveMemoryRole({ leafZone: 'language_semantic_zone' })).toBe('dialog');
    expect(deriveMemoryRole({ leafZone: 'emotion_valence_zone' })).toBe('dialog');
    expect(deriveMemoryRole({ leafZone: 'social_schema_zone', memoryType: 'dialog' })).toBe('dialog');
  });

  it('note / roleplay / knowledge_vault 独立', () => {
    expect(deriveMemoryRole({ memoryType: 'note' })).toBe('note');
    expect(deriveMemoryRole({ leafZone: 'note_zone' })).toBe('note');
    expect(deriveMemoryRole({ memoryKind: 'roleplay', leafZone: 'user' })).toBe('roleplay');
    expect(deriveMemoryRole({ memoryKind: 'knowledge_vault' })).toBe('knowledge_vault');
    expect(deriveMemoryRole({ sourceType: 'knowledge_vault' })).toBe('knowledge_vault');
  });
});

describe('C. buildDedupeKey', () => {
  it('同一 (belong, role, 归一文本) → 同一键', () => {
    const a = buildDedupeKey('TXS-000000001', 'dialog', ' 你好   世界 ');
    const b = buildDedupeKey('TXS-000000001', 'dialog', '你好 世界');
    expect(a).toBe(b);
  });

  it('归属不同 / 角色不同 → 键不同', () => {
    expect(buildDedupeKey('TXS-1', 'user', 'x')).not.toBe(buildDedupeKey('TXS-2', 'user', 'x'));
    expect(buildDedupeKey('TXS-1', 'user', 'x')).not.toBe(buildDedupeKey('TXS-1', 'assistant', 'x'));
  });
});

describe('D. validateMemoryWriteFields', () => {
  const base = {
    rawInput: '今天去海边',
    belongEntityUuid: 'TXS-000000001',
    dnaRootId: 'DNA-1',
    entityGenes: [{ name: '玉瑶', type: 'person' }],
    memoryType: 'dialog',
    memoryKind: 'episodic',
    sourceConversationIds: [1],
    perceptionV40: '{"__v":2,"dims":[]}',
  };

  it('完整字段 → 通过', () => {
    expect(validateMemoryWriteFields(base).allowed).toBe(true);
  });

  it('缺归属 → 拒写', () => {
    expect(validateMemoryWriteFields({ ...base, belongEntityUuid: null }).reason).toBe('missing_belong');
  });

  it('归属格式非法 → 拒写', () => {
    expect(validateMemoryWriteFields({ ...base, belongEntityUuid: 'uuid-a' }).reason).toBe('invalid_belong_format');
  });

  it('缺 entity_genes → 拒写（roleplay 豁免）', () => {
    expect(validateMemoryWriteFields({ ...base, entityGenes: [] }).reason).toBe('missing_entity_genes');
    expect(validateMemoryWriteFields({ ...base, entityGenes: [], memoryKind: 'roleplay' }).allowed).toBe(true);
  });

  it('缺 source 锚点 / 缺 40D → 拒写', () => {
    expect(validateMemoryWriteFields({ ...base, sourceConversationIds: [], dialogGroupId: null }).reason).toBe('missing_source_anchor');
    expect(validateMemoryWriteFields({ ...base, perceptionV40: null }).reason).toBe('missing_perception_40d');
  });

  it('dna_root 缺失 → 从 dialogGroupId 派生', () => {
    const v = validateMemoryWriteFields({ ...base, dnaRootId: null, dialogGroupId: 'DG-1' });
    expect(v.allowed).toBe(true);
    expect(v.derived?.dnaRootId).toBe('DG-1');
  });

  it('dna_root 全缺 → 拒写', () => {
    expect(validateMemoryWriteFields({ ...base, dnaRootId: null }).reason).toBe('missing_dna_root');
  });

  it('note：无 genes/40D/锚点要求，但 belong 必填', () => {
    expect(validateMemoryWriteFields({ rawInput: '钥匙在抽屉', belongEntityUuid: 'TXS-000000001', memoryType: 'note' }).allowed).toBe(true);
    expect(validateMemoryWriteFields({ rawInput: '钥匙在抽屉', memoryType: 'note' }).reason).toBe('missing_belong');
  });

  it('knowledge_vault（证据文档）：允许 unowned 与缺字段', () => {
    expect(validateMemoryWriteFields({ rawInput: '文档摘要', memoryKind: 'knowledge_vault', belongEntityUuid: null }).allowed).toBe(true);
  });
});
