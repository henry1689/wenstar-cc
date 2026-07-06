/**
 * FamilyGraphAdapter — 家族图谱适配器
 *
 * 补充3个适配点，FG底层能力不变：
 *   1. 角色扮演数据隔离
 *   2. 批量亲属档案封装
 *   3. 年龄/字段标准化
 */
import type { PersonStructProfile } from './types.js';

export interface RelativeProfileResult {
  rootProfile: PersonStructProfile;
  relatives: PersonStructProfile[];
  knownFields: Record<string, boolean>;
}

export class FamilyGraphAdapter {
  private fg: any;
  /** 📜 主FG引用（不受override影响，用于全局查询如getRelatedPersonsN） */
  private mainFg: any;
  public roleplayId: string;
  public source: 'roleplay' | 'main';

  constructor(fg: any, roleplayId: string, mainFg?: any) {
    this.fg = fg;
    this.mainFg = mainFg || fg;
    this.roleplayId = roleplayId;
    this.source = 'roleplay';
  }

  getPersonProfile(personName: string): PersonStructProfile | null {
    // 📜 信息权威铁律: 优先from FG override（角色分支），降级到主FG
    const raw = this.fg?.getPersonProfile?.(personName) || this.mainFg?.getPersonProfile?.(personName);
    if (!raw) return null;
    return mapProfile(raw);
  }

  getFullProfile(personName: string): any | null {
    if (!this.fg?.getFullProfile) return null;
    try { return this.fg.getFullProfile(personName); } catch { return null; }
  }

  async listRelativeProfiles(rootName: string, maxHop = 1, rpBranch?: any): Promise<RelativeProfileResult> {
    const rootProfile = this.getPersonProfile(rootName) || {
      name: rootName, hasProfile: false, knownFields: {},
    } as PersonStructProfile;

    const relatives: PersonStructProfile[] = [];
    const knownFields: Record<string, boolean> = { ...rootProfile.knownFields };

    // 📜 信息权威铁律: 合并两个数据源
    // 1. rpBranch（角色视角，可能不全）
    // 2. mainFg（主FG全局N跳遍历，绕过override）
    const nameSet = new Set<string>();
    if (rpBranch && typeof rpBranch.getAllNames === 'function') {
      for (const n of rpBranch.getAllNames() || []) {
        if (n !== rootName && n !== '我') nameSet.add(n);
      }
    }
    if (this.mainFg?.getRelatedPersonsN) {
      try {
        const related = this.mainFg.getRelatedPersonsN([rootName], maxHop as 1|2|3, 0.3);
        for (const r of related || []) {
          if (r.name !== rootName && r.name !== '我') nameSet.add(r.name);
        }
      } catch (e: any) {
        console.log('[📜S] getRelatedPersonsN失败: ' + (e?.message || 'unknown'));
      }
    }
    const relativeNames = [...nameSet];
    console.log('[📜listRelativeProfiles] root=' + rootName + ' found ' + relativeNames.length + ' relatives: ' + JSON.stringify(relativeNames));

    for (const name of relativeNames) {
      if (name === rootName || name === '我') continue;
      // 📜 信息权威铁律·等级S: 优先从rpBranch视角获取画像
      // 但rpBranch可能不含该人物（分支隔离限制），此时降级到主FG
      const raw = rpBranch?.getPersonProfile?.(name) || this.mainFg?.getPersonProfile?.(name);
      if (raw) {
        const p = mapProfile(raw);
        if (!p.relation && rpBranch?.getRelationToRoot) {
          p.relation = rpBranch.getRelationToRoot(name) || 'known';
        }
        relatives.push(p);
        // 📜 记录数据来源：来自rpBranch还是主FG降级
        if (!rpBranch?.getPersonProfile?.(name) && this.mainFg?.getPersonProfile?.(name)) {
          console.log('[📜S→FG降级] ' + name + ' 不在角色分支中，从主FG获取画像');
        }
        for (const [k, v] of Object.entries(p.knownFields)) {
          if (v) knownFields[k] = true;
        }
      } else {
        console.log('[📜S] ' + name + ' 在rpBranch和主FG都无画像');
      }
    }
    knownFields.hasRelatives = relatives.length > 0;
    return { rootProfile, relatives, knownFields };
  }

