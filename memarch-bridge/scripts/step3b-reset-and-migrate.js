/**
 * step3b-reset-and-migrate.js — 清空新库 + 重跑迁移
 */
const fs = require('fs');
const path = 'D:/tools/wenstar-cc/data/memarch-v2.db';

// 备份当前新库（以防万一）
const bak = path + '.bak-partial';
if (fs.existsSync(path)) {
  fs.copyFileSync(path, bak);
  console.log('已备份当前新库到', bak);
  fs.unlinkSync(path);
}

// 重新跑 step1
require('./step1-init-db.js');

// 然后跑迁移
console.log('\n--- 开始迁移 ---');
require('./step3-migrate.js');
