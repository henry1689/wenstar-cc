/**
 * FamilyGraphRoleBranch — 家族图谱角色扮演分支系统
 *
 * 核心原理：角色扮演时，FG 的身份根从「我」(鸿艺) 切换到被扮演角色。
 * 整个分支就是一个固定不变的「角色家族树快照」，在扮演期间完全替代主 FG。
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  主FG (正常)                   角色分支 (扮演熊梓铭时)       │
 * │  根 = 我(鸿艺)                  根 = 熊梓铭                  │
 * │  我--[spouse_of]-->玉瑶         熊梓铭--[child_of]-->熊勇   │
 * │  我--[parent_of]-->熊梓铭       熊梓铭--[child_of]-->王全芬 │
 * │  熊梓铭--[child_of]-->熊勇      ↳ 成为「我的爸爸 = 熊勇」  │
 * │  熊梓铭--[child_of]-->王全芬    ↳ 成为「我的妈妈 = 王全芬」│
 * └─────────────────────────────────────────────────────────────┘
 *
 * 使用方式：
 *   1. 扮演开始时：branch = new FamilyGraphRoleBranch(fg, '熊梓铭')
 *   2. 全量加载角色家族树到 branch 内部
 *   3. 所有 FG 查询通过 branch 进行，身份根永远是角色
 *   4. 扮演结束时：丢弃 branch，恢复主 FG
 *
 * 集成点：
 *   - chat.ts 中 _currentRoleplay 创建/销毁时同步创建/销毁 branch
 *   - M4/M5 通过 ctx.m4.getFamilyGraph() 获取的是 branch（而非主FG）
 *   - 主FG写入不受影响（integrateFromEntity 仍走主FG）
 */

import type { FamilyGraph as FamilyGraphType } from '../../m4/types/graph.js';

// ─── 局部类型（从 FamilyGraph 镜像） ────────────────

interface PersonProfile {
  name: string;
  relation_to_user: string;
  last_mentioned: string;
  mention_count: number;
  appearance?: string;
  body_features?: string;
  style?: string;
  traits?: string[];
  personality?: string;
  occupation?: string;
  interests?: string[];
  habits?: string;
  psychology?: string;
  voice?: string;
  description?: string;
  [key: string]: any;
}

// ─── 角色家族树节点 ──────────────────────────────

interface BranchPerson {
  name: string;
  profile: PersonProfile | null;
  relations: BranchRelation[];
}

interface BranchRelation {
  relation: string;     // mother_of, father_of, sibling_of, spouse_of, child_of
  direction: 'outgoing' | 'incoming';
  personName: string;
}

// ─── 分支类 ──────────────────────────────────────

export class FamilyGraphRoleBranch {
  /** 主 FG 引用（只读 — 分支不修改主 FG） */
  private fg: FamilyGraphType;
  /** 被扮演的角色名称 */
  readonly rootName: string;
  /** 分支的家族树：角色相关的所有人（含角色自己） */
  private persons: Map<string, BranchPerson> = new Map();
  /** 角色对自己的家族关系摘要（预编译缓存） */
  private _familySummary: string = '';
  /** 分支是否已就绪 */
  private _ready: boolean = false;

  constructor(fg: FamilyGraphType, rootName: string) {
    this.fg = fg;
    this.rootName = rootName;
  }

