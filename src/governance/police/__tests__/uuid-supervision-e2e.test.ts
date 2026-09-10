/**
 * UUID 监管端到端联测（步骤 3，2026-09-11）
 * ==========================================
 * 覆盖三条监管主张（此前我只修了「归属写入」，从未端到端验证过监管本身）：
 *   A. 会晤写隔离   —— 会晤中不得写入「主 FG 已有的其他实体」（防会晤编造污染户籍）
 *   B. 网关层语义   —— FGProfileWriteGateway.tryUpdateProfile 必须把授权结果如实返回，
 *                      且被拒时**不得**触达底层写入
 *   C. 任意称呼归一 —— 全名/小名/昵称/别名都必须归一到同一个 UUID（UUID 通则红线①）
 *
 * 说明：C 用**生产 FG 的副本**（不碰生产库），因为 FamilyGraph.initialize() 会执行迁移/写入。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { canWriteEntity, type WritePolicy } from '../UUIDPoliceFilter.js';
// 路径：src/governance/police/__tests__/ → 上溯 3 层到 src，再进 m4/household
const GW_PATH = '../../../m4/household/FGProfileWriteGateway.js';
const FG_PATH_MOD = '../../../m4/household/FamilyGraph.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FG_SRC = join(REPO, 'data', 'webui', 'knowledge', 'family_graph.db');

// 已知户籍（生产实测值）
const U_MEETING = '徐诗韵';
const U_MEETING_UUID = 'TXS-000000011';
const U_OTHER_EXISTING = '熊梓铭';
const U_OTHER_UUID = 'TXS-000000003';

/** 最小 FG 桩：只提供 canWriteEntity 需要的 getUUIDByName */
const FG_STUB = {
  getUUIDByName: (n: string): string | null =>
    ({ [U_MEETING]: U_MEETING_UUID, [U_OTHER_EXISTING]: U_OTHER_UUID })[n] ?? null,
};

const NO_MEETING: WritePolicy = { meetingEntityUuid: null, meetingEntityName: null };
const IN_MEETING: WritePolicy = { meetingEntityUuid: U_MEETING_UUID, meetingEntityName: U_MEETING };

describe('[监管 A] 会晤写隔离 —— canWriteEntity', () => {
  it('非会晤：写任意已知实体一律放行（用户自由录入）', () => {
    expect(canWriteEntity(U_OTHER_EXISTING, NO_MEETING, FG_STUB).allowed).toBe(true);
    expect(canWriteEntity(U_MEETING, NO_MEETING, FG_STUB).allowed).toBe(true);
  });

  it('会晤中：写「会晤实体本人」放行', () => {
    expect(canWriteEntity(U_MEETING, IN_MEETING, FG_STUB).allowed).toBe(true);
  });

  it('会晤中：写「主 FG 已有的其他实体」→ 必须拒绝（核心防线）', () => {
    const r = canWriteEntity(U_OTHER_EXISTING, IN_MEETING, FG_STUB);
    expect(r.allowed, '会晤中写其他既有实体必须被拒，否则会晤可编造污染户籍').toBe(false);
    expect(String(r.reason)).toContain('拦截');
  });

  it('会晤中：写「主 FG 尚不存在的新实体」放行（保留正常建档能力）', () => {
    expect(canWriteEntity('从未登记的新人物', IN_MEETING, FG_STUB).allowed).toBe(true);
  });

  it('边界：空目标名一律拒绝', () => {
    expect(canWriteEntity('', IN_MEETING, FG_STUB).allowed).toBe(false);
    expect(canWriteEntity('   ', NO_MEETING, FG_STUB).allowed).toBe(false);
  });
});

