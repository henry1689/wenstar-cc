/**
 * ChatEntry.ts — 入口守卫管线
 *
 * 从 chat.ts L435-574 拆出
 * 处理: DNA编码 | 实体提取 | 图谱匹配
 *
 * V4.0: 移除角色扮演检测（实体会晤替代）
 */
import type { ChatContext } from '../chat.js';
import { getRetrievalFusionConfig } from '../../config/retrieval-fusion-config.js';
import { ENABLE_TEMPORAL_RULE_ENGINE, worldRuleMode } from '../../engine/temporal/TemporalConfig.js';
import { fetchWeatherNow, fetchForecast3d, cityLookup, isApiAvailable } from '../../engine/temporal/weather_qweather_client.js';

/** 入口管线可变状态 */
export interface EntryState {
  _currentRole: string;
}

export interface EntryResult {
  dna: any;
  ruleEngineBlocked: boolean;
  ruleEngineReply: string;
  /** 天气查询结果（主动问天气时填充，供 LLM 上下文注入） */
  weatherContext: string;
}

export async function runChatEntry(
  message: string,
  ctx: ChatContext,
  state: EntryState,
): Promise<EntryResult> {
  // 🆕 P1: 惰性初始化 L3 FG 人名库（含别名映射），幂等只执行一次
  try {
    await ctx.encoder.initFg?.();
  } catch { /* 初始化失败不阻塞对话 */ }
  const dna = ctx.encoder.encodeSingle(message);

  // 时空规则引擎
  let ruleEngineBlocked = false;
  let ruleEngineReply = '';
  let weatherContext = '';
  if (ENABLE_TEMPORAL_RULE_ENGINE) {
    try {
      const { NLPEventExtractor } = await import('../../engine/temporal/NLPEventExtractor.js');
      const { TemporalEventArchive } = await import('../../engine/temporal/TemporalEventArchive.js');
      const { recordEventViolation } = await import('../../engine/temporal/temporal_event_hook.js');
      const engineCtx = ctx.storage?.getSQLite?.();
      const archive = engineCtx ? new TemporalEventArchive(engineCtx) : null;
      const extracted = NLPEventExtractor.extract(message, '鸿艺');
      if (extracted) {
        // 时序事件校验
        if (extracted.type === 'temporal_event' && archive && worldRuleMode === 'realistic') {
          const { params } = extracted;
          if (/怀孕|生孩子|分娩|妊娠|生宝宝/.test(message) || /感冒|发烧|受伤|恢复/.test(message)) {
            const check = archive.checkEventCompliance(message, params.durationMs);
            if (!check.valid) {
              recordEventViolation(ctx.storage?.getSQLite?.(), message, check.reason || '');
              ruleEngineBlocked = true;
              ruleEngineReply = check.reason || '';
            }
          }
          if (!ruleEngineBlocked) {
            archive.createEvent({
              belongEntityId: '鸿艺', eventType: params.eventType,
              eventRawText: extracted.content,
              startTs: params.startTs, endTs: params.endTs,
              cycleMs: params.cycleMs, dnaRootId: dna.dna_root_id || 'unknown',
            });
          }
        }

        // 天气查询：用户主动问天气 → 调API
        if (extracted.type === 'weather_query' && isApiAvailable()) {
          try {
            const { params } = extracted;
            let cityName = params.targetCity || '深圳龙岗';
            let locationId: string | undefined;
            if (params.targetCity) {
              const loc = await cityLookup(params.targetCity);
              locationId = loc?.id;
              if (loc) cityName = loc.name;
            }
            const forecastData = await fetchForecast3d();
            const currentData = await fetchWeatherNow();
            let weatherText = `📡 ${cityName}当前天气：${currentData?.text || '暂无数据'}，体感${currentData?.feelsLike ?? '-'}°C。`;
            if (forecastData?.forecast?.length) {
              const days = forecastData.forecast.map((d: any, i: number) => {
                const labels = ['今天', '明天', '后天'];
                return `${labels[i] || '第'+(i+1)+'天'}：${d.text}`;
              }).join('；');
              weatherText += ` 预报：${days}`;
            }
            if (params.isFutureQuery) {
              weatherText += ' （注：和风免费版仅提供3天预报，下周天气暂不可查）';
            }
            weatherContext = weatherText;
            console.log('[WeatherQuery] ' + weatherText.substring(0, 80));
          } catch (_w) { /* 天气查询不阻塞主流程 */ }
        }

        // 出行+天气：用户说去XX → 查当地天气
        if (extracted.type === 'location_switch_weather' && isApiAvailable()) {
          try {
            const city = extracted.params.city;
            const loc = await cityLookup(city);
            if (loc) {
              const forecastData = await fetchForecast3d();
              const currentData = await fetchWeatherNow();
              let weatherText = `📡 ${loc.name}当前天气：${currentData?.text || '暂无数据'}，体感${currentData?.feelsLike ?? '-'}°C。`;
              if (forecastData?.forecast?.length) {
                weatherText += ` 未来3天：${forecastData.forecast.map((d: any) => d.text).join('；')}`;
              }
              weatherContext = weatherText;
            } else {
              weatherContext = `未查到"${city}"的天气数据（城市名可能不在和风数据库范围内）`;
            }
            console.log('[TripWeather] ' + weatherContext.substring(0, 80));
          } catch (_w) { /* 天气查询不阻塞主流程 */ }
        }
      }
    } catch (_err) { /* 规则引擎不阻塞主流程 */ }
  }

  // 🔴 2026-11-08 批2（ADR-020）：独立 LLM 实体提取已**物理退场**。
  //   取证由主回复调用一次性完成（entity: 名称|类型|证据原文 + 原文证据硬校验），
  //   准入结果在 chat.ts 回复后写回 dna.entity_genes。
  //   此处不再有任何「看起来像人名就入库」的来源 —— 唯一的确定性匹配是下面的
  //   「已登记人名精确匹配」，它只读 FG 名单，不新增实体。

  // 家族图谱兜底
  try {
    const _hp = dna.entity_genes.some((g: any) => g.type === "person" && g.name !== "我" && g.name.length > 1);
    if (!_hp && ctx.m4) {
      const _fg = ctx.m4.getFamilyGraph();
      if (_fg) {
        for (const _n of _fg.getAllPersonNames()) {
          if (_n !== "我" && _n.length > 1 && message.includes(_n)) {
            dna.entity_genes.push({ name: _n, type: "person", allele: _n, phenotype: "neutral", knowledge_type: "private" });
            console.log("[FamilyGraph] 图谱匹配: " + _n);
          }
        }
      }
    }
  } catch (_fe) { console.warn("[FamilyGraph] 图谱匹配失败:", _fe); }

  // 🆕 V5.0: TXS-ID 贯穿 — 为所有 person 类型 entity_genes 解析 UUID
  try {
    const _fg = ctx.m4?.getFamilyGraph?.();
    if (_fg && dna.entity_genes?.length) {
      for (const gene of dna.entity_genes) {
        if (gene.type === 'person' && !gene.uuid) {
          const _uuid = _fg.getUUIDByName?.(gene.name);
          if (_uuid) gene.uuid = _uuid;
        }
      }
    }
  } catch (_e) { /* UUID resolution is non-critical */ }

  return { dna, ruleEngineBlocked, ruleEngineReply, weatherContext };
}
