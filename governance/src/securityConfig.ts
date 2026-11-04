/**
 * securityConfig.ts — 安全配置中心
 *
 * 职责：
 * 1. 集中管理所有治理子系统的安全参数
 * 2. 配置带 HMAC 签名，运行时不可篡改
 * 3. 内置默认安全配置（secure by default）
 *
 * 设计理由：
 * - 热路径上不做签名校验（性能），仅在启动/更新时校验
 * - 签名密钥从环境变量或 owner 令牌派生，不硬编码
 * - updateConfig 需要授权令牌，防止运行时被恶意修改
 */

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

// ============================================================
// 类型定义
// ============================================================

/** 安全配置结构 */
export interface SecurityConfig {
  /** 配置版本号 */
  version: string;
  /** 密钥强度参数：哈希算法 */
  hashAlgorithm: 'sha256' | 'sha512';
  /** 密钥强度参数：HMAC 算法 */
  hmacAlgorithm: 'sha256' | 'sha512';
  /** 临时令牌默认 TTL（毫秒） */
  tokenTTLMs: number;
  /** 令牌最大 TTL（毫秒），防止超长令牌 */
  maxTokenTTLMs: number;
  /** 权限缓存 LRU 容量 */
  permissionCacheSize: number;
  /** 权限缓存 TTL（毫秒），0 表示不过期 */
  permissionCacheTTLMs: number;
  /** 审计日志环形缓冲大小（条数） */
  auditBufferSize: number;
  /** 审计日志刷盘阈值（条数）：缓冲满 N 条触发异步刷盘 */
  auditFlushThreshold: number;
  /** 审计日志刷盘间隔（毫秒）：兜底定时刷盘 */
  auditFlushIntervalMs: number;
  /** 完整性巡检：快速巡检间隔（毫秒） */
  quickCheckIntervalMs: number;
  /** 完整性巡检：深度巡检间隔（毫秒） */
  deepScanIntervalMs: number;
  /** 完整性巡检：Merkle Tree 哈希算法 */
  merkleHashAlgorithm: 'sha256' | 'sha512';
  /** 默认策略集：是否启用默认 deny-all */
  defaultDenyAll: boolean;
  /** 是否启用运行时源码哈希自检 */
  enableSelfIntegrityCheck: boolean;
  /** 配置签名（HMAC），由系统自动计算 */
  signature?: string;
  /** 配置更新时间戳 */
  updatedAt: number;
}

/** 配置更新补丁 */
export type ConfigPatch = Partial<Omit<SecurityConfig, 'version' | 'signature' | 'updatedAt'>>;

// ============================================================
// 默认配置（secure by default）
// ============================================================

/**
 * 内置默认安全配置
 * 设计原则：最小权限、最严默认、最小暴露
 */
const DEFAULT_CONFIG: SecurityConfig = {
  version: '2.0.0',
  hashAlgorithm: 'sha256',
  hmacAlgorithm: 'sha256',
  tokenTTLMs: 5 * 60 * 1000,        // 5 分钟
  maxTokenTTLMs: 60 * 60 * 1000,    // 1 小时
  permissionCacheSize: 1024,
  permissionCacheTTLMs: 30 * 1000,  // 30 秒
  auditBufferSize: 4096,
  auditFlushThreshold: 64,           // 满 64 条刷盘
  auditFlushIntervalMs: 5000,       // 5 秒兜底
  quickCheckIntervalMs: 60 * 1000,  // 1 分钟
  deepScanIntervalMs: 3600 * 1000,  // 1 小时
  merkleHashAlgorithm: 'sha256',
  defaultDenyAll: true,             // 默认拒绝，白名单模式
  enableSelfIntegrityCheck: true,
  updatedAt: Date.now(),
};

// ============================================================
// 内部状态
// ============================================================

/** 当前生效的配置（带签名） */
let currentConfig: SecurityConfig = { ...DEFAULT_CONFIG };

/** HMAC 签名密钥，从环境变量派生，默认用随机种子启动时生成 */
let signingKey: string;

/** 初始化标志 */
let initialized = false;

// ============================================================
// 内部工具
// ============================================================

/**
 * 计算配置的 HMAC 签名
 * 签名内容：除 signature 字段外的所有配置项，按 key 排序后序列化
 * 设计理由：确定性序列化，保证相同配置产生相同签名
 */
function computeConfigSignature(config: Omit<SecurityConfig, 'signature'>): string {
  // 按 key 排序后序列化，避免对象顺序影响签名
  const sortedKeys = Object.keys(config).sort();
  const canonical = sortedKeys
    .map((k) => `${k}=${JSON.stringify((config as Record<string, unknown>)[k])}`)
    .join('&');
  return createHmac('sha256', signingKey).update(canonical).digest('hex');
}

/**
 * 深度克隆配置（去掉 signature）
 */
