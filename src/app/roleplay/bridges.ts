/**
 * roleplay/bridges.ts — roleplay-legacy → roleplay 迁移桥
 * ======================================================
 * 6 个 legacy 独有模块通过此文件 re-export。
 * 新代码 import 此文件，旧代码继续直引 legacy，互不干扰。
 * 阶段 3 完成迁移后删除此文件即可。
 */
// @ts-nocheck — legacy files are production-tested, skip strict checks on bridges
export { buildRoleplayRules } from '../roleplay-legacy/RoleplayPromptBuilder.js';
export { scanContextForCharacter, assembleCharacterPortrait } from '../roleplay-legacy/CharacterProfileScanner.js';
export type { CharacterExtract, CharacterPortraitSources } from '../roleplay-legacy/CharacterProfileScanner.js';
export { PerspectiveFilter } from '../roleplay-legacy/PerspectiveFilter.js';
export { RoleParamsSnapshot } from '../roleplay-legacy/RoleParamsSnapshot.js';
export type { RoleParams } from '../roleplay-legacy/RoleParamsSnapshot.js';
export { checkRoleplayHealth } from '../roleplay-legacy/RoleplayHealthGuard.js';
export { EmotionSnapshot } from '../roleplay-legacy/EmotionSnapshot.js';
