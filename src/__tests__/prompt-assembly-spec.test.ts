/**
 * Prompt 拼装规范（PAS v1）合规测试 — 法律法规执行机构
 * =====================================================
 * 依据：docs/prompt-assembly-spec-v1.md
 *
 * 本文件是规范 §7「第三级防线：测试守门」的实现。
 * 每个条款至少一个断言；🔴 阻断级条款失败即禁止合入。
 *
 * 条款分级（规范 §8）：
 *   🔴 阻断 = P-01 / P-02 / P-07 / P-11
 *   🟡 告警 = P-12 / P-13 / P-14 / P-15
 *   🟢 记录 = P-04 / P-17 / P-18
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

describe('[PAS v1] P-01 单一真源 — 核心铁律只允许一份定义', () => {
  it('🔴 L0 唯一真源（core-rules.ts）保留完整铁律与长度标准', async () => {
    const { buildReplyInstruction } = await import('../m5/prompts/core-rules.js');
    const core = buildReplyInstruction(false);
    expect(core).toContain('核心铁律');
    expect(core).toContain('回答长度标准');
    expect(core).toContain('口语化铁律');
  });

  it('🔴 补充层（cortex/rules.ts）不得重复定义长度标准/铁律/口语化', async () => {
    const { RULES_FRAGMENTS } = await import('../engine/cortex/prompts/rules.js');
    const cortex = RULES_FRAGMENTS.map(f => f.content).join('\n');
    // 与 L0 重复的主题必须已移除
    expect(cortex).not.toContain('回答长度标准');
    expect(cortex).not.toContain('核心铁律');
    expect(cortex).not.toContain('口语化铁律');
    expect(cortex).not.toContain('绝对禁止内心独白');
  });

  it('🔴 不得存在两套互相冲突的长度数字（旧冲突标准 300-500 字已清除）', async () => {
    const { RULES_FRAGMENTS } = await import('../engine/cortex/prompts/rules.js');
    const { buildReplyInstruction } = await import('../m5/prompts/core-rules.js');
    const cortex = RULES_FRAGMENTS.map(f => f.content).join('\n');
    const core = buildReplyInstruction(false);
    // 旧版冲突值只许出现在 L0 单一真源之外的地方
    expect(cortex).not.toContain('300-500字');
    // 同一 prompt 内不得出现两个不同的长度档位表
    const lengthTables = [core.includes('15-35字'), core.includes('30-80字')].filter(Boolean);
    expect(lengthTables.length).toBe(1);
  });

  it('🔴 长度规格只允许出现在 L0 白名单（全仓关键 prompt 源扫描）', () => {
    // 口径：扫描所有会进入 LLM prompt 的源文件，**排除注释行**；
    //       任何「NN-NN字 / NN字」长度规格只许出现在 L0 真源。
    //       这是对 P-01 的行为级执行（而非只对比两个文件）——能真正检出 live 冲突。
    const PROMPT_SOURCES = [
      'src/m5/prompts/core-rules.ts',            // L0 真源（唯一白名单）
      'src/engine/cortex/prompts/rules.ts',      // 补充层
      'src/engine/cortex/prompts/personality.ts',
      'src/webui/chat.ts',
      'src/webui/chat/guard-builder.ts',
      'src/m5/expression/ExpressionSpecController.ts',
      'src/app/role/RoleProfiles.ts',
    ];
    const L0_WHITELIST = new Set(['src/m5/prompts/core-rules.ts']);
    const violations: string[] = [];
    for (const f of PROMPT_SOURCES) {
      read(f).split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // 跳过注释行
        const hits = line.match(/[0-9]{2,3}\s*字/g);
        if (hits && !L0_WHITELIST.has(f)) {
          violations.push(`${f}:${i + 1} ${[...new Set(hits)].join(',')}`);
        }
      });
    }
    expect(violations, '长度规格必须只来自 L0：\n' + violations.join('\n')).toEqual([]);
  });

  it('🟢 补充层只保留 L0 未覆盖的内容（应有反编造/亲密基调）', async () => {
    const { RULES_FRAGMENTS } = await import('../engine/cortex/prompts/rules.js');
    const ids = RULES_FRAGMENTS.map(f => f.id);
    expect(ids).toContain('rules-anti-hallucination');
    expect(ids).toContain('rules-intimacy-tone');
    // 片段数应显著减少（原 5 段 → 现 ≤3 段）
    expect(RULES_FRAGMENTS.length).toBeLessThanOrEqual(3);
  });
});

describe('[PAS v1] P-12 截断必须按优先级（而非到达顺序）', () => {
  it('🟡 超预算时保留高 priority 段、丢弃低 priority 段', async () => {
    const { PromptAssembler, hardRule, memoryBlock } = await import('../m5/prompts/PromptAssembler.js');
    const a = new PromptAssembler();
    // 先加低优先级（若按到达顺序截断，它会被保留 → 测试失败）
    a.add(memoryBlock('low_prio', 'L'.repeat(500), ['normal', 'entity_meeting'], 100));
    a.add(hardRule('high_prio', 'H'.repeat(500), ['normal', 'entity_meeting'], 1000));
    const r = a.render({ mode: 'normal', maxChars: 600 });
    expect(r.blocks.some(b => b.id === 'high_prio')).toBe(true);
    expect(r.dropped.some(d => d.block.id === 'low_prio')).toBe(true);
  });

  it('🟡 渲染结果按 priority DESC 排序', async () => {
    const { PromptAssembler, safetyBlock, knowledgeBlock } = await import('../m5/prompts/PromptAssembler.js');
    const a = new PromptAssembler();
    a.add(knowledgeBlock('kb', 'kb-content', ['normal', 'entity_meeting'], 400));
    a.add(safetyBlock('sf', 'safety-content', ['normal', 'entity_meeting'], 900));
    const r = a.render({ mode: 'normal', maxChars: 10000 });
    expect(r.blocks[0].id).toBe('sf'); // safety(900) 先于 knowledge(400)
  });
});

describe('[PAS v1] P-13 截断必须记录且可追责', () => {
  it('🟡 dropped 必须带 block id 与 reason（不能只报数量）', async () => {
    const { PromptAssembler, memoryBlock } = await import('../m5/prompts/PromptAssembler.js');
    const a = new PromptAssembler();
    a.add(memoryBlock('oversized', 'X'.repeat(2000), ['normal', 'entity_meeting'], 100));
    const r = a.render({ mode: 'normal', maxChars: 500 });
    expect(r.dropped.length).toBeGreaterThan(0);
    expect(r.dropped[0].block.id).toBe('oversized');
    expect(r.dropped[0].reason).toBeTruthy();
    expect(r.dropped[0].reason).toMatch(/超过字符上限/);
  });

  it('🟡 chat.ts 必须在 dropped 非空时输出可追责告警', () => {
    const src = read('src/webui/chat.ts');
    expect(src).toContain('PromptAssembler⚠P-13');
  });
});

describe('[PAS v1] P-15 拼装必须可观测（字符分层 + 耗时）', () => {
  it('🟡 Provider 侧输出 [PromptBudget] 分层字符数', () => {
    const src = read('src/m5/DeepSeekLLMProvider.ts');
    expect(src).toContain('[PromptBudget]');
    expect(src).toContain('L0=');
    expect(src).toContain('L1=');
    expect(src).toContain('L2=');
  });

  it('🟡 chat.ts 侧输出拼装耗时 assemble_ms', () => {
    const src = read('src/webui/chat.ts');
    expect(src).toContain('assemble_ms=');
    expect(src).toContain('_tAssembleStart');
  });
});

describe('[PAS v1] P-11 模式隔离（批1 已达标，此处锁定防回归）', () => {
  it('🔴 会晤模式出口清洗器存在且带安全回退', async () => {
    const { sanitizeMeetingPrompt } = await import('../webui/chat/prompt-sanitizer.js');
    // 全污染 → 必须回退而不是清空
    const r = sanitizeMeetingPrompt('你是玉瑶 · 灵魂伴侣，鸿艺的私人秘书兼情人，18岁。');
    expect(r.reverted).toBe(true);
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('🔴 会晤模式 recaller 角色prompt 不含玉瑶身份标记', async () => {
    const { buildRoleSystemPrompt } = await import('../app/role/RoleProfiles.js');
    const p = buildRoleSystemPrompt('recaller', 0, undefined, true);
    expect(p.includes('玉瑶')).toBe(false);
  });
});

describe('[PAS v1] P-16 / P-11 出口断言存在于主链路', () => {
  it('🔴 chat.ts 在 orchestrate 之前执行会晤身份清洗', () => {
    const src = read('src/webui/chat.ts');
    const cleanIdx = src.indexOf('sanitizeMeetingPrompt(finalKnowledgeText)');
    const orchIdx = src.indexOf('ctx.m5.orchestrate(');
    expect(cleanIdx).toBeGreaterThan(-1);
    expect(orchIdx).toBeGreaterThan(-1);
    expect(cleanIdx).toBeLessThan(orchIdx); // 清洗必须在调用 LLM 之前
  });
});

describe('[PAS v1] P-10 L0 必须最前，L2 参考背景最后', () => {
  it('🔴 buildSystemPrompt 把 knowledge 放在最末（kb 不得前置）', async () => {
    const { buildSystemPrompt } = await import('../m5/prompts/core-rules.js');
    const kb = '【KB-MARKER】实体档案内容';
    const sp = buildSystemPrompt('2026-01-01 12:00', '【ROLE-MARKER】角色定义', false, kb);
    const roleIdx = sp.indexOf('【ROLE-MARKER】');
    const kbIdx = sp.indexOf('【KB-MARKER】');
    expect(roleIdx).toBeGreaterThan(-1);
    expect(kbIdx).toBeGreaterThan(-1);
    // L0（角色/铁律/身份）必须先于 L2（kb）
    expect(roleIdx).toBeLessThan(kbIdx);
    expect(sp.indexOf('核心铁律')).toBeLessThan(kbIdx);
  });

  it('🔴 buildRoleSystemPrompt 不再前置拼接 knowledge', async () => {
    const { buildRoleSystemPrompt } = await import('../app/role/RoleProfiles.js');
    const kb = '【KB-MARKER】实体档案';
    const p = buildRoleSystemPrompt('recaller', 0, kb, true);
    expect(p.includes('【KB-MARKER】')).toBe(false); // role prompt 不得含 kb
  });
});

describe('[PAS v1] P-02 对话历史注入上限与截断', () => {
  it('🔴 历史注入上限为 20 条（原 200）', () => {
    const src = read('src/m5/DeepSeekLLMProvider.ts');
    expect(src).toContain('HISTORY_INJECT_CAP = 20');
    expect(src).toMatch(/Math\.min\(MAX_HISTORY_TURNS,\s*HISTORY_INJECT_CAP\)/);
  });

  it('🔴 单条截断必须保留末条（守卫块）且必须告警（P-13）', () => {
    const src = read('src/m5/DeepSeekLLMProvider.ts');
    // 守卫块是 history 末条的 assistant 伪轮，截断它会让 7~10 条运行时守卫静默消失
    expect(src).toContain('_isLast');
    expect(src).toContain('!\_isLast &&');
    expect(src).toContain('P-13] 历史注入截断');
  });
});

describe('[PAS v1] P-05 全模式保底：角色扮演路径（DEAD 标记）', () => {
  it('🟢 角色扮演分支必须显式标记为 DEAD 且注明待补 L0 方案', () => {
    const src = read('src/m5/DeepSeekLLMProvider.ts');
    const rpIdx = src.indexOf("kb.startsWith('【角色扮演】')");
    expect(rpIdx).toBeGreaterThan(-1);
    const after = src.substring(rpIdx, rpIdx + 2500);
    // 批4 独立评审：该路径无生产者（死路径）+ buildReplyInstruction(true) 语义不匹配
    //   → 不强加会晤态 L0，但必须留下 DEAD 标记与启用方案，避免 P-05 被遗忘
    expect(after).toContain('DEAD-PATH');
  });

  it('🟡 角色扮演路径必须有预算埋点（P-15）', () => {
    const src = read('src/m5/DeepSeekLLMProvider.ts');
    expect(src).toContain("rp_path=1");
  });
});

describe('[PAS v1] P-15 分段耗时埋点', () => {
  it('🟡 chat.ts 必须在关键阶段打点（回答"慢在哪"）', () => {
    const src = read('src/webui/chat.ts');
    expect(src).toContain('_markStage');
    expect(src).toContain("markStage('retrieval')");
    expect(src).toContain("markStage('m4')");
    expect(src).toContain('stage_ms:');
  });
});

describe('[PAS v1] P-10 L0 预算（规范 §3）', () => {
  // 📌 口径修正（V27批4，独立评审 P1-2）：L0 上限必须**分项**——
  //   `[PromptBudget]` 的 L0 = systemPrompt.length - kbLen，**含 role prompt**。
  //   只测 secretary（302 字符）会得到“假绿”：lover level=1/2 的 role prompt
  //   为 1831/2335 字符（CORE_PERSONA + FIVE_PROTOCOLS + buildLevelInstruction），
  //   实测 L0 总可达 4269，远超单一 2200 阈值。
  it('🟡 L0 核心（铁律+身份+时间，不含 role）≤ 2000 字符', async () => {
    const { buildSystemPrompt } = await import('../m5/prompts/core-rules.js');
    const core = buildSystemPrompt('2026-09-19 14:00', '', false, '');
    console.log(`[L0 预算看板] L0核心 = ${core.length}（上限 2000）`);
    expect(core.length).toBeLessThanOrEqual(2000);
  });

  it('🟡 role prompt ≤ 2500 字符（含最重的 lover level=2）', async () => {
    const { buildRoleSystemPrompt } = await import('../app/role/RoleProfiles.js');
    for (const [r, lv] of [['secretary', 0], ['lover', 2], ['recaller', 0]] as Array<[any, any]>) {
      const rp = buildRoleSystemPrompt(r, lv);
      expect(rp.length, `role=${r} level=${lv}`).toBeLessThanOrEqual(2500);
    }
  });
});

describe('[PAS v1] P-17 注入点清单必须登记且与代码一致', () => {
  it('🟢 规范 §6 登记的注入点，其关键标识在代码中确实存在', () => {
    const spec = read('docs/prompt-assembly-spec-v1.md');
    const source = read('src/webui/chat.ts') + '\n' + read('src/m5/DeepSeekLLMProvider.ts') + '\n' + read('src/m5/prompts/core-rules.ts');
    // 从 §6 表格解析 inj-xx 行（不是只查几个字符串）
    const injRows = spec.split('\n').filter(l => /^\|\s*inj-\d+/.test(l));
    expect(injRows.length).toBeGreaterThan(5);
    // 关键注入点 ↔ 代码标识映射：未登记或代码改名都会失败
    const markers: Array<[string, string]> = [
      ['inj-02', 'buildRoleSystemPrompt'],   // 身份从句（role prompt 通道）
      ['inj-03', 'buildReplyInstruction'],   // 核心铁律 L0 真源
      ['inj-05', 'factual_recall'],          // 事实守卫
      ['inj-07', 'memory_context'],          // 记忆块
      ['inj-10', 'pfc_system_prompt'],       // PFC 上下文
    ];
    for (const [id, marker] of markers) {
      expect(injRows.some(r => r.includes(id)), `§6 清单缺少 ${id}`).toBe(true);
      expect(source.includes(marker), `${id} 的代码标识 ${marker} 不存在`).toBe(true);
    }
  });

  it('🟢 规范必须反映 P-01 收口后的真实状态（不得停在旧的"双份定义"）', () => {
    const spec = read('docs/prompt-assembly-spec-v1.md');
    expect(spec).toContain('rules-intimacy-tone');     // 补充层新片段已登记
    expect(spec).toContain('已收口');                    // 收口记录存在
  });
});

describe('[PAS v1] P-18 禁止裸拼接注入（技术债看板，只许减少不许增长）', () => {
  // 📌 口径（2026-09-19 V27批2 建制，独立评审修正）：
  //   统计 `finalKnowledgeText` 作为左值的**所有写入语句**（含折行三元 / .join() / +=），
  //   用行首匹配而非行内 `=`+`+` —— 原正则漏计折行与 join 形态（如 PFC payload 拼接）。
  //   基线（建制时）：24 处。批3（P-10/P-02/P-04）目标：逐批收口到装配器，本基线只降不升。
  const BASELINE = 24;

  const countNakedWrites = (src: string): number =>
    src.split('\n').filter(l => /^\s*finalKnowledgeText\s*(\+?=)/.test(l)).length;

  it('🟢 裸拼接注入点数量不得超过基线', () => {
    const total = countNakedWrites(read('src/webui/chat.ts'));
    console.log(`[P-18 技术债看板] chat.ts 裸拼接写入语句 = ${total}（基线 ${BASELINE}）`);
    expect(total).toBeLessThanOrEqual(BASELINE);
  });

  it('🟢 已收口的注入点必须保持守卫（PFC 旧链路）', () => {
    const src = read('src/webui/chat.ts');
    // 批1 收口：PFC 旧链路必须仍在模式守卫内，不得退化为无守卫注入
    expect(src).toContain('if (!PROMPT_ASSEMBLER_STRICT && !_meetingEntityName) {');
    // 出口身份清洗必须在调用 LLM 之前（P-16）
    expect(src).toContain('sanitizeMeetingPrompt(finalKnowledgeText)');
  });
});

describe('P-01（批17 补）· 长度标准单一真源 —— 全仓不得再有第二套硬编码字数', () => {
  const fsx = require('node:fs');
  const { join } = require('node:path');
  const repo = join(__dirname, '..', '..');

  const PROMPT_DIRS = ['src/engine/cortex/prompts', 'src/app/role', 'src/m5/prompts'];

  // 与 L0 冲突的硬编码字数（L0 说话纪律是唯一真源）
  const CONFLICTING = [new RegExp('（300-500字）'), new RegExp('10-30字为宜'), new RegExp('300-500' + '\\s*字')];

  /** 真源文件：字数标准的法定定义处，本来就该出现字数 —— 不在巡查范围 */
  const SOURCE_OF_TRUTH = new Set(['core-rules.ts', 'rules.ts', 'personality.ts']);

  it('🔴 提示词目录内不得出现与 L0 冲突的硬编码长度标准', () => {
    const offenders = [];
    for (const dir of PROMPT_DIRS) {
      const abs = join(repo, dir);
      if (!fsx.existsSync(abs)) continue;
      for (const f of fsx.readdirSync(abs)) {
        if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
        if (SOURCE_OF_TRUTH.has(f)) continue;   // ← 跳过真源
        const content = fsx.readFileSync(join(abs, f), 'utf8');
        for (const re of CONFLICTING) {
          if (re.test(content)) offenders.push(dir + '/' + f);
        }
      }
    }
    expect(offenders, '发现第二套长度标准（应改为引用 L0）: ' + offenders.join(',')).toEqual([]);
  });

  it('原冲突文件已改为「遵循 L0」引用（且功能未删）', () => {
    const is = fsx.readFileSync(join(repo, 'src/engine/cortex/prompts/intimate-scenes.ts'), 'utf8');
    const cm = fsx.readFileSync(join(repo, 'src/engine/cortex/prompts/communication-mode.ts'), 'utf8');
    expect(is, '亲密场景片段应引用 L0').toContain('遵循 L0 说话纪律');
    expect(cm, '通信模式片段应引用 L0').toContain('遵循 L0 说话纪律');
    expect(is, '功能必须保留（不是删掉了事）').toContain('export function buildIntimateFragments');
    expect(cm, '功能必须保留').toContain('export function buildCommunicationFragments');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// V28 回话方式引导 — 表现层边界锁定
// 依据：docs/V28-回话方式引导-变更说明.md
// 本段锁的是作者在 S2 明确划定的边界（不是美学偏好），越界即回归。
// ─────────────────────────────────────────────────────────────────────────────
describe('[V28] 回话方式引导 — 表现层边界（S2 明确定界）', () => {
  const BLOCK_RE = /personaBlock\('speech_style',\s*SPEECH_STYLE_GUIDE,\s*\[([^\]]*)\]/;

  it('🔴 块已注册，且 modeScope 显式含 entity_meeting', () => {
    const src = read('src/webui/chat.ts');
    const m = src.match(BLOCK_RE);
    expect(m, 'speech_style 块必须存在').not.toBeNull();
    const modes = m![1];
    expect(modes, 'normal 是日常对话的渲染模式，必含').toContain("'normal'");
    // personaBlock 的默认 modeScope 只有 ['normal'] —— 漏写 entity_meeting 会在会晤模式静默失效
    expect(modes, '会晤模式必须显式加入，否则静默不生效').toContain("'entity_meeting'");
  });

  it('🔴 块注册先于 assembler.render（否则不进本次拼装）', () => {
    const src = read('src/webui/chat.ts');
    const addIdx = src.search(/personaBlock\('speech_style'/);
    const renderIdx = src.indexOf('assembler.render({ mode: _mode');
    expect(addIdx).toBeGreaterThan(-1);
    expect(renderIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeLessThan(renderIdx);
  });

  it('🔴 渲染侧 mode 只有 normal / entity_meeting —— 其余取值在 modeScope 中不生效', () => {
    const src = read('src/webui/chat.ts');
    // chat.ts 唯一的 render 调用点；mode 由下方三元式决定，全仓没有任何一处把 mode 设为
    // 'roleplay'（0 命中）。因此把 'roleplay' 写进 modeScope 不产生行为变化，只会制造
    // 「已覆盖角色扮演」的假象。该断言把渲染侧事实钉死，防止误改或误加死配置。
    expect(src).toContain("const _mode = _isMeeting ? 'entity_meeting' as const : 'normal' as const;");
    expect(src).toMatch(/assembler\.render\(\{\s*mode:\s*_mode/);
  });

  it('🔴 引导文案不列词表（不得出现语气词/叹词枚举）', () => {
    const src = read('src/webui/chat.ts');
    const g = src.match(/const SPEECH_STYLE_GUIDE = \[([\s\S]*?)\]\.join/);
    expect(g, 'SPEECH_STYLE_GUIDE 必须存在').not.toBeNull();
    const text = g![1];
    // S2 边界：只描述「真人说话是什么样」，不把语气词喂给 LLM。
    const PARTICLES = ['嗯', '啊', '呀', '哦', '呢', '吧', '啦', '嘛', '噢', '嘿', '哈', '唉', '哟'];
    const hit = PARTICLES.filter(p => text.includes(p));
    expect(hit, '引导文案出现语气词/叹词枚举: ' + hit.join(' ')).toEqual([]);
  });

  it('🔴 不做后处理贴词 — 引导只经装配器进入提示词', () => {
    const src = read('src/webui/chat.ts');
    // S2 边界：ThinkingPauseInjector 之类的「输出侧贴词」思路明确不采用。
    expect(src).not.toMatch(/ThinkingPauseInjector\s*\(/);
    expect(src, 'speech_style 必须经 assembler.add 注册').toMatch(BLOCK_RE);
  });
});

describe('[V34] 记忆块定性 — 必须与「记忆即事实」铁律同向（2026-09-25）', () => {
  // 背景：chat.ts 给记忆块加的包装语原写「你**现在不在那些场景里**」「**绝对不要从记忆里的场景开始说话**」，
  //      而 EntityContextBuilder 的 entity_memory_fact 铁律写「记忆即事实…必须正面回应，不能否认、不能回避」。
  //      两段提示词在同一轮上下文里互否，模型倾向采信更晚/更具体的否定句
  //      ⇒ 实测角色记不住最近几天聊过的事（业主验收样本：25 日晚三人飞杭州）。
  // 边界：只锁「事实层不得被否定」，**不锁具体措辞** —— 表达层（不要重演过去场景）必须原样保留，
  //      且与 memoryGuard 的「没有的就是没有，诚实说没有记录」相容（记录内 / 记录外分流）。
  const CHAT = 'src/webui/chat.ts';

  it('🔴 记忆块不得否定记忆的事实性', () => {
    expect(read(CHAT), '「你现在不在那些场景里」是事实层否定，与 entity_memory_fact 互否')
      .not.toContain('你现在不在那些场景里');
  });

  it('🔴 记忆块必须正面声明「是事实」并要求照实答', () => {
    const src = read(CHAT);
    expect(src, '必须正面声明记忆内容是事实').toContain('它们是事实');
    expect(src, '必须明确禁止用「不记得/没印象」回避记录内已有的内容')
      .toMatch(/不记得[\s\S]{0,20}没印象/);
  });

  it('🔴 两条记忆注入路径必须同时修正（assembler + legacy）', () => {
    const n = read(CHAT).split('它们是事实').length - 1;
    expect(n, `chat.ts 中出现 ${n} 处，两条注入路径都必须修正（≥2）`).toBeGreaterThanOrEqual(2);
  });

  it('🔴 表达层边界必须保留 —— 不得因修事实性而放开重演过去场景', () => {
    expect(read(CHAT), '「不要重演当时的对话」是表达层边界，修事实性时不得连带删除')
      .toContain('不要重演当时的对话');
  });

  it('🔴 与 memoryGuard 禁编造相容：记录内 / 记录外分流', () => {
    expect(read(CHAT), '记录里没写到的，仍须诚实说「没有记录」—— 否则会放开编造')
      .toMatch(/没写到的[\s\S]{0,12}没有记录/);
  });
});
