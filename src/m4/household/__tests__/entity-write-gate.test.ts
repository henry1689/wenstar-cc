import { describe, it, expect } from 'vitest';
import { checkEntityWrite, checkPersonEntity, checkObjectEntity } from '../EntityWriteGate.js';

/**
 * FG-P0 写前统一闸门单测（2026-09-09 乱提取根治）
 * 场景: 一段 LLM 外貌描述被逗号切 12 块全入库 object(103886-103897)、整句"说说你的胸怎么这么小"
 *      被建档、真人被误标 object —— 垃圾率 77%。本闸门在所有写入点前拦截。
 */

describe('checkObjectEntity — object 通道', () => {
  it('🔴 整句/散文段(诊断垃圾 103886-103897 形态) 拦截', () => {
    expect(checkObjectEntity('和姐姐诗雨有七分相似的瓜子脸').allowed).toBe(false);
    expect(checkObjectEntity('大眼睛又圆又亮').allowed).toBe(false);
    expect(checkObjectEntity('性格温柔内向又细心').allowed).toBe(false);
    expect(checkObjectEntity('刚开始发育的少女身材').allowed).toBe(false);
    expect(checkObjectEntity('说说你的胸怎么这么小').allowed).toBe(false);
  });

  it('🔴 外貌特征词尾 不建独立 object（应存档案/特征边）', () => {
    expect(checkObjectEntity('瓜子脸').allowed).toBe(false);
    expect(checkObjectEntity('高个子').allowed).toBe(false);
    expect(checkObjectEntity('双眼皮').allowed).toBe(false);
    expect(checkObjectEntity('长头发').allowed).toBe(false);
    expect(checkObjectEntity('活泼').allowed).toBe(false);
  });

  it('真人进 object 通道不应放行独立 object（统一入口 person 优先分流）', () => {
    expect(checkEntityWrite('熊梓玥').allowed).toBe(true);   // person 通道放行
    expect(checkEntityWrite('熊梓玥').mode).toBe('person');  // 分流到 person, 不当 object 建
  });

  it('合规 object 名词放行', () => {
    expect(checkObjectEntity('游戏').allowed).toBe(true);
    expect(checkObjectEntity('宿舍').allowed).toBe(true);
    expect(checkObjectEntity('办公室').allowed).toBe(true);
  });

  it('超长/空拒绝', () => {
    expect(checkObjectEntity('').allowed).toBe(false);
    expect(checkObjectEntity('操场东边第三棵老槐树下的石凳').allowed).toBe(false);
  });
});

describe('checkPersonEntity / checkEntityWrite — person 通道', () => {
  it('🔴 句子残留以姓开头(乱提取假名) 拒绝', () => {
    expect(checkPersonEntity('温柔').allowed).toBe(false);   // 弱证据姓
    expect(checkPersonEntity('应一下').allowed).toBe(false);
  });

  it('合规真名 放行', () => {
    expect(checkPersonEntity('熊梓铭').allowed).toBe(true);
    expect(checkPersonEntity('徐诗雨').allowed).toBe(true);
    expect(checkPersonEntity('王全芬').allowed).toBe(true);
  });

  it('称谓/黑名单拒绝', () => {
    expect(checkPersonEntity('亲爱的').allowed).toBe(false);
    expect(checkPersonEntity('妈').allowed).toBe(false);
  });

  it('已知实体直接放行(L4)', () => {
    expect(checkPersonEntity('安琪', new Set(['安琪', '玉瑶'])).allowed).toBe(true);
  });
});

describe('checkEntityWrite — 统一入口', () => {
  it('真名走 person 放行, 垃圾句子整体拒绝', () => {
    expect(checkEntityWrite('徐诗雨').allowed).toBe(true);
    expect(checkEntityWrite('大眼睛又圆又亮').allowed).toBe(false);
  });
});
