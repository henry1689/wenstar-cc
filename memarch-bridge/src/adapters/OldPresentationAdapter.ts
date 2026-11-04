/**
 * OldPresentationAdapter.ts — 旧 m5/ContextMemory → 新 M5 PresentationEngine
 *
 * 【适配关系】
 *   旧：src/m5/ContextMemory.ts（模块级单例状态，全局只有一份 → 多角色串台！）
 *   新：memarch-v2/presentation/PresentationEngine.present()
 *
 * 【关键修复】
 *   旧 ContextMemory 是模块级 `let _state`，所有角色共享一份物理状态，
 *   切角色时不 reset 就串台（玉瑶的"在床上"跑到诗雨那边去）。
 *   新适配器：按 namespace 维护独立 PresentationEngine 实例 + 独立 scene state，
 *   物理隔离。
 */

import { PresentationEngine } from '../../../memarch-v2/presentation/index.js';
import type { Pathway } from '../../../memarch-v2/presentation/types.js';
import { NamespaceContext } from '../namespace/NamespaceContext.js';
import type {
  MemoryPresentPort,
  PresentResult,
  RetrievedEvidence,
} from '../core/MemoryPort.js';
import type { FeatureFlag } from '../core/FeatureFlag.js';

/** 旧 ContextMemory 的场景快照（用于兼容） */
interface SceneSnapshot {
  physical: { nudityLevel: number; position: string; location: string; activity: string };
  atmosphere: { mood: string; tension: number; distance: number };
  facts: { lastIntimatePeak: boolean; lastUserTopic: string; lastReplyTone: string; mentionedEntities: string[] };
}

const DEFAULT_SNAPSHOT: SceneSnapshot = {
  physical: { nudityLevel: 0, position: '坐着', location: '家里', activity: '聊天' },
  atmosphere: { mood: '平静', tension: 0.1, distance: 0.7 },
  facts: { lastIntimatePeak: false, lastUserTopic: '', lastReplyTone: 'warm', mentionedEntities: [] },
};

export class OldPresentationAdapter implements MemoryPresentPort {
  /** 每个 namespace 一份独立 PresentationEngine + scene state（物理隔离关键） */
  private engines = new Map<string, PresentationEngine>();
  private sceneStates = new Map<string, SceneSnapshot>();
  /** 每 namespace 独立的通路状态（A/B 与强化计数）—— M5 判定 B→A 升级要用 */
  private pathwayStates = new Map<string, Map<string, { pathway: Pathway; count: number }>>();

  constructor(private readonly flag: FeatureFlag) {}

  private getEngine(namespace: string): PresentationEngine {
    let eng = this.engines.get(namespace);
    if (!eng) {
      // 每个 namespace 独立 engine + 独立通路状态（物理隔离关键）。
      // 🔴 三个 sink 的签名以 M5 types 为准（同步、非 async）：
      //   ReinforceSink.reinforce(uuid, signal): void
      //   WriteSink.write(input): WriteResult
      //   PathwayStore: getPathway / promoteToA / getReinforcementCount / bumpReinforcement
      const pathways = new Map<string, { pathway: Pathway; count: number }>();
      this.pathwayStates.set(namespace, pathways);
      const getEntry = (uuid: string) => {
        let e = pathways.get(uuid);
        if (!e) { e = { pathway: 'A', count: 0 }; pathways.set(uuid, e); }
        return e;
      };

      eng = new PresentationEngine({
        // 强化信号回写 M3 尚未接线：**显式空实现**而不是伪装成 async（原先那版类型根本不符）
        reinforceSink: { reinforce: () => { /* TODO(bridge): 接入 M3 enrichment */ } },
        // 再巩固写回 M2 尚未接线：调用即抛，避免"静默成功"掩盖未接线
        writeSink: {
          write: () => {
            throw new Error('[bridge] writeSink.write 未接线：M5 再巩固写回 M2 的通道尚未建立');
          },
        },
        pathwayStore: {
          getPathway: (uuid) => getEntry(uuid).pathway,
          promoteToA: (uuid, boost) => { const e = getEntry(uuid); e.pathway = 'A'; e.count += boost; },
          getReinforcementCount: (uuid) => getEntry(uuid).count,
          bumpReinforcement: (uuid) => { const e = getEntry(uuid); e.count += 1; return e.count; },
        },
      });
      this.engines.set(namespace, eng);
    }
    return eng;
  }

  private getScene(namespace: string): SceneSnapshot {
    let s = this.sceneStates.get(namespace);
    if (!s) {
      s = structuredClone(DEFAULT_SNAPSHOT);
      this.sceneStates.set(namespace, s);
    }
    return s;
  }