  /**
   * 初始化分支：全量加载角色家族树
   * 以角色为根，BFS 加载所有关联人物 + 他们的关系 + 他们的画像
   */
  async initialize(): Promise<void> {
    this.persons.clear();

    // 1. 加载角色本人的画像
    const rootProfile = (this.fg as any).getPersonProfile(this.rootName);
    this.persons.set(this.rootName, {
      name: this.rootName,
      profile: rootProfile,
      relations: [],
    });

    // 2. BFS 加载所有关联人物（深度1，只加载直系亲属，防止内存过大）
    const visited = new Set<string>([this.rootName]);
    const queue: string[] = [this.rootName];
    const MAX_DEPTH = 1;

    for (let depth = 0; depth < MAX_DEPTH && queue.length > 0; depth++) {
      const levelSize = queue.length;
      for (let i = 0; i < levelSize; i++) {
        const currentName = queue.shift()!;
        try {
          // 查找所有关系边
          const graphResults = await (this.fg as any).findRelated(currentName);
          if (!graphResults || graphResults.length === 0) continue;

          for (const gr of graphResults) {
            if (!gr.relationships) continue;
            for (const rel of gr.relationships) {
              const tgtName = rel.targetNode?.name;
              if (!tgtName || tgtName === currentName) continue;

              // 构建关系（两边都要记录）
              let bp = this.persons.get(currentName);
              if (!bp) {
                bp = {
                  name: currentName,
                  profile: (this.fg as any).getPersonProfile(currentName),
                  relations: [] as BranchRelation[],
                };
                this.persons.set(currentName, bp);
              }
              bp.relations.push({
                relation: rel.relation,
                direction: rel.direction as 'outgoing' | 'incoming',
                personName: tgtName,
              });

              // 如果目标人还没加载，加入队列
              if (!visited.has(tgtName)) {
                visited.add(tgtName);
                const tgtProfile = (this.fg as any).getPersonProfile(tgtName);
                this.persons.set(tgtName, {
                  name: tgtName,
                  profile: tgtProfile,
                  relations: [],
                });
                // 记录反向关系
                const tgtBp = this.persons.get(tgtName)!;
                const revRel = FamilyGraphRoleBranch.reverseRelation(rel.relation);
                tgtBp.relations.push({
                  relation: revRel,
                  direction: rel.direction === 'outgoing' ? 'incoming' as const : 'outgoing' as const,
                  personName: currentName,
                });
                queue.push(tgtName);
              }
            }
          }
        } catch (_) { /* 单个节点失败不影响整体 */ }
      }
    }

    // 3. 构建角色家族关系摘要
    this._familySummary = this._buildFamilySummary();

    // 4. 将角色标记为「自己」而非其他人
    const rootPerson = this.persons.get(this.rootName);
    if (rootPerson && rootPerson.profile) {
      rootPerson.profile.relation_to_user = '自己';
    }

    this._ready = true;
    console.log(`[FGRoleBranch] 🎭 分支建立: 「${this.rootName}」的家族树 (${this.persons.size}人, ${this.countEdges()}条关系)`);
  }

  /** 分支是否已就绪 */
  get ready(): boolean { return this._ready; }

  /** 获取家族树中的所有人名 */
  getAllNames(): string[] {
    return Array.from(this.persons.keys());
  }

  /** 获取家族树人数 */
  get size(): number { return this.persons.size; }

  // ════════════════════════════════════════════════
  // 核心查询接口
  // ════════════════════════════════════════════════

  /**
   * 获取角色家族树中某人的画像
   * 🔴 铁律：分支中不存在的角色绝不从主FG补充加载。
   *   ——否则用户问"梓铭是谁"时，诗韵视角会泄漏主FG中梓铭的数据。
   *   只有在以下情况才返回数据：
   *   a) 该人物在分支的家族树中（角色认识的人）
   *   b) 该人物通过 integrateFromEntity 被用户明确提及并加入分支
   */
  getPersonProfile(name: string): PersonProfile | null {
    const bp = this.persons.get(name);
    if (bp?.profile) return bp.profile;
    // 🚫 分支中没有，不返回主FG数据——防泄漏
    return null;
  }

  /**
   * 获取某人从角色视角看的关系描述
   * 例如「熊梓铭」视角看「熊勇」→ "爸爸"
   */
  getRelationToRoot(name: string): string {
    if (name === this.rootName) return '自己';
    const bp = this.persons.get(name);
    if (!bp) return '';

    const labels: string[] = [];
    for (const rel of bp.relations) {
      const label = FamilyGraphRoleBranch.relationToLabel(rel.relation, rel.direction, rel.personName);
      if (label) labels.push(label);
    }
    return labels.join('、') || '认识的人';
  }

  /**
   * 判断某人是否在角色的家族树中
   */
  isInFamily(name: string): boolean {
    return this.persons.has(name);
  }

  /**
   * 判断某人是否角色的直系亲属
   */
  isImmediateFamily(name: string): boolean {
    const bp = this.persons.get(name);
    if (!bp) return false;
    return bp.relations.some(r =>
      ['mother_of', 'father_of', 'sibling_of', 'spouse_of', 'child_of'].includes(r.relation)
    );
  }

  /**
   * 获取分支内所有的亲属关系文本
   * 用于注入LLM上下文
   */
  getFamilyTreeText(): string {
    if (!this._ready) return '';
    return this._familySummary;
  }

