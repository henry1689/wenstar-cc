/**
 * memarch-bridge 运维端点契约测试
 *
 * 为什么不测「端到端真跑 HTTP」：
 *   这组端点是**运维面**（能切读写路由、能 KILL SWITCH），它的第一道防线是
 *   「谁来调」。把服务拉起来测反而测不到安全闸——真正会出事的场景是
 *   **非本机请求**打进来。因此直接构造 mock req/res 调 handler，毫秒级验证契约。
 *
 * 覆盖的三条契约（对应 handleMemarchBridgeRoutes 的三个提前返回分支）：
 *   ① 路径前缀不匹配 → 返回 false，交还给后续路由，**不接管**；
 *   ② 非 loopback 来源 → 403，且在初始化 bridge **之前**就拒绝（不加载 better-sqlite3）；
 *   ③ v2 库不存在 → 503 收敛，绝不抛异常穿到主流程。
 *
 * 🔴 顺序有意义：ensureBridge 有模块级缓存（失败即缓存 null），
 *   凡是会触发初始化的用例必须放在不触发初始化的用例之后。
 */
import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleMemarchBridgeRoutes } from '../webui/server-memarch-bridge-routes.js';

type Captured = { code?: number; body?: string };

function mockReq(path: string, opts: { method?: string; remoteAddress?: string } = {}): IncomingMessage {
  return {
    method: opts.method ?? 'GET',
    socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
    url: path,
  } as unknown as IncomingMessage;
}

function mockRes(): { res: ServerResponse; out: Captured } {
  const out: Captured = {};
  const res = {
    writeHead(code: number) {
      out.code = code;
    },
    end(body?: string) {
      out.body = body;
    },
  } as unknown as ServerResponse;
  return { res, out };
}

async function call(
  path: string,
  opts: { method?: string; remoteAddress?: string; dataDir?: string } = {},
): Promise<{ handled: boolean; out: Captured }> {
  const { res, out } = mockRes();
  const handled = await handleMemarchBridgeRoutes({
    req: mockReq(path, opts),
    res,
    url: new URL(path, 'http://127.0.0.1'),
    dataDir: opts.dataDir ?? 'D:/__no_such_memarch_dir__',
    readBody: async () => '',
  });
  return { handled, out };
}

describe('memarch-bridge 运维端点', () => {
  it('① 前缀不匹配时不接管，交还后续路由', async () => {
    const { handled, out } = await call('/api/other-thing');
    expect(handled).toBe(false);
    expect(out.code).toBeUndefined();
  });

  it('② 非 loopback 来源直接 403，且不触发 bridge 初始化', async () => {
    const { handled, out } = await call('/api/memarch-bridge/health', { remoteAddress: '10.1.2.3' });
    expect(handled).toBe(true);
    expect(out.code).toBe(403);
    expect(JSON.parse(out.body ?? '{}')).toMatchObject({ ok: false, error: 'loopback_only' });
  });

  it('②b IPv6 非本机来源同样 403', async () => {
    const { out } = await call('/api/memarch-bridge/ratio', {
      method: 'POST',
      remoteAddress: '2001:db8::1',
    });
    expect(out.code).toBe(403);
  });

  it('③ 本机访问但 v2 库缺失时收敛 503，不抛异常', async () => {
    const { handled, out } = await call('/api/memarch-bridge/health', {
      dataDir: 'D:/__no_such_memarch_dir__',
    });
    expect(handled).toBe(true);
    expect(out.code).toBe(503);
    expect(JSON.parse(out.body ?? '{}')).toMatchObject({ ok: false, error: 'bridge_not_initialized' });
  });
});
