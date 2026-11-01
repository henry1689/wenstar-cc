/**
 * ChatPolicy — 会话模式状态机 + 权限策略 (V12.0)
 * ================================================
 * 替代散落在 chat.ts 中 12 个 _meetingEntityName / _currentRoleplay 判断点。
 * 所有模式相关权限判断收敛到此模块。
 *
 * 设计原则:
 *   - 单一真相源: ChatMode 是唯一会话状态描述
 *   - 策略可查询: policy.canXxx() 替代裸 if (!_meetingEntityName)
 *   - 防御式默认: canXxx() 默认 false，白名单制
 *
 * 🔴 P071-Phase2 批B-3（2026-10-26，业主批准）：死枚举清理——
 *   `roleplay`（V4.0 已废除）与 `task`（零消费者实证）两个 ChatMode kind 及其工厂已删除；
 *   会话模式精简为三真实模式 normal / entity_meeting / secretary（对应 P088 权威矩阵）。
 *   原 roleplay 守卫条件随之简化（现存模式均可用主 FG / 知识库——隔离由 UUID 户籍法承担）。
 */

// ── 会话模式类型 ──

export type ChatMode =
  | { kind: 'normal' }
  | { kind: 'entity_meeting'; entityUuid: string; entityName: string }
  | { kind: 'secretary'; };

export type ChatModeKind = ChatMode['kind'];

// ── 权限策略 ──

export class ChatPolicy {
  constructor(private mode: ChatMode) {}

  /** 是否可以注入 M6 自我模型（人格/偏好/自传） */
  canInjectM6(): boolean {
    return this.mode.kind === 'normal' || this.mode.kind === 'secretary';
  }

  /** 是否可以使用主 FG（家族图谱）——roleplay 已废除（V4.0），现存三模式均可用；隔离由 UUID 户籍法承担 */
  canUseMainFG(): boolean {
    return true;
  }

  /** 是否可以将数据写入主 FG（同上：会晤写入按实体 UUID 隔离，非禁止写） */
  canPersistToMainFG(): boolean {
    return true;
  }

  /** 是否可以注入角色提示（当前角色路由） */
  canUseRoleHint(): boolean {
    // 会晤模式下实体有自己的身份，不注入玉瑶角色提示
    return this.mode.kind !== 'entity_meeting';
  }

  /** 是否可以注入 "不知道" 守卫（玉瑶不知道的事诚实说不知道） */
  canUseUnknownGuard(): boolean {
    // 会晤实体有自己的知识范围
    return this.mode.kind === 'normal' || this.mode.kind === 'secretary';
  }

  /** 是否可以检索用户记忆 */
  canRetrieveMemories(): boolean {
    // 会晤模式下跳过用户记忆检索（实体有自己的记忆范围）
    return this.mode.kind !== 'entity_meeting';
  }

  /** 是否可以使用 PFC 知识精炼 */
  canUsePFCKnowledgeRefine(): boolean {
    return this.mode.kind !== 'entity_meeting';
  }

  /** 是否可以使用知识库 */
  canUseKnowledgeBase(): boolean {
    return true;  // roleplay 已废除，隔离由 UUID 户籍法承担
  }

  /** 是否为实体会晤 */
  isEntityMeeting(): boolean {
    return this.mode.kind === 'entity_meeting';
  }

  // 🔴 P071-Phase2 批B-3：isRoleplay() 已随 roleplay kind 一并删除（仅测试引用，零生产消费）

  /** 获取活跃模式的简短描述 */
  getModeLabel(): string {
    switch (this.mode.kind) {
      case 'entity_meeting': return `会晤:${this.mode.entityName}`;
      case 'secretary': return '秘书模式';
      default: return '正常';
    }
  }

  /** 获取当前模式的 ChatModeKind，用于 PromptAssembler 的 modeScope */
  getModeKind(): ChatModeKind {
    return this.mode.kind;
  }
}

// ── 工厂函数 ──

export function normalMode(): ChatMode {
  return { kind: 'normal' };
}

export function meetingMode(entityUuid: string, entityName: string): ChatMode {
  return { kind: 'entity_meeting', entityUuid, entityName };
}

export function secretaryMode(): ChatMode {
  return { kind: 'secretary' };
}

// 🔴 P071-Phase2 批B-3：roleplayMode / taskMode 工厂已删除（roleplay V4.0 废除、task 零消费者）

export default ChatPolicy;
