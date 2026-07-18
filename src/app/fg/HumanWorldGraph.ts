/**
 * HumanWorldGraph.ts — 人类世界关系神经网络核心引擎
 * ====================================================
 * 包装 FamilyGraph，扩展六大类关系、时序管理、事件驱动画像迭代、
 * 身份隔离守卫、渐进认知追踪。不改动 FamilyGraph 一行代码。
 *
 * 使用:
 *   const hwg = new HumanWorldGraph(familyGraph, sqlite);
 *   await hwg.enhanceFromConversation(personName, '我妈妈', rawInput);
 *   const network = hwg.getNetwork('张忠谋');
 */
import type { FamilyGraph } from '../../m4/household/FamilyGraph.js';
import type { SQLiteAdapter } from '../../m2/SQLiteAdapter.js';
import {
  RELATION_TYPE_DEFS, RELATION_CATEGORY, getRelationCategory,
  describeRelation, CONFIDENCE, LIFE_STAGE, PERSON_STATUS, EVENT_TYPE,
  type RelationTypeDef,
} from './RelationshipTypes.js';
import { ProgressiveProfile } from './ProgressiveProfile.js';
import { PersonTimeline } from './PersonTimeline.js';
import { KnowledgeBridge } from './KnowledgeBridge.js';

const FG_EXTRA_TABLE = `
CREATE TABLE IF NOT EXISTS hwg_persons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  stage TEXT DEFAULT 'unknown',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  mention_count INTEGER DEFAULT 1,
  extra_data TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS hwg_relations (
  id TEXT PRIMARY KEY,
  person_a TEXT NOT NULL,
  person_b TEXT NOT NULL,
  relation TEXT NOT NULL,
  category TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  source TEXT DEFAULT 'conversation',
  time_from TEXT,
  time_to TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hwg_rel_a ON hwg_relations(person_a);
CREATE INDEX IF NOT EXISTS idx_hwg_rel_b ON hwg_relations(person_b);
CREATE TABLE IF NOT EXISTS hwg_events (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  timestamp TEXT,
  related_persons TEXT,
  source TEXT DEFAULT 'conversation',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hwg_evt_p ON hwg_events(person_id);
CREATE TABLE IF NOT EXISTS hwg_profile_snapshots (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  confidence REAL DEFAULT 0.3,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hwg_snap_p ON hwg_profile_snapshots(person_id);
`;

export interface PersonNode {
  id: string;
  name: string;
  status: PERSON_STATUS;
  stage: LIFE_STAGE;
  firstSeen: string;
  lastSeen: string;
  mentionCount: number;
}

export interface RelationEdge {
  id: string;
  personA: string;
  personB: string;
  relation: string;
  category: RELATION_CATEGORY;
  confidence: number;
  source: string;
  timeFrom?: string;
  timeTo?: string;
}

export class HumanWorldGraph {
  private fg: FamilyGraph;
  private sqlite: SQLiteAdapter;
  private _ready = false;
  private progressiveProfile: ProgressiveProfile;
  private personTimeline: PersonTimeline;
  private knowledgeBridge: KnowledgeBridge;

  constructor(fg: FamilyGraph, sqlite: SQLiteAdapter) {
    this.fg = fg;
    this.sqlite = sqlite;
    this.progressiveProfile = new ProgressiveProfile(sqlite);
    this.personTimeline = new PersonTimeline(sqlite);
    this.knowledgeBridge = new KnowledgeBridge(sqlite, fg);
  }

  private ensureTables(): void {
    if (this._ready) return;
    try {
      this.sqlite.writeRaw(FG_EXTRA_TABLE);
      this._ready = true;
    } catch { /* 表已存在 */ }
  }

