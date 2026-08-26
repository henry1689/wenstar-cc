/**
 * entity-realms.ts — 太虚境实体域配置加载器
 * ===========================================
 * 读取 config/entity-realms.config.yaml，提供天界/人间实体边界查询。
 * 边界（写进 yaml 的几条关键系统边界）：
 *   1. 警幻（天界域）：不进人间人物列表；只能呼叫按钮/专门传唤指令接通
 *   2. 警幻只读全部 UUID 卷宗，不能直接写库（变更转交引擎层）
 *   3. 切换警幻会话时保存人间现场，退出复原；人间看不到她的对话
 *   4. 玉瑶（人间域特殊实体 category='S'）：常驻人间列表，可私聊/会晤
 *   5. 玉瑶更高权限：对接底层模块、承接警幻指令
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export interface RealmEntityDef {
  name: string;
  aliases?: string[];
  uuid?: string;
  title?: string;
  role?: string;
  category?: string;
  access?: {
    method?: string[];
    visible_in_human_list?: boolean;
    summon_patterns?: string[];
  };
  permissions?: {
    read?: string[];
    write?: boolean;
    execute?: string;
    engine_access?: boolean;
    receive_world_commands?: boolean;
  };
  isolation?: {
    save_human_session_on_enter?: boolean;
    restore_on_exit?: boolean;
    human_cannot_view?: boolean;
    memory_emotion?: string;
    follow_human_rules?: boolean;
  };
}

export interface EntityRealmsConfig {
  version: number;
  realms: {
    celestial: Record<string, RealmEntityDef>;
    human: Record<string, RealmEntityDef>;
  };
}

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'entity-realms.config.yaml');

let _cache: EntityRealmsConfig | null = null;

export function getEntityRealmsConfig(): EntityRealmsConfig {
  if (_cache) return _cache;
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      _cache = parse(raw) as EntityRealmsConfig;
    }
  } catch {
    _cache = null;
  }
  if (!_cache) {
    // 兜底默认
    _cache = {
      version: 1,
      realms: { celestial: {}, human: {} },
    };
  }
  return _cache;
}

/** 实体在哪个域: 'celestial' | 'human' | null */
export function entityRealmOf(name: string): 'celestial' | 'human' | null {
  const cfg = getEntityRealmsConfig();
  if (!cfg?.realms) return null;
  for (const realm of ['celestial', 'human'] as const) {
    const map = cfg.realms[realm] || {};
    for (const def of Object.values(map)) {
      if (def.name === name || (def.aliases || []).includes(name)) return realm;
    }
  }
  return null;
}

/** 天界域实体（警幻等） */
export function isCelestialEntity(name: string): boolean {
  return entityRealmOf(name) === 'celestial';
}

/** 是否出现在人间人物列表（天界域默认 false） */
export function isVisibleInHumanList(name: string): boolean {
  const cfg = getEntityRealmsConfig();
  if (!cfg?.realms) return true;
  for (const realm of ['celestial', 'human'] as const) {
    const map = cfg.realms[realm] || {};
    for (const def of Object.values(map)) {
      if (def.name !== name && !(def.aliases || []).includes(name)) continue;
      // 默认：人间域可见，天界域不可见
      return def.access?.visible_in_human_list ?? realm === 'human';
    }
  }
  return true;
}

/** 天界域实体只读（不能直接写库） */
export function isReadOnlyEntity(name: string): boolean {
  const cfg = getEntityRealmsConfig();
  if (!cfg?.realms) return false;
  for (const def of Object.values(cfg.realms.celestial || {})) {
    if (def.name === name || (def.aliases || []).includes(name)) {
      return def.permissions?.write === false;
    }
  }
  return false;
}

/** 获取实体域定义 */
export function getRealmEntityDef(name: string): { realm: 'celestial' | 'human'; def: RealmEntityDef } | null {
  const cfg = getEntityRealmsConfig();
  if (!cfg?.realms) return null;
  for (const realm of ['celestial', 'human'] as const) {
    const map = cfg.realms[realm] || {};
    for (const [key, def] of Object.entries(map)) {
      if (def.name === name || (def.aliases || []).includes(name)) {
        return { realm, def: { ...def, name: def.name || key } };
      }
    }
  }
  return null;
}
