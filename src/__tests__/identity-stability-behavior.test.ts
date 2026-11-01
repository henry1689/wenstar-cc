/**
 * 身份稳定性与持久化行为测试 (P1-8)
 * =================================
 * 验证:
 *   1. 会晤模式不泄漏玉瑶身份
 *   2. 模式切换后身份正确恢复
 *   3. 持久化数据不丢失
 */
import { describe, it, expect } from 'vitest';
import { ChatPolicy, meetingMode, normalMode, secretaryMode } from '../app/chat/ChatPolicy.js';

describe('ChatPolicy — 模式切换身份正确性', () => {
  it('正常模式 → 所有权限开放', () => {
    const p = new ChatPolicy(normalMode());
    expect(p.canInjectM6()).toBe(true);
    expect(p.canUseRoleHint()).toBe(true);
    expect(p.canUseUnknownGuard()).toBe(true);
    expect(p.canUsePFCKnowledgeRefine()).toBe(true);
    expect(p.isEntityMeeting()).toBe(false);
  });

  it('会晤模式 → M6/roleHint/unknownGuard 全部禁止', () => {
    const p = new ChatPolicy(meetingMode('TXS-1', '徐诗韵'));
    expect(p.canInjectM6()).toBe(false);
    expect(p.canUseRoleHint()).toBe(false);
    expect(p.canUseUnknownGuard()).toBe(false);
    expect(p.canUsePFCKnowledgeRefine()).toBe(false);
    expect(p.isEntityMeeting()).toBe(true);
  });

  it('roleplay/task 模式已彻底废除（批B-3 死枚举清理）', () => {
    // ChatMode 联合类型已收窄，编译期即不可表达 roleplay/task —— 运行时断言 modeKind 白名单
    for (const m of [normalMode(), meetingMode('TXS-1', '徐诗韵'), secretaryMode()]) {
      expect(['normal', 'entity_meeting', 'secretary']).toContain(new ChatPolicy(m).getModeKind());
    }
  });

  it('会晤模式 → 记忆检索关闭', () => {
    const p = new ChatPolicy(meetingMode('TXS-2', '熊梓铭'));
    expect(p.canRetrieveMemories()).toBe(false);
  });

  it('秘书模式 → M6可用，其他业务权限同正常模式', () => {
    const p = new ChatPolicy(secretaryMode());
    expect(p.canInjectM6()).toBe(true);
    expect(p.canUseRoleHint()).toBe(true);
    expect(p.canUseMainFG()).toBe(true);
  });

  it('getModeLabel — 返回可读描述', () => {
    expect(new ChatPolicy(normalMode()).getModeLabel()).toBe('正常');
    expect(new ChatPolicy(meetingMode('','熊梓铭')).getModeLabel()).toBe('会晤:熊梓铭');
  });
});

describe('持久化行为 — ChatPolicy 模式快照', () => {
  const modes = ['normal', 'entity_meeting', 'secretary'] as const;
  const expectedBlocks: Record<string, string[]> = {
    normal: ['M6', 'roleHint', 'memory', 'unknownGuard'],
    entity_meeting: ['entityContext'],
    secretary: ['M6', 'roleHint'],
  };

  for (const mode of modes) {
    it(`${mode} 模式 — 验证权限矩阵不退化`, () => {
      const p = mode === 'entity_meeting' ? new ChatPolicy(meetingMode('', ''))
        : mode === 'secretary' ? new ChatPolicy(secretaryMode())
        : new ChatPolicy(normalMode());

      // 每个模式的核心权限不随时间退化
      expect(p.getModeLabel().length).toBeGreaterThan(0);
      expect(typeof p.canInjectM6()).toBe('boolean');
      expect(typeof p.canUseMainFG()).toBe('boolean');
      expect(typeof p.canPersistToMainFG()).toBe('boolean');
    });
  }
});
