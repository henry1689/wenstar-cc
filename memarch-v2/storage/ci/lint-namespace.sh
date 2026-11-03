#!/usr/bin/env bash
# =====================================================================
# MemArch-v2.0.0 / M1-Storage / lint-namespace.sh
# CI 强制检查：storage/ 目录外禁止直接查原表 conversations/memories/episodes
# 用法: bash storage/ci/lint-namespace.sh <repo_root>
# 退出码: 0=通过, 1=发现违规
# =====================================================================
set -euo pipefail

ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
VIOLATIONS=0

echo "[lint-namespace] scanning repo root: $ROOT"

# 被禁的原表（业务代码必须走 v_conv_real / v_mem_real / v_ep_real）
FORBIDDEN_PATTERNS=(
  "FROM[[:space:]]\+conversations\b"
  "FROM[[:space:]]\+memories\b"
  "FROM[[:space:]]\+episodes\b"
  "JOIN[[:space:]]\+conversations\b"
  "JOIN[[:space:]]\+memories\b"
  "JOIN[[:space:]]\+episodes\b"
  "INTO[[:space:]]\+conversations\b"
  "INTO[[:space:]]\+memories\b"
  "INTO[[:space:]]\+episodes\b"
)

# 允许直接访问原表的白名单路径（storage/ 内部、迁移脚本、DDL、测试夹具）
ALLOWED_GLOBS=(
  "memarch-v2/storage/ddl/*"
  "memarch-v2/storage/migrations/*"
  "memarch-v2/storage/write_queue/*"
  "memarch-v2/storage/tests/fixtures/*"
  "memarch-v2/storage/ci/*"
  "node_modules/*"
  "*.sql"
)

is_allowed() {
  local file="$1"
  for pat in "${ALLOWED_GLOBS[@]}"; do
    # shellcheck disable=SC2053
    if [[ "$file" == $pat ]]; then
      return 0
    fi
  done
  return 1
}

while IFS= read -r -d '' file; do
  if is_allowed "$file"; then
    continue
  fi
  for pat in "${FORBIDDEN_PATTERNS[@]}"; do
    if grep -nE "$pat" "$file" >/dev/null 2>&1; then
      echo "  ❌ VIOLATION: $file"
      grep -nE "$pat" "$file" | sed 's/^/     /'
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  done
done < <(find "$ROOT" -type f \( -name "*.ts" -o -name "*.js" -o -name "*.sql" \) -not -path "*/node_modules/*" -not -path "*/.git/*" -print0)

if [[ $VIOLATIONS -gt 0 ]]; then
  echo ""
  echo "[lint-namespace] FAILED: $VIOLATIONS 处违规。业务代码必须通过 v_conv_real / v_mem_real / v_ep_real 视图访问。"
  exit 1
fi
echo "[lint-namespace] OK: 未发现原表直查违规。"
