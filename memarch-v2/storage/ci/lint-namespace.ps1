# =====================================================================
# MemArch-v2.0.0 / M1-Storage / lint-namespace.ps1
# Windows 原生版 CI lint：storage/ 外禁止直查原表
# 用法: powershell -File storage/ci/lint-namespace.ps1 -RepoRoot <root>
# =====================================================================
param(
  [string]$RepoRoot = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
$violations = 0

Write-Host "[lint-namespace] scanning: $RepoRoot"

$forbiddenPatterns = @(
  'FROM\s+conversations\b',
  'FROM\s+memories\b',
  'FROM\s+episodes\b',
  'JOIN\s+conversations\b',
  'JOIN\s+memories\b',
  'JOIN\s+episodes\b',
  'INTO\s+conversations\b',
  'INTO\s+memories\b',
  'INTO\s+episodes\b'
)

$allowedSubstrings = @(
  'memarch-v2\storage\ddl',
  'memarch-v2\storage\migrations',
  'memarch-v2\storage\write_queue',
  'memarch-v2\storage\tests\fixtures',
  'memarch-v2\storage\ci',
  'node_modules',
  '.git'
)

$files = Get-ChildItem -Path $RepoRoot -Recurse -File `
  -Include '*.ts','*.js','*.sql' `
  -ErrorAction SilentlyContinue |
  Where-Object {
    $rel = $_.FullName.Substring($RepoRoot.Length)
    -not ($allowedSubstrings | Where-Object { $rel -like "*$_*" })
  }

foreach ($f in $files) {
  $lines = Get-Content $f.FullName -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt $lines.Count; $i++) {
    foreach ($pat in $forbiddenPatterns) {
      if ($lines[$i] -match $pat) {
        Write-Host "  ❌ $($f.FullName):$($i+1): $($lines[$i].Trim())"
        $violations++
      }
    }
  }
}

if ($violations -gt 0) {
  Write-Host "`n[lint-namespace] FAILED: $violations 处违规。业务代码必须走 v_conv_real / v_mem_real / v_ep_real。"
  exit 1
}
Write-Host "[lint-namespace] OK"
exit 0