  /**
   * 根据亲属称呼解析角色视角下的具体人名
   * 例：(「妈妈」, 熊梓铭视角) → 「王全芬」
   *     (「姐姐」, 徐诗韵视角) → 「徐诗雨」
   *
   * 🔴 姊妹类兼容：relationToLabel 输出「兄弟姐妹」，但用户可能说「姐姐」「妹妹」「哥哥」「弟弟」。
   *    只要 kinshipTerm 包含「姐」「妹」「哥」「弟」之一，且关系是 sibling_of，就匹配。
   */
  resolveKinship(kinshipTerm: string): string[] {
    const results: string[] = [];
    const rootRelations = this.persons.get(this.rootName)?.relations || [];

    // 判断当前称呼是否属于姊妹类
    const isSiblingLike = /姐|妹|哥|弟/.test(kinshipTerm);

    for (const rel of rootRelations) {
      const label = FamilyGraphRoleBranch.relationToLabel(rel.relation, rel.direction, rel.personName);
      if (!label) continue;
      // 精确匹配（妈妈→妈妈）
      if (label.includes(kinshipTerm)) {
        results.push(rel.personName);
        continue;
      }
      // 姊妹类模糊匹配：用户说「姐姐」但 label 是「兄弟姐妹」，同样匹配
      if (isSiblingLike && rel.relation === 'sibling_of') {
        results.push(rel.personName);
      }
    }
    return results;
  }

  // ════════════════════════════════════════════════
  // M4 集成接口（角色扮演时代替主 FG 被 M4Orchestrator 调用）
  // ════════════════════════════════════════════════

  /**
   * 角色扮演版 integrateFromEntity
   * 将对话中提及的人物实体写入分支内存而非主 FG SQLite。
   * 退出角色扮演时分支销毁，这些数据自动消失，不污染主 FG。
   */
  async integrateFromEntity(entities: Array<{ name: string; type: string }>, rawInput: string, selfName?: string): Promise<{ nodes_created: number; edges_created: number; details: string[] }> {
    const details: string[] = [];
    let nodesCreated = 0;

    for (const entity of entities) {
      if (entity.type !== 'person') continue;
      const name = entity.name;
      if (name === '我' || name === this.rootName) continue;
      if (this.persons.has(name)) continue; // 已在分支中，无需重复加载

      // 新人名：只从主FG补充加载主FG中已有的profile
      // 🔴 不加载关系边——避免主FG中梓铭→熊勇的关系泄漏到诗韵视角
      const mainProfile = (this.fg as any).getPersonProfile(name);
      if (mainProfile) {
        this.persons.set(name, { name, profile: mainProfile, relations: [] });
        nodesCreated++;
        details.push(`从主FG补充: ${name}`);
        console.log(`[FGRoleBranch] 补充人物「${name}」到角色「${this.rootName}」的分支（仅画像，无关系边）`);
      } else {
        // 主 FG 中也没有 → 新建一个占位节点
        this.persons.set(name, {
          name,
          profile: { name, relation_to_user: '', last_mentioned: '', mention_count: 0 },
          relations: [],
        });
        nodesCreated++;
        details.push(`新建分支节点: ${name}`);
        console.log(`[FGRoleBranch] 新建角色「${this.rootName}」的新关系人「${name}」`);
      }
    }

    return { nodes_created: nodesCreated, edges_created: 0, details };
  }

  /**
   * 角色扮演版 getFamilySummary
   * 以角色为根，返回分支中所有家族成员的摘要
   */
  async getFamilySummary(): Promise<{ members: Array<{ name: string; relation_to_user: string; aliases: string[] }>; locations: string[] }> {
    const members: Array<{ name: string; relation_to_user: string; aliases: string[] }> = [];
    for (const [name, bp] of this.persons) {
      if (name === this.rootName) continue;
      const relationLabel = this.getRelationToRoot(name);
      members.push({
        name,
        relation_to_user: relationLabel || '认识的人',
        aliases: [],
      });
    }
    return { members, locations: [] };
  }

  /**
   * 角色扮演版 getSocialSummary
   * 返回空（角色扮演只关注家族关系，社交关系由主FG管理）
   */
  async getSocialSummary(): Promise<{ connections: Array<{ name: string; relation_to_user: string; note?: string }> }> {
    return { connections: [] };
  }

  // ════════════════════════════════════════════════
  // 内部方法
  // ════════════════════════════════════════════════

