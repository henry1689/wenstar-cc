/**
 * 状态源固化守卫（原 P072「切主」守卫，2026-10-31 第三层拆除后**反向重写**）
 *
 * 🔴 为什么用**源码断言**而非行为测试：
 *   `chat.ts` 是重量级模块（直接 import 会执行整套模块初始化，仓内惯例是不 import，
 *   见 meeting-prop-points.test.ts 的同款做法）。本次改动风险集中在「代码长什么样」——
 *   「旧路径有没有被删干净」「recordTurn 有没有偷偷又读回状态」这类问题
 *   tsc 抓不到、人工 review 也容易漏，只有断言能锁住。
 *
 * 🔴 2026-10-31 方向反转（第三层拆除）：
 *   旧版本文件锁的是「**回滚入口完整**：旧路径一行未删，关 `WS_GROUP_V2` 即回该路径」。
 *   开关与旧状态机现已彻底删除，那条断言守的恰恰是本次要清除的东西 —— 故整体反转：
 *   **旧路径必须不存在**，且不得被悄悄重新引入。
 *
 * 锁四件事：
 *   1. **状态只有一处写**：EntityMeeting 副作用层与 recordTurn 都不得读写 `_meeting`；
 *   2. **旧状态机彻底不存在**：enter/enterMulti/exit/switchTo/addParticipant/
 *      restoreLastMeeting/saveLastMeeting/setStorage 一个都不能有；
 *   3. **开关彻底不存在**：`WS_GROUP_V2` / `isGroupSessionEnabled` / `isEnabled` / `enabled` 选项；
 *   4. **写点确实都在 GroupSession**：WAKE / LEAVE / JOIN / SPEAK 四类 action 均 dispatch。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const chatSrc = readFileSync(join(HERE, '..', '..', '..', 'webui', 'chat.ts'), 'utf8');
const emSrc = readFileSync(join(HERE, '..', '..', '..', 'm4', 'household', 'EntityMeeting.ts'), 'utf8');
const gsSrc = readFileSync(join(HERE, '..', 'GroupSession.ts'), 'utf8');

/**
 * 提取某个方法的完整签名+方法体（按花括号配对）。
 *
 * 🔴 P078 修过的两个坑（方案 C 引入新形态后暴露）：
 *   1. **接口同名声明**：`MeetingSessionView` 接口里也有 `isActive(): boolean;`
 *      —— 若不跳过，会把接口声明误当方法体（断言全错）。判据：签名后第一个非空白字符是 `;`。
 *   2. **泛型里的花括号**：`participants?: Array<{ uuid: string; ... }>` 的 `{`
 *      —— 直接配对会在签名中途就"闭合"，方法体取不到。故先跟踪 `<>` 深度，泛型内部一律忽略。
 */
function methodBody(src: string, signature: string): string {
  let from = 0;
  for (;;) {
    const i = src.indexOf(signature, from);
    if (i < 0) return '';
    from = i + signature.length;
    // 跳过接口/类型别名里的声明（`xxx(): T;`）
    if (src.slice(from, from + 80).trimStart().startsWith(';')) continue;

    let angle = 0, depth = 0, started = false, j = i;
    for (; j < src.length; j++) {
      const c = src[j];
      if (angle > 0) { // 泛型内部：只跟踪嵌套，不碰花括号
        if (c === '<') angle++;
        else if (c === '>') angle--;
        continue;
      }
      if (c === '<') { angle++; continue; }
      if (c === '{') { depth++; started = true; }
      else if (c === '}') { depth--; if (started && depth === 0) break; }
    }
    if (started) return src.slice(i, j + 1);
  }
}

