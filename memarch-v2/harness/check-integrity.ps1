# MemArch-v2 完整性巡检脚本
# 用途：Harness 每日三时段巡检（10:30 / 17:00 / 23:00）
# 检查项：核心文件只读属性、旧数据库只读状态
# 异常输出：ALERT: 后面跟异常详情

$ErrorActionPreference = "Continue"
$baseDir = "D:\tools\wenstar-cc\memarch-v2"
$governanceDir = "D:\tools\wenstar-cc\governance"

$alerts = @()

# 1. 检查核心文件只读属性
$coreFiles = @(
    "$baseDir\storage\ddl\01_schema_init.sql",
    "$baseDir\storage\ddl\02_indexes.sql",
    "$baseDir\storage\ddl\03_fts5.sql",
    "$baseDir\storage\ddl\04_vector_index.sql",
    "$baseDir\storage\ddl\05_views.sql",
    "$baseDir\storage\write_queue\WriteQueue.ts",
    "$baseDir\online_write\MemoryWriter.ts",
    "$baseDir\online_write\WorkingMemory.ts",
    "$baseDir\online_write\EventSegmenter.ts",
    "$baseDir\online_write\Gate.ts",
    "$baseDir\online_write\SalienceCalculator.ts",
    "$baseDir\online_write\ProspectiveExtractor.ts",
    "$baseDir\online_write\config.ts",
    "$baseDir\online_write\types.ts",
    "$baseDir\online_write\index.ts",
    "$baseDir\sleep_consolidation\pipeline\SleepOrchestrator.ts",
    "$baseDir\sleep_consolidation\pipeline\Step1_ScanPending.ts",
    "$baseDir\sleep_consolidation\pipeline\Step2_SealEpisodes.ts",
    "$baseDir\sleep_consolidation\pipeline\Step3_ReevalRawOnly.ts",
    "$baseDir\sleep_consolidation\pipeline\Step4_ScoreSalienceLLM.ts",
    "$baseDir\sleep_consolidation\pipeline\Step5_BuildReplaySet.ts",
    "$baseDir\sleep_consolidation\pipeline\Step6_MergeDedupe.ts",
    "$baseDir\sleep_consolidation\pipeline\Step7_ExtractSemantic.ts",
    "$baseDir\sleep_consolidation\pipeline\Step8_ResolveTemporal.ts",
    "$baseDir\sleep_consolidation\pipeline\Step9_PromoteLifecycle.ts",
    "$baseDir\sleep_consolidation\pipeline\Step10_PurgeTombstones.ts",
    "$baseDir\sleep_consolidation\pipeline\StepBase.ts",
    "$baseDir\sleep_consolidation\pipeline\index.ts",
    "$baseDir\retrieval\index.ts",
    "$baseDir\retrieval\types.ts",
    "$baseDir\presentation\router.ts",
    "$baseDir\presentation\labeler.ts",
    "$baseDir\presentation\outputGuard.ts",
    "$baseDir\presentation\attributor.ts",
    "$baseDir\presentation\reconsolidate.ts",
    "$baseDir\presentation\downgrade.ts",
    "$baseDir\presentation\config.ts",
    "$baseDir\presentation\types.ts",
    "$baseDir\presentation\index.ts",
    "$governanceDir\src\accessControl.ts",
    "$governanceDir\src\auditLog.ts",
    "$governanceDir\src\policyEngine.ts",
    "$governanceDir\src\integrityCheck.ts",
    "$governanceDir\src\securityConfig.ts",
    "$governanceDir\src\index.ts"
)

foreach ($file in $coreFiles) {
    if (Test-Path $file) {
        $item = Get-Item $file
        if (-not $item.IsReadOnly) {
            $alerts += "ALERT: 核心文件只读属性被篡改: $file"
        }
    } else {
        $alerts += "ALERT: 核心文件丢失: $file"
    }
}

# 2. 检查旧数据库是否仍然只读
$oldDb = "D:\tools\wenstar-cc\data\webui\fusion_memory.db"
if (Test-Path $oldDb) {
    $item = Get-Item $oldDb
    if (-not $item.IsReadOnly) {
        $alerts += "ALERT: 旧数据库只读属性被解除，可能有旧链路写入!"
    }
}

# 输出结果
if ($alerts.Count -eq 0) {
    Write-Output "OK: MemArch-v2 完整性巡检通过，所有核心文件完好"
} else {
    Write-Output "=== 巡检告警 ==="
    foreach ($alert in $alerts) {
        Write-Output $alert
    }
    exit 1
}