  /** 预编译家族关系摘要文本 */
  private _buildFamilySummary(): string {
    const lines: string[] = [];
    const rootRels = this.persons.get(this.rootName)?.relations || [];

    // 按关系类型分组
    const groups: Record<string, string[]> = {};
    for (const rel of rootRels) {
      const label = FamilyGraphRoleBranch.relationToLabel(rel.relation, rel.direction, rel.personName);
      if (!label) continue;
      if (!groups[label]) groups[label] = [];
      if (!groups[label].includes(rel.personName)) groups[label].push(rel.personName);
    }

    // 按亲属 > 社交 > 其他的顺序输出
    const order = ['爸爸', '妈妈', '父亲', '母亲', '丈夫', '妻子', '老公', '老婆',
      '哥哥', '弟弟', '姐姐', '妹妹', '儿子', '女儿', '爷爷', '奶奶'];
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const key of order) {
      if (groups[key]) {
        ordered.push(key + '：' + groups[key].join('、'));
        seen.add(key);
      }
    }
    // 剩余的关系
    for (const [key, names] of Object.entries(groups)) {
      if (!seen.has(key)) {
        ordered.push(key + '：' + names.join('、'));
      }
    }

    if (ordered.length > 0) {
      lines.push('【' + this.rootName + '的家族关系（角色扮演模式）】');
      lines.push('你现在是「' + this.rootName + '」，以下是你视角下的家人/社交关系：');
      for (const item of ordered) {
        lines.push('  - 我的' + item);
      }
      lines.push('');
      lines.push('🔴 记住：你扮演的是「' + this.rootName + '」，不是玉瑶。');
      lines.push('🔴 以下称呼是以「' + this.rootName + '」的身份来说的：');
      for (const item of ordered) {
        const firstColon = item.indexOf('：');
        if (firstColon > 0) {
          const relName = item.substring(0, firstColon);
          const personName = item.substring(firstColon + 1);
          lines.push('  - ' + personName + '是你的' + relName);
        }
      }
    }

    // 如果角色有画像描述，附上
    const rootProfile = this.persons.get(this.rootName)?.profile;
    if (rootProfile?.description) {
      lines.push('\n📋 ' + this.rootName + '简介：' + rootProfile.description);
    }

    return lines.join('\n');
  }

  private countEdges(): number {
    let count = 0;
    for (const bp of this.persons.values()) {
      count += bp.relations.length;
    }
    return count / 2; // 每条边被双向记录了
  }

  // ─── 静态工具 ──────────────────────────────────

  /** 关系类型 → 中文称呼（从角色视角） */
  static relationToLabel(relation: string, direction: 'outgoing' | 'incoming', personName?: string): string {
    // outgoing = 角色 → 别人, incoming = 别人 → 角色
    // 🔴 兄弟姐妹类输出多种标签（姐姐/妹妹/哥哥/弟弟），方便 resolveKinship 匹配任意称呼
    const MAP: Record<string, [string, string]> = {
      mother_of:    ['妈妈', '孩子'],
      father_of:    ['爸爸', '孩子'],
      parent_of:    ['父母', '孩子'],
      child_of:     ['孩子', '父母'],
      spouse_of:    ['配偶', '配偶'],
      sibling_of:   ['兄弟姐妹', '兄弟姐妹'],
      grandparent_of: ['(外)祖父母', '(外)孙子女'],
      grandchild_of:  ['(外)孙子女', '(外)祖父母'],
      sibling_in_law: ['姻亲兄弟姐妹', '姻亲兄弟姐妹'],
      acquaintance_of: ['认识的人', '认识的人'],
      friend_of:    ['朋友', '朋友'],
      colleague_of: ['同事', '同事'],
      classmate_of: ['同学', '同学'],
      boss_of:      ['上司', '下属'],
      subordinate_of: ['下属', '上司'],
      client_of:    ['客户', '服务方'],
      neighbor_of:  ['邻居', '邻居'],
    };
    const pair = MAP[relation];
    if (!pair) return relation.replace(/_/g, '/');
    return direction === 'outgoing' ? pair[0] : pair[1];
  }

  /** 获取反向关系 */
  static reverseRelation(relation: string): string {
    const REV: Record<string, string> = {
      mother_of: 'child_of', father_of: 'child_of', parent_of: 'child_of',
      child_of: 'parent_of', spouse_of: 'spouse_of', sibling_of: 'sibling_of',
      grandparent_of: 'grandchild_of', grandchild_of: 'grandparent_of',
      acquaintance_of: 'acquaintance_of', friend_of: 'friend_of',
      colleague_of: 'colleague_of', classmate_of: 'classmate_of',
      boss_of: 'subordinate_of', subordinate_of: 'boss_of',
      client_of: 'server_of', neighbor_of: 'neighbor_of',
    };
    return REV[relation] || relation;
  }
}
