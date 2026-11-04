# run-migration.ps1 — 旧库 → 新库 数据迁移一键脚本
# 用法: .\scripts\run-migration.ps1 -OldDb ..\data\old-memory.db -NewDb ..\data\memarch-v2.db

param(
  [Parameter(Mandatory=$true)] [string]$OldDb,
  [Parameter(Mandatory=$true)] [string]$NewDb,
  [switch]$DryRun,
  [int]$BatchSize = 1000
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot\..

Write-Host "=== MemArch v2 数据迁移 ===" -ForegroundColor Cyan
Write-Host "旧库: $OldDb"
Write-Host "新库: $NewDb"

# 1. 备份旧库
$bak = "$OldDb.bak.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $OldDb $bak
Write-Host "[1/5] 旧库已备份到 $bak" -ForegroundColor Green

# 2. 检查新库 DDL 是否就绪
if (-not (Test-Path $NewDb)) {
  Write-Error "新库 $NewDb 不存在，请先跑 M1 DDL"
  exit 1
}
Write-Host "[2/5] 新库就绪" -ForegroundColor Green

# 3. 跑迁移
Write-Host "[3/5] 开始迁移..." -ForegroundColor Yellow
npx ts-node -e "
import { Migrator } from './src/migration/Migrator.js';
import Database from 'better-sqlite3';
const oldDb = new Database('$OldDb', { readonly: true });
const newDb = new Database('$NewDb');
const m = new Migrator(oldDb, newDb, {
  oldDbPath: '$OldDb',
  newDbPath: '$NewDb',
  personaToNamespace: { '玉瑶': 'ns_yuyao', '诗雨': 'ns_shiyu', '王全芬': 'ns_wangquanfen' },
  batchSize: $BatchSize,
  dryRun: $($DryRun.IsPresent.ToString().ToLower()),
});
m.run().then(r => {
  console.table(r);
  oldDb.close(); newDb.close();
});
"

Write-Host "[4/5] 迁移完成" -ForegroundColor Green

# 4. 跑校验
Write-Host "[5/5] 开始端到端校验..." -ForegroundColor Yellow
npx ts-node -e "
import { E2EVerifier } from './src/verification/E2EVerifier.js';
import Database from 'better-sqlite3';
const db = new Database('$NewDb', { readonly: true });
const v = new E2EVerifier(db);
v.runAll().then(r => { console.table(r); process.exit(r.every(x=>x.pass)?0:1); });
"

Write-Host "=== 完成 ===" -ForegroundColor Cyan
