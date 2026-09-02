import { FamilyGraph } from '../src/m4/household/FamilyGraph.js';
async function main() {
  const fg = new FamilyGraph();
  await fg.initialize();
  const aliasMap = fg.getAllPersonNamesWithAliases();
  console.log('别名映射数:', aliasMap.size);
  console.log('韵韵 →', aliasMap.get('韵韵'));
  console.log('诗韵 →', aliasMap.get('诗韵'));
  console.log('全芬 →', aliasMap.get('全芬'));
}
main();
