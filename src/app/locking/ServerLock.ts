/**
 * ServerLock — 生产数据库写保护机制
 * ===================================
 * 问题：服务运行时直接改库会被 sql.js flush 覆盖
 * 方案：启动时创建 server.lock，写操作前检测锁文件
 *
 * 使用方式：
 *   const { ServerLock, requireUnlock } = require('./ServerLock');
 *   const lock = new ServerLock('data/webui/server.lock');
 *   lock.acquire(); // 启动时调用
 *   requireUnlock(lock); // 写操作前检查
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * ServerLock — 服务器锁管理类
 * @class
 */
class ServerLock {
  /**
   * @param {string} lockPath - 锁文件路径
   */
  constructor(lockPath) {
    /** @type {string} */
    this.lockPath = lockPath;
    /** @type {number} */
    this.pid = process.pid;
    /** @type {string} */
    this.host = os.hostname();
    /** @type {string} */
    this.startedAt = new Date().toISOString();
    /** @type {boolean} */
    this._acquired = false;
  }

  /** 获取锁，自动清理残留锁（进程已终止的情况） */
  acquire() {
    if (this._acquired) return;
    const dir = path.dirname(this.lockPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(this.lockPath)) {
      try {
        /** @type {{pid: number, host: string, startedAt: string, path: string}} */
        const existing = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
        try {
          process.kill(existing.pid, 0);
          throw new Error(`服务已在运行 (PID ${existing.pid}, host ${existing.host})`);
        } catch (e) {
          if (/** @type {Error} */(e).message.includes('服务已在运行')) throw e;
          // 进程不存在 → 残留锁，清理后重建
          console.warn(`[ServerLock] 检测到残留锁 (PID ${existing.pid} 已终止)，清理后重建`);
          fs.unlinkSync(this.lockPath);
        }
      } catch (e) {
        if (/** @type {Error} */(e).message.includes('服务已在运行')) throw e;
      }
    }
    const lockData = { pid: this.pid, host: this.host, startedAt: this.startedAt, path: this.lockPath };
    fs.writeFileSync(this.lockPath, JSON.stringify(lockData, null, 2), 'utf8');
    this._acquired = true;
    console.log(`[ServerLock] 已创建锁文件: ${this.lockPath}`);
    process.on('exit', () => this.release());
    process.on('SIGINT', () => { this.release(); process.exit(0); });
    process.on('SIGTERM', () => { this.release(); process.exit(0); });
  }

  /** 释放锁 */
  release() {
    if (!this._acquired) return;
    try {
      if (fs.existsSync(this.lockPath)) {
        fs.unlinkSync(this.lockPath);
        console.log(`[ServerLock] 已释放锁文件: ${this.lockPath}`);
      }
    } catch (e) {
      console.warn('[ServerLock] 释放锁失败:', /** @type {Error} */(e).message);
    }
    this._acquired = false;
  }

  /** 检查是否持锁 */
  isLocked() {
    return this._acquired || fs.existsSync(this.lockPath);
  }

  /** 获取锁信息 */
  getInfo() {
    if (!fs.existsSync(this.lockPath)) return null;
    try { return /** @type {{pid: number, host: string, startedAt: string, path: string}|null} */ (JSON.parse(fs.readFileSync(this.lockPath, 'utf8'))); } catch { return null; }
  }
}

/**
 * 写操作前检查锁
 * @param {ServerLock|null} lock - ServerLock 实例
 * @param {string} operation - 操作描述（用于错误信息）
 */
function requireUnlock(lock, operation = '数据库写入') {
  if (!lock || !lock.isLocked()) return; // 无锁则放行（向后兼容）
  const info = lock.getInfo();
  if (info && info.pid === process.pid) return; // 自身操作放行
  throw new Error(
    `[ServerLock] 拒绝 ${operation}：服务正在运行 (PID ${info?.pid}, host ${info?.host})。\n` +
    `锁文件: ${info?.path}\n` +
    `启动时间: ${info?.startedAt}\n` +
    `如需强制写入，请先停止服务或删除锁文件。`
  );
}

module.exports = { ServerLock, requireUnlock };
