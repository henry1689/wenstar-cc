/**
 * ThresholdBar — 感知阈值变化条（8 个核心维度 + 阈值线）
 *
 * 数据来源：思维流 store 中的最新 m3 快照 —— 与心智雷达（CognitiveRadar）**同源同口径**：
 *   维度清单  ← stores.thoughtStore.CORE_DIMENSIONS
 *   取值      ← stores.thoughtStore.extractPerception
 *   归一/阈值 ← stores.thoughtStore.normalizePerception / PERCEPTION_THRESHOLD
 * 三处共用同一函数，保证雷达图与阈值条对同一个快照给出不矛盾的读数。
 *
 * 阈值语义：归一空间 0.5 ≡ 原始中性 0。条压在线上 = 该维度无激活；
 *   越过线（偏离 > ACTIVE_DELTA）= 点亮并显示原始值。
 */
import { useMemo } from 'react';
import {
  useThoughtStore,
  CORE_DIMENSIONS,
  extractPerception,
  normalizePerception,
  PERCEPTION_THRESHOLD,
} from '../store/thoughtStore';

/** 偏离阈值多少算「有变化」（归一空间） */
const ACTIVE_DELTA = 0.1;

export default function ThresholdBar() {
  const m3 = useThoughtStore((s) => s.latestModules.m3);
  const perception = useMemo(() => extractPerception(m3), [m3]);
  const hasData = m3?.quadrant1 != null;

  return (
    <div className="threshold-bar">
      <div className="tb-head">
        <span className="tb-title">感知阈值</span>
        <span className="tb-sub">{hasData ? '8 维 · 越线即激活' : '等待 M3 数据…'}</span>
      </div>

      <div className="tb-rows">
        {CORE_DIMENSIONS.map((dim) => {
          const raw = perception[dim.key] ?? 0;
          const val = normalizePerception(raw);
          const active = Math.abs(val - PERCEPTION_THRESHOLD) > ACTIVE_DELTA;
          return (
            <div className={`tb-row${active ? ' tb-active' : ''}`} key={dim.key}>
              <span className="tb-label" style={active ? { color: dim.color } : undefined}>
                {dim.label}
              </span>
              <span className="tb-track">
                <span className="tb-fill" style={{ width: `${val * 100}%`, background: dim.color }} />
                <span className="tb-threshold" style={{ left: `${PERCEPTION_THRESHOLD * 100}%` }} />
              </span>
              <span className="tb-value" style={active ? { color: dim.color } : undefined}>
                {raw >= 0 ? '+' : ''}{raw.toFixed(2)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