describe('[监管 B] 网关层 —— tryUpdateProfile 必须如实返回授权结果且被拒时不触达写入', () => {
  it('会晤中写其他既有实体 → 返回 false 且底层 updatePersonProfile 未被调用', async () => {
    const { FGProfileWriteGateway } = await import(GW_PATH);
    const calls: Array<{ name: string }> = [];
    const fgMock: any = {
      getUUIDByName: FG_STUB.getUUIDByName,
      updatePersonProfile: (name: string) => { calls.push({ name }); },
    };
    const gw = new FGProfileWriteGateway(() => fgMock, () => IN_MEETING);
    const ok = gw.tryUpdateProfile(U_OTHER_EXISTING, { 'contact.workplace': '伪造公司' });
    expect(ok, 'tryUpdateProfile 必须返回 false（被拒）').toBe(false);
    expect(calls.length, '被拒时不得触达底层写入（防污染户籍）').toBe(0);
  });

  it('会晤中写会晤实体本人 → 返回 true 且实际写入', async () => {
    const { FGProfileWriteGateway } = await import(GW_PATH);
    const calls: string[] = [];
    const fgMock: any = {
      getUUIDByName: FG_STUB.getUUIDByName,
      updatePersonProfile: (name: string) => { calls.push(name); },
    };
    const gw = new FGProfileWriteGateway(() => fgMock, () => IN_MEETING);
    expect(gw.tryUpdateProfile(U_MEETING, { 'contact.workplace': '深圳' })).toBe(true);
    expect(calls).toEqual([U_MEETING]);
  });

  it('非会晤 → 返回 true 且实际写入', async () => {
    const { FGProfileWriteGateway } = await import(GW_PATH);
    const calls: string[] = [];
    const fgMock: any = {
      getUUIDByName: FG_STUB.getUUIDByName,
      updatePersonProfile: (name: string) => { calls.push(name); },
    };
    const gw = new FGProfileWriteGateway(() => fgMock, () => NO_MEETING);
    expect(gw.tryUpdateProfile(U_OTHER_EXISTING, { 'contact.workplace': 'X' })).toBe(true);
    expect(calls).toEqual([U_OTHER_EXISTING]);
  });
});

describe('[监管 C] 任意称呼归一 —— 全名/小名/昵称都必须归一到同一 UUID', () => {
  let tmpDir = '';
  let fg: any = null;

  beforeAll(async () => {
    if (!existsSync(FG_SRC)) return;
    tmpDir = mkdtempSync(join(tmpdir(), 'uuid-supervision-'));
    const copy = join(tmpDir, 'family_graph.db');
    copyFileSync(FG_SRC, copy);
    const { FamilyGraph } = await import(FG_PATH_MOD);
    fg = new FamilyGraph(copy);
    await fg.initialize();
  }, 90_000);

  afterAll(() => {
    try { fg?.close?.(); } catch { /* ignore */ }
    try { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('徐诗韵：全名 / 小名「诗韵」/ 昵称「韵韵」→ 同一 UUID', () => {
    if (!fg) return;
    const uuid = fg.getUUIDByName('徐诗韵');
    expect(uuid).toBe(U_MEETING_UUID);
    expect(fg.getUUIDByName('诗韵'), '小名必须归一到主名 UUID（通则红线①）').toBe(uuid);
    expect(fg.getUUIDByName('韵韵'), '昵称必须归一到主名 UUID（通则红线①）').toBe(uuid);
  });

  /**
   * ⚠️ 已知缺口（用 it.fails 固定，不掩盖也不污染测试结果）：
   *   王全芬(TXS-000000005) 的 nodes.aliases 仍为 [] —— 未经登记任何别名。
   *   这正是另一窗口 P2-2 报告声称「已注册 阿芬/全芬」（Fix 3）但**从未落地**的那一项。
   *   一旦有人真的补上别名，本用例会**反过来报错**（提醒移除 fails 标记）—— 即 fail-closed 地记录缺口。
   *   根因属「别名覆盖不足」：全仓 26 个 active 人物中仅 4 个有别名（15%），
   *   而 UUID 通则红线① 要求「任意称呼归一化」—— 数据侧尚未具备条件。
   */
  it.fails('王全芬：全名 / 「阿芬」/「全芬」→ 同一 UUID（当前为已知缺口）', () => {
    if (!fg) return;
    const uuid = fg.getUUIDByName('王全芬');
    expect(uuid).toBeTruthy();
    expect(fg.getUUIDByName('阿芬')).toBe(uuid);
    expect(fg.getUUIDByName('全芬')).toBe(uuid);
  });

  it('安琪：全名 / 「都灵」→ 同一 UUID', () => {
    if (!fg) return;
    const uuid = fg.getUUIDByName('安琪');
    expect(uuid).toBeTruthy();
    expect(fg.getUUIDByName('都灵')).toBe(uuid);
  });

  it('未登记称呼 → 返回空（不猜测、不误配）', () => {
    if (!fg) return;
    expect(fg.getUUIDByName('完全不存在的人')).toBeFalsy();
  });

  it('已 void 的实体不得再被解析（防已回收实体复活）', () => {
    if (!fg) return;
    // 2026-09-11 刚 void 的跨词边界垃圾
    expect(fg.getUUIDByName('习累'), 'void 实体不应可解析').toBeFalsy();
  });
});
