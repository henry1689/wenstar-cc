import { describe, it, expect } from 'vitest';
import {
  pickElements, ingestElement, MEMSYM_ELEMENT_TAG, SOFT_FORGOTTEN_THRESHOLD,
  type ElementStore, type ElementWriter, type ElementPickRequest,
} from '../element-picker.js';

/** 内存版要素池（模拟 knowledge_base） */
function mockStore(rows: Array<Record<string, unknown>>): ElementStore {
  return { queryAll: () => rows };
}

const UUID = 'TXS-000000001';
const req = (over: Partial<ElementPickRequest> = {}): ElementPickRequest => ({
  entityUuid: UUID,
  currentContext: '想放松，安安静静聊会天',
  purpose: 'enrich_empathy',
  allowedElementTags: new Set(['preference', 'mood']),
  threshold: 0.4, // 灰度校准前测试阈值
  ...over,
});

const baseRow = (over: Record<string, unknown> = {}) => ({
  id: 'me-1', content: '偏爱安静氛围感,喜欢慢慢说话',
  tags: `${MEMSYM_ELEMENT_TAG},preference`, entity_uuid: UUID,
  impression: 0.8, emotion_vector: '[]', ...over,
});

describe('MemSym 批γ-a · 要素检索器（通路B基础设施）', () => {
  it('跨实体条目硬过滤（窜台防线，隐患三）', () => {
    const picked = pickElements(mockStore([baseRow({ entity_uuid: 'TXS-OTHER' })]), req());
    expect(picked.length).toBe(0);
  });

  it('软遗忘条目不选（隐患五："说了忘掉却还在被暗示"）', () => {
    const picked = pickElements(mockStore([baseRow({ impression: SOFT_FORGOTTEN_THRESHOLD - 0.01 })]), req());
    expect(picked.length).toBe(0);
  });

  it('未沉淀元素 settled=false 且权重减半（隐患四：随口一说不固化）', () => {
    const picked = pickElements(mockStore([
      baseRow({ id: 'settled', title: 'a', tags: `${MEMSYM_ELEMENT_TAG},preference` }),
      baseRow({ id: 'pending', title: 'b', tags: `${MEMSYM_ELEMENT_TAG},preference,pending-element` }),
    ]), req({ threshold: 0.2 }));
    expect(picked.length).toBe(2);
    const s = picked.find((p) => p.sourceAnchorUUID === 'settled')!;
    const p = picked.find((p) => p.sourceAnchorUUID === 'pending')!;
    expect(s.settled).toBe(true);
    expect(p.settled).toBe(false);
    expect(p.fitScore).toBeCloseTo(s.fitScore * 0.5, 5);
  });

  it('低于阈值不拾取；上下文重合抬升适配度', () => {
    const hit = pickElements(mockStore([baseRow()]), req({ threshold: 0.5 }));
    const miss = pickElements(mockStore([baseRow({ content: '完全无关的烹饪技巧' })]), req({ threshold: 0.5 }));
    expect(hit.length).toBe(1);
    expect(hit[0].fitScore).toBeGreaterThanOrEqual(0.5);
    expect(miss.length).toBe(0); // 无重合无标签时低于阈值
  });

  it('40D 余弦分量可用时参与加权（情绪向量损坏不阻塞）', () => {
    const ctx40 = new Array(40).fill(0.5);
    const ev = JSON.stringify(new Array(40).fill(0.9));
    const picked = pickElements(mockStore([
      baseRow({ id: 'with40', emotion_vector: ev }),
      baseRow({ id: 'bad40', emotion_vector: 'not-json' }),
    ]), req({ context40d: ctx40, threshold: 0.3 }));
    expect(picked.length).toBe(2); // 损坏的退化为标签+重合度，不抛错
  });

  it('ingestElement 幂等（同 id 去重）+ 未沉淀标签写入专表', () => {
    const written: Array<Record<string, unknown>> = [];
    const store: ElementStore = { queryAll: (_s, p) => written.filter((w) => w.id === p[0]).map(() => ({ id: 'x' })) };
    const writer: ElementWriter = { addEntry: (e) => written.push(e as never) };
    expect(ingestElement(store, writer, { entityUuid: UUID, content: 'c1', tags: ['mood'], pending: true, sourceAnchorUUID: 'A1' })).toBe(true);
    expect(ingestElement(store, writer, { entityUuid: UUID, content: 'c1', sourceAnchorUUID: 'A1' })).toBe(false); // 幂等
    expect(written.length).toBe(1);
    expect(written[0].tags).toContain('pending-element');
    expect(written[0].tags).toContain(MEMSYM_ELEMENT_TAG);
    expect(written[0].entity_uuid).toBe(UUID);
  });
});
