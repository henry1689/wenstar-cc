/**
 * ConflictDetector — 知识冲突检测器
 * =====================================
 * 检测用户描述中的对立信息并标记冲突。
 * 例如: "我喜欢看电影" 与 "我讨厌看电影" → 冲突标记
 *
 * 冲突标记写入 knowledge_base (classification='冲突检测')，
 * 玉瑶可在下次对话中反问确认。
 */
import type { FusionStorageAdapter } from '../../m2/FusionStorageAdapter.js';
import type { Perception24D } from '../../m3/types/perception.js';
import { LEARNING_CONFIG } from '../../config/learning-config.js';

interface ConflictRecord {
  entity: string;
  firstValue: string;
  secondValue: string;
  firstMessage: string;
  secondMessage: string;
  detectedAt: string;
  /** 🔴 2026-09-19 户管管理法：冲突条目的实体归属 UUID。
   *  来源 = 当前消息 entity_genes 里该实体的 `uuid`（EntityGene.uuid，由 L3 标注时从 FamilyGraph 解析，
   *  与 SQLiteAdapter 使用 gene.uuid 的既定惯例一致）—— 这是**权威值**，不得在此重新按名字猜。
   *  非 person 类实体（emotion 等）无户籍 → 为 null（合法 unowned）。 */
  entityUuid?: string | null;
}

export class ConflictDetector {
  private storage: FusionStorageAdapter;

  /** 正面/负面词表 */
  private static POSITIVE_WORDS = new Set([
    '喜欢', '爱', '想要', '希望', '想', '愿意', '要', '期待',
    '好看', '好吃', '好玩', '好用', '好喝', '好听',
    '开心', '高兴', '快乐', '舒服', '爽', '棒', '赞',
  ]);

  private static NEGATIVE_WORDS = new Set([
    '讨厌', '不喜欢', '不爱', '不要', '不想', '不愿意', '恨',
    '难吃', '难看', '难玩', '难用', '难喝', '难听',
    '伤心', '难过', '痛苦', '烦', '厌恶', '恶心',
  ]);

  constructor(storage: FusionStorageAdapter) {
    this.storage = storage;
  }

  /**
   * 检查某实体的最新消息是否与历史记录冲突
   * @param entityName 实体名 (person 或 emotion)
   * @param message 当前消息
   * @param entityType 实体类型
   * @param perception 当前感知
   * @param entityUuid 该实体的户籍 UUID（来自 EntityGene.uuid；缺省 null = unowned）
   */
  async check(
    entityName: string,
    message: string,
    entityType: string,
    perception: Perception24D,
    entityUuid?: string | null,
  ): Promise<ConflictRecord | null> {
    try {
      // 只检测含情感评价的消息
      const sentiment = this._detectSentiment(message);
      if (!sentiment) return null;

      const sqlite = this.storage.getSQLite();

      // 查找历史中对该实体的情感评价
      const historyRows = sqlite.queryAll(
        `SELECT content FROM knowledge_base
         WHERE (title LIKE ? OR content LIKE ?)
           AND classification IN ('用户偏好', '生活记录', '用户资料')
         ORDER BY created_at DESC LIMIT 5`,
        [`%${entityName}%`, `%${entityName}%`],
      );

      for (const row of historyRows) {
        const historyContent = row.content as string;
        const historySentiment = this._detectSentiment(historyContent);

        if (historySentiment && historySentiment.polarity !== sentiment.polarity) {
          // 极性相反 → 冲突
          const conflict: ConflictRecord = {
            entity: entityName,
            firstValue: historyContent.substring(0, 100),
            secondValue: message.substring(0, 100),
            firstMessage: historyContent.substring(0, 200),
            secondMessage: message.substring(0, 200),
            detectedAt: new Date().toISOString(),
            entityUuid: entityUuid ?? null,
          };

          // 写入冲突标记到知识库
          this._storeConflict(conflict);
          return conflict;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * 检测消息的情感极性
   */
  private _detectSentiment(message: string): { polarity: 'positive' | 'negative' | 'neutral'; word: string } | null {
    for (const word of ConflictDetector.POSITIVE_WORDS) {
      if (message.includes(word)) {
        return { polarity: 'positive', word };
      }
    }
    for (const word of ConflictDetector.NEGATIVE_WORDS) {
      if (message.includes(word)) {
        return { polarity: 'negative', word };
      }
    }
    return null;
  }

  /**
   * 将冲突记录写入知识库 (待分类)
   */
  private _storeConflict(conflict: ConflictRecord): void {
    try {
      const sqlite = this.storage.getSQLite();
      const now = new Date().toISOString();
      const id = `kn_conf_${Date.now().toString(36)}`;

      // 🔴 2026-09-19 户管管理法（写入端修复）：冲突条目是**关于某个具体人物/情感实体**的陈述，
      //   归属可精确解析（上游 EntityGene.uuid），不得留在列清单之外。
      //   原列清单缺席 → INSERT OR IGNORE 只惠及「从未有过归属」，
      //   但实测 kb 98 行仅 1 行有 belong：该条在会晤场景会被 deny-by-default 闸门滤掉。
      //   unowned（NULL）在此是**合法且可预期**的结果（emotion 类实体无户籍），故仍用参数绑定而非裸 NULL，
      //   以便与「漏列导致的值缺失」在文本上可区分。
      sqlite.writeRaw(
        `INSERT OR IGNORE INTO knowledge_base
         (id, title, content, source_type, tags, created_at, updated_at, locked,
          classification, classification_pending, interaction_type, scene_tags, belong_entity_uuid)
         VALUES (?, ?, ?, 'conflict', ?, ?, ?, 1,
                 '冲突检测', 1, 'conversation', ?, ?)`,
        [
          id,
          `冲突: ${conflict.entity}`,
          `【用户对"${conflict.entity}"的描述前后矛盾】\n`
            + `之前说: ${conflict.firstMessage}\n`
            + `现在说: ${conflict.secondMessage}\n`
            + `检测时间: ${conflict.detectedAt}`,
          JSON.stringify(['auto-detected', 'conflict', `entity:${conflict.entity}`]),
          now, now,
          'conflict',
          conflict.entityUuid ?? null,
        ],
      );

      console.log(`[ConflictDetector] 🔴 检测到矛盾: ${conflict.entity}`);
    } catch { /* 不阻塞 */ }
  }

  /**
   * 获取所有未解决的冲突 (待玉瑶反问)
   */
  async getUnresolved(limit = 10): Promise<Array<{ id: string; title: string; content: string }>> {
    try {
      const sqlite = this.storage.getSQLite();
      const rows = sqlite.queryAll(
        `SELECT id, title, content FROM knowledge_base
         WHERE classification = '冲突检测' AND classification_pending = 1
         ORDER BY created_at DESC LIMIT ?`,
        [limit],
      );
      return rows.map((r: any) => ({
        id: r.id as string,
        title: r.title as string,
        content: r.content as string,
      }));
    } catch { return []; }
  }
}
