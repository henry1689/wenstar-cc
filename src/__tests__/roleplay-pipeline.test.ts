import { describe, it, expect } from 'vitest';
import { clearAllTempProfiles, updateTempProfile, extractInfoPoints, getOrCreateTempProfile } from '../app/roleplay/RoleplayProfileManager.js';
import { collectData } from '../app/roleplay/DataCollector.js';
import type { FourLayerData } from '../app/roleplay/DataCollector.js';

describe('角色扮演域', () => {
  describe('三阶生长', () => {
    it('临时建档', () => {
      clearAllTempProfiles();
      const p = getOrCreateTempProfile('测试角色');
      expect(p.name).toBe('测试角色');
      expect(p.stage).toBe('probation');
      clearAllTempProfiles();
    });
    it('信息点提取：年龄', () => {
      clearAllTempProfiles();
      const points = extractInfoPoints('诗韵', '诗韵才14岁', '', 1);
      const age = points.find(p => p.field === 'age');
      expect(age?.value).toBe('14岁');
      clearAllTempProfiles();
    });
    it('轮次递增', () => {
      clearAllTempProfiles();
      const p1 = updateTempProfile('测试', '你好', '', 1);
      expect(p1.turnCount).toBe(1);
      const p2 = updateTempProfile('测试', '你好', '', 2);
      expect(p2.turnCount).toBe(2);
      clearAllTempProfiles();
    });
  });

  describe('DataCollector 结构', () => {
    it('FourLayerData 类型有正确的层级', () => {
      const data: FourLayerData = {
        layer1: { identity: '测试', ageGuard: '' },
        layer2: { relations: '测试关系', relationState: '' },
        layer3: { history: [], goldMemories: [], diamondMemories: [] },
        layer4: { kbEntries: [] },
        entities: [], kinshipTerms: [], pronounTarget: null,
        rawFgTree: '',
      };
      expect(data.layer1.identity).toBe('测试');
      expect(data.layer2.relations).toBe('测试关系');
      expect(Array.isArray(data.layer3.history)).toBe(true);
      expect(Array.isArray(data.layer4.kbEntries)).toBe(true);
    });
  });
});
