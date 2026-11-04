# rollback.ps1 — 一键回滚到旧系统
# 三层回滚：①业务层切流量 ②软删迁移数据 ③恢复备份

param(
  [Parameter(Mandatory=$true)] [string]$Mode,
  [string]$NewDb
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot\..

switch ($Mode) {
  'traffic' {
    # 第一层：业务层切流量（最快，秒级）
    Write-Host "[回滚 1/3] 业务层切流量：所有角色切回旧系统" -ForegroundColor Yellow
    npx ts-node -e "
      import { globalFeatureFlag } from './src/core/FeatureFlag.js';
      globalFeatureFlag.rollback();
      console.log('KILL SWITCH ON — 全量走旧系统');
    "
    Write-Host "✅ 已切回旧系统（数据未动，可随时 unrollback 切回）" -ForegroundColor Green
  }
  'soft' {
    if (-not $NewDb) { Write-Error "软回滚需要 -NewDb"; exit 1 }
    Write-Host "[回滚 2/3] 软删除新库迁移数据" -ForegroundColor Yellow
    npx ts-node -e "
      import { Rollback } from './src/migration/Rollback.js';
      import Database from 'better-sqlite3';
      const db = new Database('$NewDb');
      const rb = new Rollback(db);
      const r = rb.softRollback();
      console.log('已删除', r.deleted, '条迁移数据');
    "
  }
  'hard' {
    if (-not $NewDb) { Write-Error "硬回滚需要 -NewDb"; exit 1 }
    # 找最新备份
    $bak = Get-ChildItem "$NewDb.bak.*" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $bak) { Write-Error "找不到备份文件"; exit 1 }
    Write-Host "[回滚 3/3] 硬恢复：用 $($bak.Name) 覆盖新库" -ForegroundColor Yellow
    Copy-Item $bak.FullName $NewDb -Force
    Write-Host "✅ 新库已恢复到迁移前状态" -ForegroundColor Green
  }
}