  present(input: { evidences: RetrievedEvidence[]; userQuery: string; namespace: string }): PresentResult {
    const decision = this.flag.route(input.namespace, input.userQuery.slice(0, 32));
    if (decision.target !== 'v2') {
      // 旧路径：直接从旧 ContextMemory 走（保留旧逻辑）
      // 此处返回一个 fallback utterance，实际由旧 m5/M5Orchestrator 接管
      return {
        utterance: input.userQuery,
        label: 'legacy_fallback',
        routedPath: 'B_only',
        pA: 0,
        guardPassed: true,
        droppedAssertions: [],
        usedUuids: [],
      };
    }

    const eng = this.getEngine(input.namespace);
    const r = eng.present({
      // 🔴 契约对齐：M5 要的是 M4EvidenceLike（memory_id/text/score/timestamp/
      //   recency/strength/source_namespace），不是 RetrievedEvidence 的字段名。
      //   recency = 距今天数，由 tsUtc 现算（RetrieveAdapter 已补 tsUtc）。
      evidences: input.evidences.map((e) => {
        const ts = e.tsUtc ?? Date.now();
        return {
          memory_id: e.uuid,
          text: e.rawText,
          score: e.score,
          timestamp: ts,
          recency: Math.max(0, (Date.now() - ts) / 86_400_000),
          strength: e.consolidation ?? 0,
          source_namespace: e.namespace,
          recall_sources: e.recallLeg ? e.recallLeg.split(',') : undefined,
          pathway: e.pathway,
        };
      }),
      user_query: input.userQuery,
    });

    return {
      utterance: r.utterance,
      label: r.label,
      routedPath: r.routed_path,
      pA: r.p_A,
      guardPassed: r.guard_passed,
      // M5 的 dropped_assertions 是 Assertion[]（含 text/tokens/supportedBy），
      // 端口契约是 string[] —— 取分句原文，不丢可读信息。
      droppedAssertions: (r.dropped_assertions ?? []).map((a) => a.text),
      usedUuids: r.used_uuids,
    };
  }

  async attribute(input: {
    userReply: string;
    usedEvidences: RetrievedEvidence[];
    namespace: string;
  }): Promise<void> {
    const eng = this.getEngine(input.namespace);
    eng.attribute({
      user_reply: input.userReply,
      used_evidences: input.usedEvidences.map((e) => ({
        uuid: e.uuid,
        namespace: e.namespace,
        raw_text: e.rawText,
        summary: e.summary,
        score: e.score,
      })) as any,
    });
  }

  buildScenePrompt(namespace: string): string {
    const s = this.getScene(namespace);
    const clothMap = ['衣着完整', '部分裸露', '几乎全裸', '全裸'];
    const parts = [`[${namespace} 场景]`];
    parts.push(
      `状态: ${clothMap[s.physical.nudityLevel]}，${s.physical.position}，在${s.physical.location}，${s.physical.activity}`
    );
    parts.push(`氛围: ${s.atmosphere.mood}，张力${s.atmosphere.tension.toFixed(1)}，距离感${s.atmosphere.distance.toFixed(1)}`);
    if (s.facts.lastIntimatePeak) parts.push('⏺ 上一轮刚经历高潮');
    if (s.facts.lastUserTopic) parts.push(`⏺ 用户刚才在说: ${s.facts.lastUserTopic.slice(0, 30)}`);
    return parts.join(' | ') + '\n';
  }

  updateAfterReply(input: { draft: string; userMessage: string; tone: string; namespace: string }): void {
    const s = this.getScene(input.namespace);
    // 物理状态
    if (/脱掉|褪去|解开.*衣|脱.*光|一丝不挂|全裸|光着/.test(input.draft)) s.physical.nudityLevel = 3;
    else if (/褪到腰间|露出|解开.*扣|半裸/.test(input.draft)) s.physical.nudityLevel = 2;
    else if (/脱了外套|只穿着|撩起/.test(input.draft)) s.physical.nudityLevel = 1;
    // 姿势
    if (/躺下|躺在床上|平躺/.test(input.draft)) s.physical.position = '躺着';
    else if (/坐起|坐直/.test(input.draft)) s.physical.position = '坐着';
    else if (/站起|站着|站起身来/.test(input.draft)) s.physical.position = '站着';
    // 地点
    if (/床/.test(input.draft)) s.physical.location = '床上';
    else if (/沙发/.test(input.draft)) s.physical.location = '沙发上';
    else if (/办公|公司|工位/.test(input.userMessage)) { s.physical.location = '办公室'; s.physical.activity = '工作'; }
    // 事实
    s.facts.lastIntimatePeak = /高潮|丢了|去了|到了/.test(input.draft);
    s.facts.lastReplyTone = input.tone;
    s.facts.lastUserTopic = input.userMessage.slice(0, 40);
  }

  resetScene(namespace: string): void {
    this.sceneStates.set(namespace, structuredClone(DEFAULT_SNAPSHOT));
  }
}
