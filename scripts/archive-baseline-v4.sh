#!/bin/bash
# 太虚境·CC版 检索架构基线 v4.0 — 存档脚本
# 执行：bash scripts/archive-baseline-v4.sh
set -e

ARCHIVE_DIR="archives/v4-baseline-$(date +%Y%m%d)"
mkdir -p $ARCHIVE_DIR

echo "=== 归档检索架构基线 v4.0 ==="

# 1. 架构规范文档
echo "[1/6] 架构规范文档..."
cp docs/retrieval-architecture-baseline-v4.md $ARCHIVE_DIR/
cp docs/architecture-improvement-blueprint-v2.md $ARCHIVE_DIR/

# 2. 代码变更快照
echo "[2/6] 核心代码变更..."
mkdir -p $ARCHIVE_DIR/src/m4
mkdir -p $ARCHIVE_DIR/src/app/roleplay
cp src/m4/MemoryRetriever.ts $ARCHIVE_DIR/src/m4/
cp src/m4/EntityTopologyManager.ts $ARCHIVE_DIR/src/m4/
cp src/m4/entity-topology-schema.sql $ARCHIVE_DIR/src/m4/
cp src/app/roleplay/FourLayerDataCollector.ts $ARCHIVE_DIR/src/app/roleplay/
cp src/app/roleplay/PromptAssembler.ts $ARCHIVE_DIR/src/app/roleplay/
cp src/app/roleplay/types.ts $ARCHIVE_DIR/src/app/roleplay/

# 3. 拓扑存量数据
echo "[3/6] 拓扑存量数据..."
python3 -c "
import sqlite3, csv
db = sqlite3.connect('data/webui/fusion_memory.db')
c = db.cursor()
c.execute('SELECT * FROM entity_topology')
rows = c.fetchall()
print(f'导出 {len(rows)} 条拓扑边')
cols = [d[0] for d in c.description]
with open('$ARCHIVE_DIR/entity_topology_export.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(cols)
    w.writerows(rows)
db.close()
"

# 4. 改造效果指标
echo "[4/6] 改造效果指标..."
cat > $ARCHIVE_DIR/performance-metrics.md << 'EOF'
## 改造效果指标（基线 v4.0）

| 指标 | 改造前 | 改造后 |
|------|--------|--------|
| 王全芬幻觉 | 出现 | 清除 |
| 吴波数据串扰 | 出现 | 清除 |
| 亲属信息补丁 | 每人物硬编码 | 拓扑递归自动化 |
| 检索并行浪费 | 全库扫描 | 串行命中截断 |
| 检索层级 | 无序并行 | L1-L5串行 |
| 拓扑边数量 | 0 | 264条双向 |
| 递归深度 | N/A | 3级+visited去重 |
| 角色隔离 | findMemoriesByEntityNames | roleplay_char过滤 |
| LLM门控 | 无条件生成 | hasValidRelation控制 |
EOF

# 5. Git diff
echo "[5/6] Git变更记录..."
git diff --stat > $ARCHIVE_DIR/git-diff-stat.txt 2>/dev/null || echo "不在git仓库中，跳过"

# 6. 归档压缩
echo "[6/6] 打包归档..."
tar -czf archives/v4-baseline-$(date +%Y%m%d).tar.gz $ARCHIVE_DIR/
echo "=== 归档完成 ==="
echo "路径: archives/v4-baseline-$(date +%Y%m%d).tar.gz"
echo "大小: $(du -sh archives/v4-baseline-$(date +%Y%m%d).tar.gz | cut -f1)"
