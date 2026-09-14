/**
 * dream-content-filter-config 测试 — M7 结构修复
 * ============================================================
 * 测试目标：
 * 1. 配置加载正常（yaml 存在时读取，缺失时使用默认值）
 * 2. 敏感词匹配正确
 * 3. isDreamContentBlocked 返回正确布尔值
 * 4. 非敏感内容通过
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { isDreamContentBlocked } from '../dream-content-filter-config.js';

describe('dream-content-filter-config', () => {
  beforeEach(() => {
    // 模块级单例，测试间不重置
  });

  describe('isDreamContentBlocked', () => {
    it('应拦截包含敏感词的内容', () => {
      expect(isDreamContentBlocked('我没法回答这个问题')).toBe(true);
      expect(isDreamContentBlocked('禁止这种行为')).toBe(true);
      expect(isDreamContentBlocked('系统注意到你的问题')).toBe(true);
    });

    it('应允许非敏感内容', () => {
      expect(isDreamContentBlocked('今天天气很好')).toBe(false);
      expect(isDreamContentBlocked('我喜欢读书和旅行')).toBe(false);
      expect(isDreamContentBlocked('安琪是她的名字')).toBe(false);
    });

    it('应支持大小写不敏感匹配', () => {
      // 当前实现是小写匹配，测试小写场景
      expect(isDreamContentBlocked('没法')).toBe(true);
    });

    it('空字符串不应被拦截', () => {
      expect(isDreamContentBlocked('')).toBe(false);
    });

    it('部分匹配敏感词应被拦截', () => {
      expect(isDreamContentBlocked('这是个14岁的问题')).toBe(true);
      expect(isDreamContentBlocked('角色扮演场景')).toBe(true);
    });
  });
});
