/**
 * MemWen OS · canon —— 不可变内核规范化（ADR-024 附录 v2 §6.1 唯一实现）
 *
 * 🔴 公式单实现立法：canon 规范只在此处定义。哈希链跨版本一致性依赖三点：
 *   ① 字段顺序固定（FIELD_ORDER，与对象字面量书写顺序无关）；
 *   ② Unicode NFC 归一（"é" 的组合/分解形式必须同码点序列）；
 *   ③ 时间戳统一 ISO8601 毫秒（UTC），epoch 毫秒与 ISO 字符串同值同形。
 *
 * 纯函数：不读墙钟、不碰 I/O、无随机。
 */

/** 不可变内核（附录 §一：x / t_tx / belong / src —— 只有这些进哈希） */
export interface MwImmutableCore {
  /** 原文（不可变） */
  readonly x: string;
  /** 系统获知时间：epoch 毫秒或 ISO 字符串 */
  readonly t_tx: number | string;
  /** 归属（实体 UUID 等） */
  readonly belong: string;
  /** 来源（写入通道标识） */
  readonly src: string;
}

/** canon 字段顺序（固定立法，不得随实现改动而漂移） */
const FIELD_ORDER = ['x', 't_tx', 'belong', 'src'] as const;

/**
 * 时间归一 → ISO8601 毫秒 UTC。
 * 非法时间 fail-fast（静默保留原值会让同义时间算出不同哈希 = 链假断）。
 */
function normTime(v: number | string): string {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError(`canon: 非法时间戳 ${v}`);
    return new Date(v).toISOString();
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new TypeError(`canon: 无法解析时间 ${JSON.stringify(v)}`);
  return new Date(t).toISOString();
}

/**
 * 规范化不可变内核为稳定字符串。
 * 输出形如：x=…|t_tx=…|belong=…|src=…（分隔符转义，防拼接歧义）
 */
export function canon(core: MwImmutableCore): string {
  if (!core || typeof core !== 'object') throw new TypeError('canon: core 必须是对象');
  const parts: string[] = [];
  for (const key of FIELD_ORDER) {
    const raw = core[key];
    if (key === 't_tx') {
      parts.push(`t_tx=${normTime(raw as number | string)}`);
      continue;
    }
    if (typeof raw !== 'string') throw new TypeError(`canon: 字段 ${key} 必须是字符串`);
    // NFC 归一 + 转义（反斜杠与分隔符，保证拼接无歧义）
    const nfc = raw.normalize('NFC').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
    parts.push(`${key}=${nfc}`);
  }
  return parts.join('|');
}

/**
 * 稳定 JSON 序列化（链输入的唯一序列化实现）。
 *
 * - 对象键**递归排序**（同一逻辑对象不同插入序 → 同一文本）；
 * - 字符串 NFC 归一；
 * - undefined / 函数 / symbol 按 JSON 语义跳过；数组保持顺序（顺序即语义）；
 * - 循环引用 fail-fast（抛错，不静默截断 —— 静默截断会让两条不同输入算出同一哈希）。
 *
 * 用途：append_log 条目 → 链输入文本（bArchiveLog 计算 chain / BArchiveReader 验证）。
 */
export function stableStringify(value: unknown): string {
  const seen = new Set<object>();
  const walk = (v: unknown): string | undefined => {
    if (v === null) return 'null';
    const t = typeof v;
    if (t === 'string') return JSON.stringify((v as string).normalize('NFC'));
    if (t === 'number') return Number.isFinite(v as number) ? String(v) : 'null';
    if (t === 'boolean') return String(v);
    if (t === 'bigint') return JSON.stringify(String(v));
    if (t === 'undefined' || t === 'function' || t === 'symbol') return undefined;
    const obj = v as object;
    if (seen.has(obj)) throw new TypeError('stableStringify: 循环引用');
    seen.add(obj);
    let out: string;
    if (Array.isArray(obj)) {
      out = `[${obj.map((x) => walk(x) ?? 'null').join(',')}]`;
    } else {
      const keys = Object.keys(obj as Record<string, unknown>).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const sv = walk((obj as Record<string, unknown>)[k]);
        if (sv !== undefined) parts.push(`${JSON.stringify(k.normalize('NFC'))}:${sv}`);
      }
      out = `{${parts.join(',')}}`;
    }
    seen.delete(obj);
    return out;
  };
  const r = walk(value);
  return r === undefined ? 'null' : r;
}
