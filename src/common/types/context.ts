/**
 * ChatContext — 全局统一上下文
 *
 * 📜 架构铁律：全链路唯一状态源
 * - 所有模块禁止自行创建角色状态
 * - classify() 全局只暴露一处统一工具函数
 * - 全链路通过此接口读写，消除三处独立角色状态冲突
 */

import type { RoleType } from '../../app/role/RoleClassifier.js';
import type { TransitionState } from '../../app/role/TransitionManager.js';
import type { DNA } from '../../m1/types/dna.js';
import type { M4Context } from '../../m4/types/index.js';

export interface ChatContext {
  // ── 会话基础 ──
  sessionId: string;
  dgId: string;
  userRawMsg: string;

  // ── 全局唯一角色状态（只在此一处维护，全链路只读） ──
  currentRole: RoleType;
  rpState: TransitionState;
  rpChar: null;  // V4.0: 角色扮演已废除
  rpTurn: number;
  rpJustExit: boolean;

  // ── 全链路中间产物，统一透传 ──
  dna: DNA;
  calciumScore: number;
  m4Ctx: M4Context;

  // ── 全局标记 ──
  isRolePlayMode: boolean;
  isIntimateScene: boolean;
}