  getCircleLevel(personName: string): number {
    if (!this.fg?.getCircleLevel) return 0;
    try { return this.fg.getCircleLevel(personName); } catch { return 0; }
  }

  getEffectiveIntimacy(nameA: string, nameB: string): number {
    if (!this.fg?.getEffectiveIntimacy) return 0;
    try { return this.fg.getEffectiveIntimacy(nameA, nameB); } catch { return 0; }
  }

  updateInteractionFreq(sourceName: string, targetName: string): void {
    if (!this.fg?.updateInteractionFreq) return;
    try { this.fg.updateInteractionFreq(sourceName, targetName); } catch {}
  }

  /** 构建家庭关系网：亲属之间的关联描述 */
  buildFamilyWeb(relatives: PersonStructProfile[], roleplay: string): string[] {
    if (!this.fg?.findEdge) return [];
    const lines: string[] = [];
    const allNames = [roleplay, ...relatives.map(r => r.name)];
    const relMap: Record<string, string> = {
      mother_of: '母亲', father_of: '父亲', spouse_of: '配偶',
      sibling_of: '兄弟姐妹', child_of: '孩子', parent_of: '父母',
      aunt_of: '姑姑', cousin_of: '表亲', niece_of: '侄女',
    };
    for (let i = 0; i < allNames.length; i++) {
      for (let j = i + 1; j < allNames.length; j++) {
        try {
          const edge = this.fg.findEdge(allNames[i], allNames[j]);
          if (!edge) continue;
          const label = relMap[edge.relation] || edge.relation;
          if (edge.relation === 'sibling_of') {
            lines.push(allNames[i] + '和' + allNames[j] + '是' + label);
          } else {
            lines.push(allNames[i] + '是' + allNames[j] + '的' + label);
          }
        } catch {}
      }
    }
    return lines;
  }

  getAllPersonNames(): string[] {
    if (!this.fg?.getAllPersonNames) return [];
    try { return this.fg.getAllPersonNames() as string[]; } catch { return []; }
  }
}

// 适配点3：PersonProfile → PersonStructProfile 映射
export function mapProfile(raw: any): PersonStructProfile {
  let age: number | undefined = undefined;
  if (raw.age !== undefined && raw.age !== null) age = Number(raw.age);
  if (age === undefined && raw.dossier?.basicInfo?.birthYear) {
    age = new Date().getFullYear() - raw.dossier.basicInfo.birthYear;
  }
  if (age === undefined && raw.pendingItems?.length) {
    for (const item of raw.pendingItems) {
      if (item.field === 'basicInfo.birthYear') {
        const by = parseInt(item.value);
        if (!isNaN(by)) age = new Date().getFullYear() - by;
      }
    }
  }
  const knownFields: Record<string, boolean> = {};
  if (age !== undefined) knownFields.age = true;
  if (raw.occupation) knownFields.occupation = true;
  if (raw.personality || (raw.traits?.length > 0)) knownFields.personality = true;
  if (raw.appearance) knownFields.appearance = true;
  if (raw.dossier?.basicInfo?.birthYear) knownFields.birth = true;

  return {
    name: raw.name || '',
    age,
    birth: raw.dossier?.basicInfo?.birthYear?.toString(),
    occupation: raw.occupation,
    personality: raw.personality ? [raw.personality] : (raw.traits || []),
    traits: raw.traits || [],
    appearance: raw.appearance || raw.body_features,
    interests: raw.interests || [],
    habits: raw.habits,
    voice: raw.voice,
    description: raw.description,
    relation_to_user: raw.relation_to_user,
    relation: raw.relation,
    hasProfile: true,
    knownFields,
  };
}
