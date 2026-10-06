import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { YuyaoMemoryService } from '../YuyaoMemoryService.js';

/**
 * P0-2a 回归（2026-10-06）：记事子系统归属兜底。
 *
 * 缺陷：YuyaoMemoryService 的 setEntityUuid 注释写「由 chat.ts 每轮更新」，实测全仓零调用点，
 *      构造亦不传 entityUuid ⇒ 三处写入的 belong_entity_uuid 恒为 NULL，
 *      自 2026-09-19 收口到 writeMemory 起累计 166 条记事落出归属链路。
 * 修法：新增 setFallbackUuid（记事 = 户主玉瑶的私有事实，归属户主语义正确），
 *      写入取 `entityUuid ?? fallbackUuid`；两者皆空时**告警但照写**（兜底 ≠ 丢弃）。
 */

interface Written {
  id: string;
  memoryType: string;
  subType: string;
  rawInput: string;
  belongEntityUuid: string | null;
}

/** 最小 SQLiteAdapter 桩：只录 writeMemory / writeRaw 的调用 */
function mkSqlite(): { sqlite: any; written: Written[]; raw: string[] } {
  const written: Written[] = [];
  const raw: string[] = [];
  const sqlite = {
    writeMemory: (m: any) => {
      written.push({
        id: m.id, memoryType: m.memoryType, subType: m.subType,
        rawInput: m.rawInput, belongEntityUuid: m.belongEntityUuid,
      });
    },
    writeRaw: (sql: string) => { raw.push(sql); },
    queryAll: () => [],
  };
  return { sqlite, written, raw };
}

describe('P0-2a 归属兜底 — 记事写入', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('🔴 无会话实体时，兜底 UUID 必须生效（不得落 NULL）', () => {
    const { sqlite, written } = mkSqlite();
    const svc = new YuyaoMemoryService(sqlite);
    svc.setFallbackUuid('SELF-00001');

    svc.storeObjectLocation('车钥匙', '玄关抽屉');
    svc.storeFact('张经理', '公司客户');
    svc.setReminder('明天买牛奶', new Date().toISOString());

    expect(written).toHaveLength(3);
    for (const w of written) expect(w.belongEntityUuid).toBe('SELF-00001');
    expect(written.map((w) => w.subType)).toEqual(['object_location', 'fact', 'reminder']);
  });

  it('会话实体优先于兜底（setEntityUuid 一旦真被调用，覆盖兜底）', () => {
    const { sqlite, written } = mkSqlite();
    const svc = new YuyaoMemoryService(sqlite);
    svc.setFallbackUuid('SELF-00001');
    svc.setEntityUuid('TXS-000000007');

    svc.storeFact('诗韵', '徐诗雨的妹妹');
    expect(written[0].belongEntityUuid).toBe('TXS-000000007');
  });

  it('构造期传入的 entityUuid 同样优先于兜底', () => {
    const { sqlite, written } = mkSqlite();
    const svc = new YuyaoMemoryService(sqlite, 'TXS-000000007');
    svc.setFallbackUuid('SELF-00001');

    svc.storeObjectLocation('钥匙', '抽屉');
    expect(written[0].belongEntityUuid).toBe('TXS-000000007');
  });

  it('🔴 两者皆空 → 告警但**仍然写入**（兜底不得退化成丢弃）', () => {
    const { sqlite, written } = mkSqlite();
    const svc = new YuyaoMemoryService(sqlite);

    svc.storeFact('钥匙', '抽屉');

    expect(written).toHaveLength(1);                      // 写入了，没丢
    expect(written[0].belongEntityUuid).toBeNull();       // 归属仍为 null（如实）
    expect(warnSpy).toHaveBeenCalled();                   // 但必须告警
    expect(String(warnSpy.mock.calls[0][0])).toContain('归属未定');
  });

  it('setFallbackUuid(null) 可显式清空兜底', () => {
    const { sqlite, written } = mkSqlite();
    const svc = new YuyaoMemoryService(sqlite);
    svc.setFallbackUuid('SELF-00001');
    svc.setFallbackUuid(null);

    svc.storeObjectLocation('伞', '门口');
    expect(written[0].belongEntityUuid).toBeNull();
  });

  it('无会话实体时不得抛错（失败不阻断对话）', () => {
    const { sqlite } = mkSqlite();
    const svc = new YuyaoMemoryService(sqlite);
    expect(() => svc.storeFact('a', 'b')).not.toThrow();
    expect(() => svc.storeObjectLocation('a', 'b')).not.toThrow();
    expect(() => svc.setReminder('a', new Date().toISOString())).not.toThrow();
  });
});
