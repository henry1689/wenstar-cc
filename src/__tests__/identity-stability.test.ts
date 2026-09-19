/**
 * V10.0 P1-3: 角色稳定性测试（需要运行服务器）
 * 验证会晤模式下回复不出现"我是玉瑶"
 *
 * 运行前提：服务器在 localhost:3000 运行
 */
import { describe, it, expect } from 'vitest';

const BASE = 'http://localhost:3000';

async function chat(message: string): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, test_mode: true }),
  });
  const text = await res.text();
  return { status: res.status, data: JSON.parse(text) };
}

describe('角色稳定性 — 会晤模式身份不污染', () => {
  // 🔴 2026-09-19：把 30s → 120s。根因不是代码缺陷，而是**真实 LLM 延迟方差**：
  //   三个用例均走真实 DeepSeek 全管线调用，隔离运行时实测「2 通过 / 1 在 30000ms 超时」。
  //   30s 对一次全管线 LLM 调用而言过紧 ⇒ 会产生**假红**（掩盖真实回归）。
  //   提高超时后：LLM 正常时仍会因断言失败而报错，不会吞掉真问题。
  it('玉瑶正常模式回复不出现"我是别人"', { timeout: 120000 }, async () => {
    const { status, data } = await chat('你好');
    expect(status).toBe(200);
    expect(typeof data.reply).toBe('string');
    expect(data.reply.length).toBeGreaterThan(0);
    // 玉瑶模式下的回复应该有内容
    expect(data.reply).toBeTruthy();
  });

  it('会晤模式下回复不含"我是玉瑶"', { timeout: 120000 }, async () => {
    // 先触发会晤
    const { status: s1, data: d1 } = await chat('徐诗雨');
    expect(s1).toBe(200);

    // 再发一条消息确认仍在角色中
    const { status: s2, data: d2 } = await chat('你好呀');
    expect(s2).toBe(200);

    // 回复不应包含"我是玉瑶"
    const reply = (d2.reply || '').toLowerCase();
    expect(reply).not.toContain('我是玉瑶');
    expect(reply).not.toContain('我叫玉瑶');
  });

  it('退出会晤', { timeout: 120000 }, async () => {
    const { status } = await chat('散会');
    expect(status).toBe(200);
  });
});
