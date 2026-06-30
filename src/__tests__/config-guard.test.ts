import { describe, it, expect } from 'vitest';
import { config } from '../config.js';

describe('[Config守卫] 顶层结构', () => {
  it('config 对象包含所有模块节', () => {
    const sections = ['paths','m1','m2','m3','m4','m5','m6','m7','m8','m9','maintenance','composer','bionic','tts','library'];
    for (const s of sections) expect(config).toHaveProperty(s);
  });

  it('所有配置值不为 undefined', () => {
    const check = (obj: Record<string,any>, path: string) => {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) check(v, `${path}.${k}`);
        else expect(v, `${path}.${k} 为 undefined`).not.toBeUndefined();
      }
    };
    check(config as any, 'config');
  });
});

describe('[Config守卫] M1-M9 参数完整性', () => {
  it('M1: taxonomyPath + selfModelPath', () => {
    expect(config.m1.taxonomyPath).toBeTypeOf('string');
    expect(config.m1.selfModelPath).toBeTypeOf('string');
  });

  it('M2: dbName + maxRecallCandidates + flushBatchSize + flushInterval', () => {
    expect(config.m2.dbName).toBeTypeOf('string');
    expect(config.m2.maxRecallCandidates).toBeTypeOf('number');
    expect(config.m2.flushBatchSize).toBeTypeOf('number');
    expect(config.m2.flushInterval).toBeTypeOf('number');
  });

  it('M3: hitReportEnabled', () => {
    expect(config.m3.hitReportEnabled).toBe(true);
  });

  it('M4: keywordSearchLimit + emotionalRetrievalLimit + seqRetrievalLimit + minStrength', () => {
    expect(config.m4.keywordSearchLimit).toBeGreaterThan(0);
    expect(config.m4.emotionalRetrievalLimit).toBeGreaterThan(0);
    expect(config.m4.seqRetrievalLimit).toBeGreaterThan(0);
    expect(config.m4.minStrength).toBeGreaterThanOrEqual(0);
  });

  it('M5: maxHistoryTurns + recentReplyPool + mockIntimacyBaseline + mockIntimacyIncrement', () => {
    expect(config.m5.maxHistoryTurns).toBeGreaterThan(0);
    expect(config.m5.recentReplyPool).toBeGreaterThan(0);
    expect(config.m5.mockIntimacyBaseline).toBeGreaterThanOrEqual(0);
    expect(config.m5.mockIntimacyIncrement).toBeGreaterThan(0);
  });

  it('M6: maintenanceInterval + minFeedbackCount + largeEvolutionDelta', () => {
    expect(config.m6.maintenanceInterval).toBeGreaterThan(0);
    expect(config.m6.minFeedbackCount).toBeGreaterThan(0);
    expect(config.m6.largeEvolutionDelta).toBeGreaterThan(0);
  });

  it('M7: batchInterval + maxDreamQueue + staleDays + batchThreshold + singleTimeoutHours', () => {
    expect(config.m7.batchInterval).toBeGreaterThan(0);
    expect(config.m7.maxDreamQueue).toBeGreaterThan(0);
    expect(config.m7.staleDays).toBeGreaterThan(0);
    expect(config.m7.batchThreshold).toBeGreaterThan(0);
    expect(config.m7.singleTimeoutHours).toBeGreaterThan(0);
  });

  it('M8: clueRetrievalLimit + keywordCandidates + healingDays', () => {
    expect(config.m8.clueRetrievalLimit).toBeGreaterThan(0);
    expect(config.m8.keywordCandidates).toBeGreaterThan(0);
    expect(config.m8.healingDays).toBeGreaterThan(0);
  });

  it('M9: maxBufferSize + flushInterval + graduateCycleMax + discardCycleMax + forceGraduateCycle', () => {
    expect(config.m9.maxBufferSize).toBeGreaterThan(0);
    expect(config.m9.flushInterval).toBeGreaterThan(0);
    expect(config.m9.graduateCycleMax).toBeGreaterThan(0);
    expect(config.m9.discardCycleMax).toBeGreaterThan(0);
    expect(config.m9.forceGraduateCycle).toBeGreaterThan(0);
  });

  it('maintenance: 全部 8 个参数', () => {
    const m = config.maintenance;
    expect(m.compactionInterval).toBeGreaterThan(0);
    expect(m.gcInterval).toBeGreaterThan(0);
    expect(m.decayInterval).toBeGreaterThan(0);
    expect(m.compactionThreshold).toBeGreaterThan(0);
    expect(m.keepFullTurns).toBeGreaterThan(0);
    expect(m.maxStorageRecords).toBeGreaterThan(0);
    expect(m.healthCheckInterval).toBeGreaterThan(0);
    expect(m.eventLoopWarnThreshold).toBeGreaterThan(0);
  });
});

describe('[Config守卫] 服务 API 地址', () => {
  it('谱曲引擎 (8100)', () => expect(config.composer.apiUrl).toContain('8100'));
  it('仿生智脑 (7200)', () => expect(config.bionic.apiUrl).toContain('7200'));
  it('TTS (8765)', () => expect(config.tts.apiUrl).toContain('8765'));
  it('太虚图书馆: port 3737', () => expect(config.library.port).toBe(3737));
});

describe('[Config守卫] 值合理性', () => {
  it('M9: graduateCycleMax < forceGraduateCycle', () => {
    expect(config.m9.graduateCycleMax).toBeLessThan(config.m9.forceGraduateCycle);
  });
  it('Maintenance: compactionThreshold > keepFullTurns', () => {
    expect(config.maintenance.compactionThreshold).toBeGreaterThan(config.maintenance.keepFullTurns);
  });
});