describe('[固化] 状态源单点', () => {
  it('🔴 EntityMeeting 的副作用层不得读写 this._meeting（硬约束②：状态只有一处写）', () => {
    for (const sig of ['beginMeetingSideEffects(', 'endMeetingSideEffects():', 'addSessionEntitySideEffect(']) {
      const body = methodBody(emSrc, sig);
      expect(body, `找不到副作用方法 ${sig}（副作用入口丢失）`).not.toBe('');
      expect(body, `${sig} 内不得触碰 this._meeting —— 状态归 GroupSession`).not.toContain('this._meeting');
    }
  });

  it('🔴 recordTurn 方法体内不得再读 this._meeting', () => {
    const body = methodBody(emSrc, 'recordTurn(role:');
    expect(body, '找不到 recordTurn').not.toBe('');
    expect(body, 'recordTurn 必须由调用方传入 isMulti/speakerName，不得再读状态字段').not.toContain('this._meeting');
    // A1 的四参签名
    expect(body, 'recordTurn 必须是四参签名（role, content, speakerName, isMulti）').toContain('isMulti: boolean');
    // 轮次累积与截断逻辑不得被顺手改掉
    expect(body, '_multiTurns 累积必须保留').toContain('_multiTurns.push');
    expect(body, '200 轮截断告警必须保留').toContain('200');
  });

  it('🔴 旧状态机必须彻底不存在（2026-10-31 第三层拆除）', () => {
    const gone = [
      ['enter(entityName: string', '单人进入'],
      ['enterMulti(entityNames: string[])', '多人进入'],
      ['async exit()', '退出（旧纪要路径）'],
      ['async switchTo(entityName: string)', '换主发言'],
      ['addParticipant(entityName: string)', '加人'],
      ['restoreLastMeeting(): boolean', '重启自动恢复（旧路径）'],
      ['saveLastMeeting()', '会晤实体持久化（旧路径）'],
      ['setStorage(', '旧持久化注入'],
    ] as const;
    for (const [sig, label] of gone) {
      expect(emSrc, `旧状态机方法仍存在：${label}（${sig}）—— 死灰复燃会重新引入第二状态源`)
        .not.toContain(`  ${sig}`);
    }
    // `_meeting` 字段本身也必须消失（含声明与赋值，注释里的历史说明不算）
    expect(emSrc, '`private _meeting` 字段不得存在').not.toMatch(/private\s+_meeting\s*:/);
  });

  it('🔴 四类状态写入都已 dispatch 到 GroupSession', () => {
    for (const act of ['WAKE', 'LEAVE', 'JOIN', 'SPEAK']) {
      expect(chatSrc, `chat.ts 缺少 dispatch({type:'${act}'}) —— 该状态写入未走唯一写入口`).toContain(`type: '${act}'`);
    }
  });

  it('🔴 旧路径调用必须彻底不存在（开关关闭分支已随第三层删除）', () => {
    /**
     * 🔴 只看**代码行**：注释里的历史说明（如「旧路径由 `_em.exit()` 内部同样打出」）
     *   不属于调用点，把它算违规会误伤「如实记录删除历史」的注释。
     *   判据：剔除行注释 //、块注释续行 *、空行后再匹配。
     */
    const codeOnly = (src: string) =>
      src
        .split('\n')
        .filter(l => {
          const t = l.trim();
          return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
        })
        .join('\n');
    const chatCode = codeOnly(chatSrc);

    const calls = [
      '_em.enterMulti(',
      '_em.enter(',
      '_em.exit()',
      '_em.addParticipant(',
      '_em.switchTo(',
      '_em.restoreLastMeeting',
    ];
    for (const c of calls) {
      expect(chatCode, `旧路径调用仍存在：${c} —— 二选一分叉未清干净`).not.toContain(c);
    }
    // 二选一判据本体也必须消失（同样只看代码行）
    expect(chatCode, '`_useGS` 二选一判据不得存在').not.toMatch(/\b_useGS\b/);
  });

  it('🔴 回滚开关必须彻底不存在（配置层不得再能退回旧实现）', () => {
    expect(chatSrc, 'chat.ts 不得引用 isGroupSessionEnabled').not.toContain('isGroupSessionEnabled');
    expect(gsSrc, 'GroupSession 不得再导出开关函数').not.toContain('isGroupSessionEnabled');
    expect(gsSrc, 'GroupSession 不得再导出开关常量').not.toContain('GROUP_SESSION_FLAG');
    expect(gsSrc, 'GroupSession 不得再有 isEnabled() 方法').not.toContain('isEnabled()');
    // 构造选项里的 `enabled` 也必须消失（否则开关会以另一种形态复活）
    expect(gsSrc, 'GroupSessionOptions 不得再有 enabled 字段').not.toMatch(/enabled\?:\s*boolean/);
  });

  it('🟢 汇聚点取值源 = GroupSession（下游 20 文件的源）', () => {
    expect(chatSrc, '汇聚点 _activeMeetingName 必须从前置状态派生').toContain('const _activeMeetingName = (() => {');
    expect(chatSrc, '汇聚点必须读 ctx._groupSession.getState()').toContain('const _st = ctx._groupSession.getState();');
  });

  it('🟢 投影已移除，且现场恢复订阅已前移到 GroupSession 创建点', () => {
    expect(chatSrc, 'projectMeetingState 不得再被调用（GroupSession 已是真源，再投影会用空状态覆盖）')
      .not.toMatch(/projectMeetingState\(/);
    expect(chatSrc, '现场恢复应由 onSlot 订阅承接').toContain('_groupSession.onSlot');
    expect(chatSrc, '现场恢复必须复原角色（修 P039 缺陷③，不再硬置 secretary）').toContain('applySlot(_slot)');
  });

  it('🟢 门卫/纪要走副作用入口而非状态方法', () => {
    expect(chatSrc, '进入会晤应调 beginMeetingSideEffects').toContain('beginMeetingSideEffects(');
    expect(chatSrc, '退出会晤应调 endMeetingSideEffects').toContain('endMeetingSideEffects()');
    expect(chatSrc, '加人应调 addSessionEntitySideEffect').toContain('addSessionEntitySideEffect(');
  });

  it('🟢 process-stages.ts 的 recordTurn 也已适配四参且不走开关', () => {
    const psSrc = readFileSync(join(HERE, '..', '..', '..', 'webui', 'chat', 'process-stages.ts'), 'utf8');
    expect(psSrc, 'process-stages 的 recordTurn 必须四参').toContain("recordTurn('user', message, '鸿艺', _multi2)");
    expect(psSrc, '其 isMulti 判定须直接读 GroupSession（开关已删除）').toContain('ctx._groupSession?.multi === true');
    expect(psSrc, '不得再引用已删的 isEnabled').not.toContain('isEnabled');
  });
});

/**
 * 🔴 P078 方案C（业主裁决 2026-10-23）——读侧失效的**结构性**守卫。
 *
 * 为什么必须锁：P073 的守卫只锁住了「写侧唯一」，没锁「读侧」⇒ 生产实测才抓到
 * 「切主只切写侧、读侧 10 处仍读空 `_em`」（P076）。
 * 这些问题 **tsc 抓不到、人工 review 也容易漏** —— 它们全是「读到的是空对象」这种静默错误。
 *
 * 锁两件事（第三层拆除后「回滚分支一字未删」一条已反转删除）：
 *   1. 状态读方法必须走视图（否则又会退化成读空）；
 *   2. 视图必须**纯读**（方法体内不得回写任何状态）。
 */
describe('[P078 方案C] EntityMeeting 状态读视图', () => {
  /** 必须走视图的状态读方法（少一个就是又一个静默失效点） */
  const VIEW_ROUTED = [
    'isActive(): boolean',
    'isMultiParty(): boolean',
    'getEntityName(): string | null',
    'getEntityUUID(): string | null',
    'getParticipants(): EntityInfo[]',
  ] as const;

  it('🔴 五个状态读方法必须经 _sessionView 转发（否则恒读空 ⇒ 进去了但系统以为没进）', () => {
    for (const sig of VIEW_ROUTED) {
      const body = methodBody(emSrc, sig);
      expect(body, `找不到状态读方法 ${sig}`).not.toBe('');
      expect(body, `${sig} 必须读 GroupSession 只读视图`).toContain('isAvailable()');
    }
    // 发言人推断同样依赖会晤态与名单，必须走本类读方法（视图可达）。
    // 🔴 单独用缩进锚点截取：`inferSpeaker` 的**参数表里就有对象类型**
    //   （`llm?: { rawCall?: ... }`），花括号配对器无论怎么修都会把它误当方法体起点。
    const _infStart = emSrc.indexOf('async inferSpeaker(');
    const _infEnd = _infStart >= 0 ? emSrc.indexOf('\n  }', _infStart) : -1;
    const infer = _infStart >= 0 && _infEnd > _infStart ? emSrc.slice(_infStart, _infEnd + 4) : '';
    expect(infer, 'inferSpeaker 必须走本类读方法（视图可达）而非直读状态字段')
      .toContain('this.isMultiParty()');
    expect(infer, 'inferSpeaker 名单必须走 getParticipants()（视图可达）')
      .toContain('this.getParticipants()');
  });

  it('🔴 视图必须是纯读：状态读方法体内不得回写任何状态（硬约束②）', () => {
    for (const sig of VIEW_ROUTED) {
      const body = methodBody(emSrc, sig);
      expect(body, `${sig} 内不得写状态 —— 写侧唯一归 GroupSession.reduce`)
        .not.toMatch(/this\._meeting\s*=[^=]/);
    }
  });

  it('🔴 纪要素材采集：beginMeetingSideEffects 必须维护 _multiParticipants/_multiMeetingName（否则纪要永不生成）', () => {
    const begin = methodBody(emSrc, 'beginMeetingSideEffects(name:');
    expect(begin, '找不到 beginMeetingSideEffects').not.toBe('');
    expect(begin, '纪要素材名单必须在会晤开始时采集').toContain('this._multiParticipants =');
    expect(begin, '会议名必须在会晤开始时采集（否则纪要名为空）').toContain('this._multiMeetingName =');
    expect(begin, '必须支持完整 seed（含 name）').toContain('participants?:');
    // 纪要条件仍是 participants>=3：单人登记不会误生成
    expect(emSrc, '纪要门槛不得放宽').toContain('_multiParticipants.length >= 3');
    const add = methodBody(emSrc, 'addSessionEntitySideEffect(uuid:');
    expect(add, '加人必须补进纪要素材名单').toContain('this._multiParticipants.push');
  });

  /**
   * 🔴 S4 独立评审抓到的核心时序：**接线早 ≠ 可用**。
   *   上一轮守卫只比对了 `FGProfileWriteGateway` 与实体上下文块，**正好跳过了创建点** ⇒
   *   测试全绿却放行不了：`isAvailable()` 依赖 `ctx._groupSession`，而 `ctx` 每帧新建、
   *   创建点在其后 ⇒ 空窗内 9 个读点仍读空。
   *   故本例锁的是**相对顺序**，而非单纯"接线点在某处之前"。
   */
  it('🔴 时序：创建 → 接线 → 首个读点（接线早≠可用，锁相对顺序）', () => {
    const createIdx = chatSrc.indexOf('ctx._groupSession = new GroupSession(');
    const wireIdx = chatSrc.indexOf('setSessionView({');
    const firstReadIdx = chatSrc.indexOf('runChatEntry(message');
    expect(createIdx, '找不到 GroupSession 创建点').toBeGreaterThan(-1);
    expect(wireIdx, '找不到 setSessionView 接线点').toBeGreaterThan(-1);

    expect(createIdx, '🔴 创建点必须早于接线点 —— 否则本帧 isAvailable() 恒 false（S4 评审抓到的缺陷）')
      .toBeLessThan(wireIdx);
    expect(wireIdx, '🔴 接线点必须早于首个读点 runChatEntry —— 否则本帧读到空视图')
      .toBeLessThan(firstReadIdx);

    // 这两处是上轮**测试全绿却失效**的实例：判据都以 ctx._groupSession 为闸门
    expect(createIdx, '🔴 recordTurn 判据必须在创建点之后 —— 否则用户轮次全丢、纪要只含 AI 回复')
      .toBeLessThan(chatSrc.indexOf('const _rtMulti = ctx._groupSession?.multi === true;'));
    expect(createIdx, '🔴 汇聚点 _activeMeetingName 必须在创建点之后 —— 否则恒 null 致召回/身份分叉')
      .toBeLessThan(chatSrc.indexOf('const _activeMeetingName = (() => {'));
  });

  /**
   * 行为级断言：源码文本比对锁不住"读方法到底读到了什么"。
   * 这里直接给视图喂值，断言读方法按 GroupSession 取值；去视图后必须**fail-closed**
   * （返回「无会晤」而不是回退到某个本地状态 —— 本地状态已经不存在了）。
   */
  it('🟢 行为级：带视图时按 GroupSession 取值，去视图即 fail-closed（无会晤）', async () => {
    const { EntityMeeting } = await import('../../../m4/household/EntityMeeting.js');
    const em: any = new (EntityMeeting as any)({} as any);

    em.setSessionView({
      isAvailable: () => true,
      isActive: () => true,
      isMulti: () => true,
      getSpeakerUuid: () => 'uuid-xsy',
      getParticipants: () => [{ uuid: 'uuid-xsy', name: '徐诗雨', category: 'person' }],
    });
    expect(em.isActive(), 'isActive 必须读视图').toBe(true);
    expect(em.isMultiParty(), 'isMultiParty 必须读视图').toBe(true);
    expect(em.getEntityName(), 'getEntityName 必须由 speakerUuid 派生（与汇聚点同规则）').toBe('徐诗雨');
    expect(em.getEntityUUID(), 'getEntityUUID 必须返回 speakerUuid —— KB UUID 门（I007）源头').toBe('uuid-xsy');
    expect(em.getParticipants().map((p: any) => p.name), '名单必须来自视图').toEqual(['徐诗雨']);

    // 🔴 去视图 ⇒ fail-closed。旧实现此时会回退 `_meeting`（第二状态源）；
    //   第三层拆除后该字段不存在，读方法只能返回「无会晤」。
    em.setSessionView(null);
    expect(em.isActive(), '去视图即无会晤（fail-closed）').toBe(false);
    expect(em.isMultiParty()).toBe(false);
    expect(em.getEntityName()).toBeNull();
    expect(em.getEntityUUID()).toBeNull();
    expect(em.getParticipants()).toEqual([]);
  });
});