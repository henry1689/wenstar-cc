/**
 * UUIDSupervisor — 户籍监督员（UUID 户籍管理法 §十七-十九）
 * ========================================================
 * 法条依据：《UUID 户籍管理法 V1.0》第十七条(监督员在岗) / 第十八条(巡检项) / 第十九条(台账)。
 * 职责：周期只读巡检——
 *   ① belong 登记率（memories/conversations 未标比例）
 *   ② belong 悬空（指向 FG 不存在的号 = 泄漏/错挂风险）
 *   ③ void 回收隔离（回收实体不得参与任何边 = 检索泄漏面）
 *   ④ FG 户籍基线（active 真户籍数）
 * 纯只读，不修改任何数据；结果供 health-check 每日巡检 / 台账落 audit。
 */

export interface SupItem {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface SupResult {
  at: string;
  items: SupItem[];
}

async function loadDb(path: string): Promise<any | null> {
  const { existsSync, readFileSync } = await import('node:fs');
  if (!existsSync(path)) return null;
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  try {
    return new SQL.Database(readFileSync(path));
  } catch {
    return null;
  }
}

function q(db: any, sql: string): any[][] {
  try {
    const r = db.exec(sql);
    return r.length ? (r[0].values as any[][]) : [];
  } catch {
    return [];
  }
}

/**
 * 执行户籍监督巡检（只读）。
 * @param fmPath fusion_memory.db 路径
 * @param fgPath family_graph.db 路径
 */
export async function runUUIDSupervision(fmPath: string, fgPath: string): Promise<SupResult> {
  const items: SupItem[] = [];
  const at = new Date().toISOString();
  const fm = await loadDb(fmPath);
  const fg = await loadDb(fgPath);
  if (!fm || !fg) {
    return { at, items: [{ name: '数据源加载', status: 'fail', detail: 'fusion/family_graph 库缺失或不可读' }] };
  }

  // ① memories belong 登记率
  const memT = Number(q(fm, 'SELECT COUNT(*) FROM memories')[0]?.[0] ?? 0);
  const memB = Number(q(fm, "SELECT COUNT(*) FROM memories WHERE belong_entity_uuid IS NOT NULL AND belong_entity_uuid != '' AND belong_entity_uuid != 'null'")[0]?.[0] ?? 0);
  const memRate = memT ? memB / memT : 1;
  items.push({
    name: '记忆belong登记率',
    status: memRate >= 0.9 ? 'pass' : memRate >= 0.7 ? 'warn' : 'fail',
    detail: `${memB}/${memT} = ${Math.round(memRate * 100)}%`,
  });

  // ② belong 悬空（不在 FG 号集 = 泄漏/错挂风险）
  const fgUuids = new Set<string>(q(fg, 'SELECT uuid FROM nodes WHERE uuid IS NOT NULL').map(r => String(r[0])));
  const belongRows = q(fm, "SELECT belong_entity_uuid FROM memories WHERE belong_entity_uuid IS NOT NULL AND belong_entity_uuid != '' AND belong_entity_uuid != 'null'");
  const hang = belongRows.filter(r => !fgUuids.has(String(r[0]))).length;
  items.push({
    name: 'belong悬空(不在FG号集)',
    status: hang === 0 ? 'pass' : hang > 50 ? 'fail' : 'warn',
    detail: `${hang} 条`,
  });

  // ③ conversations belong 登记率
  const cvT = Number(q(fm, 'SELECT COUNT(*) FROM conversations')[0]?.[0] ?? 0);
  const cvB = Number(q(fm, "SELECT COUNT(*) FROM conversations WHERE belong_entity_uuid IS NOT NULL AND belong_entity_uuid != ''")[0]?.[0] ?? 0);
  const cvRate = cvT ? cvB / cvT : 1;
  items.push({
    name: '对话belong登记率',
    status: cvRate >= 0.5 ? 'pass' : 'warn',
    detail: `${cvB}/${cvT} = ${Math.round(cvRate * 100)}%`,
  });

  // ④ void 回收隔离（void 实体不得参与任何边）
  const voidEdges = Number(q(fg, "SELECT COUNT(*) FROM edges e JOIN nodes s ON s.id=e.source_id JOIN nodes t ON t.id=e.target_id WHERE s.status='void' OR t.status='void'")[0]?.[0] ?? 0);
  items.push({
    name: 'void回收隔离',
    status: voidEdges === 0 ? 'pass' : 'fail',
    detail: `void 关联边 ${voidEdges}（应 0）`,
  });

  // ⑤ FG 户籍基线
  const active = Number(q(fg, "SELECT COUNT(*) FROM nodes WHERE type='person' AND status='active'")[0]?.[0] ?? 0);
  const voidN = Number(q(fg, "SELECT COUNT(*) FROM nodes WHERE status='void'")[0]?.[0] ?? 0);
  items.push({ name: 'FG户籍基线', status: 'pass', detail: `active ${active} 真户籍 / void ${voidN} 回收` });

  return { at, items };
}