  /**
   * 从对话中增强世界图谱
   * 在 M4 orchestrate 之后调用
   */
  async enhanceFromConversation(
    personName: string,
    relationKeyword: string,
    rawInput: string,
  ): Promise<void> {
    this.ensureTables();
    if (!personName || personName.length < 2) return;

    try {
      // 1. 更新或创建人物节点
      const now = new Date().toISOString();
      const existing = this.sqlite.queryAll(
        'SELECT id, status, mention_count, extra_data FROM hwg_persons WHERE name = ?', [personName]
      );

      let personId: string;
      if (existing.length > 0) {
        personId = (existing[0] as any).id as string;
        const mc = ((existing[0] as any).mention_count as number) || 0;
        this.sqlite.writeRaw(
          'UPDATE hwg_persons SET last_seen = ?, mention_count = ?, status = ? WHERE id = ?',
          [now, mc + 1, PERSON_STATUS.ACTIVE, personId]
        );
      } else {
        personId = `hwg_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
        this.sqlite.writeRaw(
          'INSERT INTO hwg_persons (id, name, status, stage, first_seen, last_seen, mention_count) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [personId, personName, PERSON_STATUS.ACTIVE, LIFE_STAGE.UNKNOWN, now, now, 1]
        );
      }

      // 2. 如果有关键词，推测关系类型并记录
      if (relationKeyword && relationKeyword.length >= 2) {
        const relationType = this._guessRelationType(relationKeyword, rawInput);
        if (relationType) {
          this._ensureRelation('我', personName, relationType, rawInput);
        }
      }

      // 3. 渐进画像更新
      await this.progressiveProfile.addSnapshot(personId, personName, rawInput);

      // 4. 桥接知识库
      await this.knowledgeBridge.bridgeFromPerson(personId, personName);

    } catch (err) {
      console.warn('[HWG] enhanceFromConversation 失败:', err);
    }
  }

  /**
   * 获取人物的完整关系网络
   */
  getNetwork(personName: string, maxDepth = 2): Array<{ name: string; relation: string; category: string; confidence: number }> {
    this.ensureTables();
    const result: Array<{ name: string; relation: string; category: string; confidence: number }> = [];
    if (!personName) return result;

    try {
      // 直接关系
      const rows = this.sqlite.queryAll(
        `SELECT r.person_a, r.person_b, r.relation, r.category, r.confidence
         FROM hwg_relations r
         WHERE r.person_a = ? OR r.person_b = ?
         ORDER BY r.confidence DESC LIMIT 50`,
        [personName, personName]
      );

      for (const row of rows) {
        const r = row as any;
        const other = (r.person_a as string) === personName ? r.person_b as string : r.person_a as string;
        const rel = (r.person_a as string) === personName ? r.relation as string : this._reverseRelation(r.relation as string);
        if (r.confidence >= CONFIDENCE.OUTPUT_THRESHOLD) {
          result.push({ name: other, relation: describeRelation(rel), category: r.category as string, confidence: r.confidence as number });
        }
      }
    } catch { /* 查询失败 */ }

    return result;
  }

  /**
   * 获取人物认知演进历史
   */
  getProgression(personName: string): Array<{ snapshot: string; confidence: number; time: string }> {
    this.ensureTables();
    try {
      const person = this.sqlite.queryAll('SELECT id FROM hwg_persons WHERE name = ?', [personName]);
      if (!person.length) return [];
      return this.progressiveProfile.getSnapshots((person[0] as any).id as string);
    } catch { return []; }
  }

  /**
   * 获取人物时间线
   */
  getTimeline(personName: string): Array<{ type: string; title: string; time?: string }> {
    this.ensureTables();
    return this.personTimeline.getTimeline(personName);
  }

  /**
   * 获取所有人
   */
  getAllPersons(): PersonNode[] {
    this.ensureTables();
    try {
      const rows = this.sqlite.queryAll(
        'SELECT id, name, status, stage, first_seen, last_seen, mention_count FROM hwg_persons ORDER BY last_seen DESC'
      );
      return rows.map((r: any) => ({
        id: r.id as string,
        name: r.name as string,
        status: (r.status as PERSON_STATUS) || PERSON_STATUS.ACTIVE,
        stage: (r.stage as LIFE_STAGE) || LIFE_STAGE.UNKNOWN,
        firstSeen: r.first_seen as string,
        lastSeen: r.last_seen as string,
        mentionCount: r.mention_count as number,
      }));
    } catch { return []; }
  }

  /**
   * 获取图谱统计
   */
  getStats(): { persons: number; relations: number; events: number } {
    this.ensureTables();
    try {
      const p = (this.sqlite.queryAll('SELECT COUNT(*) as c FROM hwg_persons')[0] as any)?.c || 0;
      const r = (this.sqlite.queryAll('SELECT COUNT(*) as c FROM hwg_relations')[0] as any)?.c || 0;
      const e = (this.sqlite.queryAll('SELECT COUNT(*) as c FROM hwg_events')[0] as any)?.c || 0;
      return { persons: p as number, relations: r as number, events: e as number };
    } catch { return { persons: 0, relations: 0, events: 0 }; }
  }

  // ─── 内部方法 ───

  /**
   * 从关键词推测关系类型
   * "我妈妈" → mother_of, "我同事" → colleague_of
   */
  private _guessRelationType(keyword: string, rawInput: string): string | null {
    const kw = keyword.replace('我', '').replace('的', '').trim();
    const KINSHIP_MAP: Record<string, string> = {
      '妈妈': 'mother_of', '妈': 'mother_of', '母亲': 'mother_of',
      '爸爸': 'father_of', '爸': 'father_of', '父亲': 'father_of',
      '老公': 'spouse_of', '老婆': 'spouse_of', '丈夫': 'spouse_of', '妻子': 'spouse_of',
      '哥哥': 'sibling_of', '弟弟': 'sibling_of',
      '姐姐': 'sibling_of', '妹妹': 'sibling_of',
      '爷爷': 'grandfather_of', '奶奶': 'grandmother_of',
      '同事': 'colleague_of', '同学': 'classmate_of', '朋友': 'friend_of',
      '老板': 'boss_of', '上司': 'boss_of', '下属': 'subordinate_of',
      '客户': 'client_of', '邻居': 'neighbor_of', '室友': 'roommate_of',
      '老师': 'teacher_of', '学生': 'student_of', '徒弟': 'protege_of',
      '合伙人': 'partner_of', '搭档': 'partner_of',
    };
    return KINSHIP_MAP[kw] || null;
  }

  /**
   * 确保关系边存在
   */
  private _ensureRelation(personA: string, personB: string, relation: string, rawInput: string): void {
    this.ensureTables();
    try {
      const now = new Date().toISOString();
      const category = getRelationCategory(relation) || RELATION_CATEGORY.SOCIAL;
      const confidence = CONFIDENCE.KINSHIP_FROM_CONVERSATION;

      const idA = personA < personB ? personA : personB;
      const idB = personA < personB ? personB : personA;
      const rel = personA < personB ? relation : this._reverseRelation(relation);

      const existing = this.sqlite.queryAll(
        'SELECT id, confidence, time_to FROM hwg_relations WHERE person_a = ? AND person_b = ? AND relation = ?',
        [idA, idB, rel]
      );

      if (existing.length > 0) {
        const e = existing[0] as any;
        const newConf = Math.min(1, (e.confidence as number) + CONFIDENCE.MENTION_BOOST);
        this.sqlite.writeRaw(
          'UPDATE hwg_relations SET confidence = ?, updated_at = ? WHERE id = ?',
          [newConf, now, e.id]
        );
      } else {
        const rid = `hwr_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
        this.sqlite.writeRaw(
          'INSERT INTO hwg_relations (id, person_a, person_b, relation, category, confidence, source, time_from, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [rid, idA, idB, rel, category, confidence, 'conversation', now, now, now]
        );
      }
    } catch { /* 不阻塞 */ }
  }

  private _reverseRelation(relation: string): string {
    const def = RELATION_TYPE_DEFS[relation];
    return def?.reverse || relation;
  }
}
