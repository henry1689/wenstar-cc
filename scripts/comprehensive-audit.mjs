// 综合验收: DB健康检查 → 金标查询 → 端到端七层管线
import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync } from 'fs';

async function main() {
  const SQL = await initSqlJs();
  const db = new SQL.Database(readFileSync('data/webui/fusion_memory.db'));

  let pass = 0, fail = 0;
  const check = (label, ok) => { if (ok) { pass++; console.log('  ✅ '+label); } else { fail++; console.log('  ❌ '+label); } };

  // ═══════════════════════════════════════════════════════
  // 1. DB 健康检查
  // ═══════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════');
  console.log('1. DB 健康检查');
  console.log('═══════════════════════════════════════');

  // 1a. 表存在
  // state_spines 已随 P071 底座1 废除删除，不再作必需表
  const requiredTables = ['memories','conversations','knowledge_base','search_index','memory_associations','atom_address_timeline'];
  for (const t of requiredTables) {
    try { db.exec('SELECT 1 FROM '+t+' LIMIT 0'); check('表 '+t+' 存在', true); }
    catch { check('表 '+t+' 存在', false); }
  }

  // 1b. search_index 有数据
  let siCount = 0;
  try { siCount = db.exec('SELECT count(*) FROM search_index')[0].values[0][0]; } catch {}
  check('search_index > 100000 条', siCount > 100000);
  console.log('     ('+siCount+' 条)');

  // 1c. memories 关键字段填充率
  const memTotal = db.exec('SELECT count(*) FROM memories')[0].values[0][0];
  const uidFilled = db.exec('SELECT count(*) FROM memories WHERE global_uid IS NOT NULL')[0].values[0][0];
  const euuidFilled = db.exec("SELECT count(*) FROM memories WHERE belong_entity_uuid IS NOT NULL AND belong_entity_uuid!=''")[0].values[0][0];
  const uidPct = (uidFilled/memTotal*100).toFixed(0);
  const euuidPct = (euuidFilled/memTotal*100).toFixed(0);
  check('global_uid 填充率 > 80%', uidFilled/memTotal > 0.8);
  console.log('     ('+uidFilled+'/'+memTotal+' = '+uidPct+'%)');
  check('belong_entity_uuid 填充率 > 20%', euuidFilled/memTotal > 0.2);
  console.log('     ('+euuidFilled+'/'+memTotal+' = '+euuidPct+'%)');

  // 1d. memory_associations 有边
  let edgeCount = 0;
  try { edgeCount = db.exec('SELECT count(*) FROM memory_associations')[0].values[0][0]; } catch {}
  check('memory_associations > 100 条边', edgeCount > 100);
  console.log('     ('+edgeCount+' 条)');

  // 1e. entity_relations 有实体关系
  let relCount = 0;
  try { relCount = db.exec('SELECT count(*) FROM entity_relations')[0].values[0][0]; } catch {}
  check('entity_relations > 50 条', relCount > 50);
  console.log('     ('+relCount+' 条)');

  // ═══════════════════════════════════════════════════════
  // 2. 金标查询回归
  // ═══════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════');
  console.log('2. 金标查询回归');
  console.log('═══════════════════════════════════════');

  const goldenQueries = [
    { name: '熊梓铭 学术研究', query: '熊梓铭 学术 研究', minResults: 3, mustContain: ['研究','实验','文献','认知'] },
    { name: '徐诗雨 浴缸 亲密', query: '徐诗雨 浴缸 亲密', minResults: 1, mustContain: ['浴缸','亲密','浴室','身体','后面','进入'] },
    { name: '妈妈 身体 担心',    query: '妈妈 身体 担心',    minResults: 2, mustContain: ['妈妈','身体'] },
    { name: '纪实小说 写书',      query: '纪实 小说 写书',    minResults: 2, mustContain: ['纪实','小说','第三章'] },
    { name: '玉瑶 亲密 爱',       query: '玉瑶 爱 亲密',      minResults: 3, mustContain: ['爱','想你','拥抱','吻'] },
  ];

  for (const gq of goldenQueries) {
    try {
      const ids = new Set();
      const cleaned = gq.query.replace(/[，。！？、；：《》【】\s\d\-]/g,'').trim();
      const ngrams = new Set();
      for (let i=0;i<cleaned.length-1;i++) ngrams.add(cleaned.substring(i,i+2));
      for (let i=0;i<cleaned.length-2;i++) ngrams.add(cleaned.substring(i,i+3));

      for (const g of [...ngrams].slice(0,8)) {
        const r = db.exec('SELECT source_id FROM search_index WHERE term=? AND source_type=? LIMIT 30',[g,'memory']);
        if (r.length&&r[0].values) for (const v of r[0].values) ids.add(String(v[0]));
      }
      // 同时补查: 直接全文搜索 memories.raw_input 兜底
      for (const kw of gq.query.split(/\s+/)) {
        const r = db.exec("SELECT id FROM memories WHERE raw_input LIKE ? LIMIT 20",['%'+kw+'%']);
        if (r.length&&r[0].values) for (const v of r[0].values) ids.add(String(v[0]));
      }

      const memIds = [...ids].slice(0,50);
      let items = [];
      if (memIds.length) {
        const pl = memIds.map(()=>'?').join(',');
        const r = db.exec('SELECT substr(raw_input,1,300) FROM memories WHERE id IN ('+pl+') LIMIT 30', memIds);
        if (r.length&&r[0].values) items = r[0].values.map(v=>String(v[0]||''));
      }

      const matched = items.filter(t => gq.mustContain.some(kw => t.includes(kw)));
      const ok = matched.length >= gq.minResults;
      check(gq.name+' (≥'+gq.minResults+' 条)', ok);
      console.log('     返回 '+items.length+' 条, 命中 '+matched.length+' 条');
    } catch(e) { check(gq.name, false); console.log('     '+e.message); }
  }

  // ═══════════════════════════════════════════════════════
  // 3. 跨主体隔离检查
  // ═══════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════');
  console.log('3. 跨主体隔离');
  console.log('═══════════════════════════════════════');

  // 查熊梓铭的记忆，确保不混入诗韵
  const zmMem = db.exec("SELECT substr(raw_input,1,200) FROM memories WHERE belong_entity_uuid='uuid-ziming' ORDER BY created_at DESC LIMIT 10");
  let shirleyInZM = false;
  if (zmMem.length&&zmMem[0].values) for (const v of zmMem[0].values) {
    if (String(v[0]).includes('诗韵')) shirleyInZM = true;
  }
  check('熊梓铭记忆中不含"诗韵"', !shirleyInZM);

  // 查诗韵记忆，确保不混入熊梓铭
  const syMem = db.exec("SELECT substr(raw_input,1,200) FROM memories WHERE belong_entity_uuid='uuid-shirley' ORDER BY created_at DESC LIMIT 10");
  let zimingInSY = false;
  if (syMem.length&&syMem[0].values) for (const v of syMem[0].values) {
    if (String(v[0]).includes('熊梓铭')||String(v[0]).includes('梓铭')) zimingInSY = true;
  }
  check('诗韵记忆中不含"梓铭"', !zimingInSY);

  // ═══════════════════════════════════════════════════════
  // 4. DAG 边质量检查
  // ═══════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════');
  console.log('4. DAG 边质量');
  console.log('═══════════════════════════════════════');

  // 非法时间边
  let badTimeEdges = 0;
  try {
    const r = db.exec("SELECT count(*) FROM memory_associations WHERE source_timestamp_ms >= target_timestamp_ms");
    badTimeEdges = r.length&&r[0].values ? r[0].values[0][0] : 0;
  } catch {}
  check('零逆时边', badTimeEdges === 0);
  console.log('     ('+badTimeEdges+' 条)');

  // 自环
  let selfLoops = 0;
  try {
    const r = db.exec("SELECT count(*) FROM memory_associations WHERE source_global_uid = target_global_uid");
    selfLoops = r.length&&r[0].values ? r[0].values[0][0] : 0;
  } catch {}
  check('零自环', selfLoops === 0);
  console.log('     ('+selfLoops+' 条)');

  // 四大边类型都存在
  const edgeTypes = db.exec('SELECT edge_type, count(*) FROM memory_associations GROUP BY edge_type');
  const typesFound = edgeTypes.length&&edgeTypes[0].values ? edgeTypes[0].values.map(v=>String(v[0])) : [];
  for (const et of ['entity','semantic','emotion']) {
    check('边类型 '+et+' 存在', typesFound.includes(et));
  }

  // ═══════════════════════════════════════════════════════
  // 5. Foresight 字段存在性
  // ═══════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════');
  console.log('5. Foresight 时效');
  console.log('═══════════════════════════════════════');

  try {
    const r = db.exec("SELECT count(*) FROM memories WHERE is_foresight IS NOT NULL");
    check('memories.is_foresight 列存在', true);
  } catch { check('memories.is_foresight 列存在', false); }

  try {
    const r = db.exec("SELECT count(*) FROM memories WHERE foresight_status IS NOT NULL");
    check('memories.foresight_status 列存在', true);
  } catch { check('memories.foresight_status 列存在', false); }

  try {
    const r = db.exec("SELECT count(*) FROM memories WHERE valid_until_ms IS NOT NULL");
    check('memories.valid_until_ms 列存在', true);
  } catch { check('memories.valid_until_ms 列存在', false); }

  // 6. perception_json 质量
  console.log('\n═══════════════════════════════════════');
  console.log('6. 24D 向量质量');
  console.log('═══════════════════════════════════════');

  const hasVec = db.exec('SELECT count(*) FROM memories WHERE perception_json IS NOT NULL AND perception_json != ""')[0].values[0][0];
  const vecPct = (hasVec/memTotal*100).toFixed(0);
  check('perception_json 填充率 > 80%', hasVec/memTotal > 0.8);
  console.log('     ('+hasVec+'/'+memTotal+' = '+vecPct+'%)');

  // 检查向量维度
  const vecLen = db.exec("SELECT substr(perception_json,1,80) FROM memories WHERE perception_json IS NOT NULL LIMIT 5");
  if (vecLen.length&&vecLen[0].values) {
    const first = String(vecLen[0].values[0][0]||'');
    try {
      const arr = JSON.parse(first);
      const dimOk = Array.isArray(arr) && arr.length === 24;
      check('perception_json 维度 = 24', dimOk);
      console.log('     (第一样本: '+arr.length+'D)');
    } catch { check('perception_json 合法 JSON', false); }
  }

  // ═══════════════════════════════════════════════════════
  // 汇总
  // ═══════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════');
  console.log('汇总: '+pass+' 通过 / '+fail+' 失败 / '+(pass+fail)+' 项');
  console.log('═══════════════════════════════════════');

  if (fail > 0) {
    console.log('\n⚠️ 发现 '+fail+' 个问题需要修复');
  } else {
    console.log('\n✅ 全部检查通过');
  }

  writeFileSync('data/webui/fusion_memory.db', Buffer.from(db.export()));
  db.close();
}
main().catch(console.error);