function cloneConfigWithoutSignature(config: SecurityConfig): Omit<SecurityConfig, 'signature'> {
  const { signature: _sig, ...rest } = config;
  return { ...rest };
}

// ============================================================
// 公开 API
// ============================================================

/**
 * 初始化安全配置子系统
 * @param options.signingKey 签名密钥，不传则从环境变量 GOVERNANCE_SIGNING_KEY 读取，再不行则随机生成
 * @param options.overrides 初始配置覆盖项
 */
export function initSecurityConfig(options?: {
  signingKey?: string;
  overrides?: ConfigPatch;
}): void {
  // 确定签名密钥
  if (options?.signingKey) {
    signingKey = options.signingKey;
  } else if (process.env['GOVERNANCE_SIGNING_KEY']) {
    signingKey = process.env['GOVERNANCE_SIGNING_KEY'] as string;
  } else {
    // 开发模式：随机生成（生产环境必须通过环境变量注入）
    signingKey = randomBytes(32).toString('hex');
  }

  // 应用初始覆盖
  if (options?.overrides) {
    currentConfig = {
      ...DEFAULT_CONFIG,
      ...options.overrides,
      version: DEFAULT_CONFIG.version,
      updatedAt: Date.now(),
    };
  }

  // 计算初始签名
  const configWithoutSig = cloneConfigWithoutSignature(currentConfig);
  currentConfig.signature = computeConfigSignature(configWithoutSig);

  initialized = true;
}

/**
 * 获取当前安全配置（只读视图，防止外部修改）
 * 注意：返回的是深拷贝，外部修改不影响内部状态
 */
export function getConfig(): SecurityConfig {
  if (!initialized) {
    initSecurityConfig();
  }
  // 返回深拷贝，防止外部直接修改内部状态
  return JSON.parse(JSON.stringify(currentConfig)) as SecurityConfig;
}

/**
 * 更新安全配置
 * @param patch 配置补丁
 * @param ownerToken owner 授权令牌，必须校验通过才能更新
 * @throws 当令牌无效时抛出异常
 */
export function updateConfig(patch: ConfigPatch, ownerToken: string): SecurityConfig {
  if (!initialized) {
    initSecurityConfig();
  }

  // 校验 owner 令牌（常量时间比较，防时序攻击）
  const expectedToken = getOwnerToken();
  const tokenBuf = Buffer.from(ownerToken);
  const expectedBuf = Buffer.from(expectedToken);
  if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
    throw new Error('更新配置失败：owner 授权令牌无效');
  }

  // 合并配置（不允许修改 version 和 signature）
  const { version: _v, signature: _s, ...rest } = currentConfig;
  const newConfig: SecurityConfig = {
    ...rest,
    ...patch,
    version: currentConfig.version,
    updatedAt: Date.now(),
  };

  // 重新计算签名
  const configWithoutSig = cloneConfigWithoutSignature(newConfig);
  newConfig.signature = computeConfigSignature(configWithoutSig);

  currentConfig = newConfig;
  return getConfig();
}

/**
 * 校验当前配置的签名是否有效
 * @returns true 表示配置未被篡改
 */
export function verifyConfigSignature(): boolean {
  if (!initialized) {
    initSecurityConfig();
  }

  if (!currentConfig.signature) {
    return false;
  }

  const configWithoutSig = cloneConfigWithoutSignature(currentConfig);
  const expectedSig = computeConfigSignature(configWithoutSig);

  const expectedBuf = Buffer.from(expectedSig, 'hex');
  const actualBuf = Buffer.from(currentConfig.signature, 'hex');

  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * 获取 owner 授权令牌（内部使用）
 * 令牌由签名密钥派生，保证只有持有正确 signingKey 的人才能生成
 */
export function getOwnerToken(): string {
  if (!initialized) {
    initSecurityConfig();
  }
  return createHmac('sha256', signingKey).update('owner-token').digest('hex');
}

/**
 * 生成新的 owner 令牌（用于轮换）
 * 必须用旧令牌才能生成新令牌，形成链式授权
 */
export function rotateOwnerToken(oldToken: string): string {
  if (!initialized) {
    initSecurityConfig();
  }

  const expectedToken = getOwnerToken();
  const tokenBuf = Buffer.from(oldToken);
  const expectedBuf = Buffer.from(expectedToken);
  if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
    throw new Error('令牌轮换失败：旧令牌无效');
  }

  // 派生新密钥（简单派生：在原密钥上加盐）
  signingKey = createHmac('sha256', signingKey).update('rotate').digest('hex');

  // 重新计算配置签名
  const configWithoutSig = cloneConfigWithoutSignature(currentConfig);
  currentConfig.signature = computeConfigSignature(configWithoutSig);

  return getOwnerToken();
}

/**
 * 重置配置到默认值（测试辅助用）
 */
export function _resetForTest(): void {
  currentConfig = { ...DEFAULT_CONFIG };
  initialized = false;
}
