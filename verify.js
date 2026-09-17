const D = require('better-sqlite3');
const f = new D('data/webui/knowledge/family_graph.db', {readonly:true});

console.log('=== 徐诗涵档案验证 ===');
const shihan = f.prepare("SELECT properties FROM nodes WHERE name='徐诗涵'").get();
const p1 = JSON.parse(shihan.properties || '{}');
console.log('age:', p1.age);
console.log('birthYear:', p1.birthYear);
console.log('description:', (p1.description || '').substring(0, 100));
console.log('family_gene:', p1.family_gene);

console.log('\n=== 徐诗韵档案验证 ===');
const shiyun = f.prepare("SELECT properties FROM nodes WHERE name='徐诗韵'").get();
const p2 = JSON.parse(shiyun.properties || '{}');
console.log('age:', p2.age);
console.log('birthYear:', p2.birthYear);
console.log('description:', (p2.description || '').substring(0, 100));

console.log('\n=== 关系边验证 ===');
const edges = f.prepare(`
  SELECT n1.name as from_name, e.type as relation, n2.name as to_name
  FROM edges e
  JOIN nodes n1 ON e.from_id = n1.id
  JOIN nodes n2 ON e.to_id = n2.id
  WHERE n1.name IN ('徐诗雨','徐诗韵','徐诗涵') 
    AND n2.name IN ('徐诗雨','徐诗韵','徐诗涵')
`).all();
edges.forEach(e => console.log(`${e.from_name} --[${e.relation}]--> ${e.to_name}`));

f.close();
