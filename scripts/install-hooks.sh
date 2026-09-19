#!/bin/sh
# ========================================
# 安装 git hooks（把 hooks/*.template 复制到 .git/hooks/）
# ========================================
# 用法： sh scripts/install-hooks.sh
#
# 背景：.git/hooks/ 不被版本控制跟踪，必须通过本脚本部署。
# 原先 pre-commit 是手工创建且无模板，导致换机器/新 clone 后防线全丢。

set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -d ".git/hooks" ]; then
  echo "❌ 未找到 .git/hooks —— 请在 git 仓库根目录运行"
  exit 1
fi

if [ ! -f "hooks/pre-commit.template" ]; then
  echo "❌ 未找到 hooks/pre-commit.template"
  exit 1
fi

cp hooks/pre-commit.template .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit

echo "✅ 已安装 .git/hooks/pre-commit"
echo "   检查项：Harness Gate / 鸿鸣 / 临时开关 / tsc --noEmit / PAS 规范测试"
echo "   紧急跳过：SKIP_HOOK_CHECKS=1 git commit ..."
