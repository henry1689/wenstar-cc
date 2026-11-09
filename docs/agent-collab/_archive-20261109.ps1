# 协作区归档脚本 - 2026-11-09
# 规则：active/ 只放当下最新；已处理过的全部移入 09-archive（只有豆包读，CC/PI 不再读）
$ErrorActionPreference = 'Stop'

$src = "D:\tools\wenstar-cc\docs\agent-collab\active"
$dst = "D:\tools\wenstar-cc\docs\agent-collab\09-archive"

# 保留在 active 的（常驻规范，新窗口必读）
$keep = @(
    "00-PI新窗口交接备注-必读.md"
)

$files = Get-ChildItem $src -File | Where-Object { $keep -notcontains $_.Name }
Write-Output "== 准备归档 $($files.Count) 个文件，保留 $(($keep).Count) 个 =="
Write-Output ""

$moved = @()
$skipped = @()
foreach ($f in $files) {
    $target = Join-Path $dst $f.Name
    if (Test-Path -LiteralPath $target) {
        $skipped += $f.Name
        Write-Output "[SKIP-同名] $($f.Name)"
    } else {
        Move-Item -LiteralPath $f.FullName -Destination $target
        $moved += $f.Name
    }
}

Write-Output ""
Write-Output "已移动: $($moved.Count)"
Write-Output "跳过(同名): $($skipped.Count)"
Write-Output ""
Write-Output "== 移动清单 =="
$moved | ForEach-Object { Write-Output "  $_" }
Write-Output ""
Write-Output "== active 剩余 =="
Get-ChildItem $src -File | ForEach-Object { Write-Output "  $($_.Name)" }
Write-Output ""
Write-Output "active 剩余数: $((Get-ChildItem $src -File).Count)"
Write-Output "archive 总数:   $((Get-ChildItem $dst -File).Count)"
