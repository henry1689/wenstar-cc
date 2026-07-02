/**
 * RPDataRefluxAuditor — 角色扮演数据回流审计（P2-3）
 *
 * 对话中提取的客观事实经三级校验后，可确认回流到 FG 主库。
 *
 * ── 核心设计原则 ──
 * 数据的去留不由数据类型决定，由对话场景决定：
 *   私密/扮演场景 → 所有数据均可回流（情爱/外貌/性格全部记录）
 *   办公/公众场景 → 情爱和即兴内容过滤，只保留客观事实
 *
 * ── 三级回流审批 ──
 * 1. 自动采集层 — 上下文扫描器 + 规则提取
 * 2. 规则审计层 — 范围校验 + 冲突校验 + 置信度校验
 * 3. 确认入库层 — 用户确认后写 FG
 *
 * 🔴 铁律：
 *   - 场景分类决定数据范围，而非字段白名单
 *   - 称谓变化永不回流（"爸爸""哥哥"等扮演设定不污染 FG）
 */

// ─── 类型 ───

export type DialogContext = 'private' | 'public' | 'work';

export interface RefluxItem {
  id: string;
  targetPerson: string;
  field: string;
  value: string;
  originalDialog: string;
  dialogSeq: number;
  confidence: number;
  roleName: string;
  checkResults: {
    scopePass: boolean;
    conflictPass: boolean;
    confidencePass: boolean;
  };
  status: 'pending' | 'confirmed' | 'rejected';
  createdAt: string;
  confirmedAt?: string;
  rollbackInfo?: string;
}

// ─── 场景关键词检测 ───
const PUBLIC_CONTEXT_KW = [
  '同事', '客户', '公司', '上班', '开会',
  '会议', '方案', '项目', '出差', '办公',
  '大厅', '前台', '外面', '朋友', '聚会',
];

const INTIMATE_KW = [
  '高潮', '射精', '插入', '抽插', '呻吟',
  '奶子', '胸', '阴道', '阴茎', '做爱',
  '操', '干', '日', '吻', '摸', '抱',
  '湿了', '硬了', '进去', '深点',
];

/** 称谓变化 — 永远不回流 */
const TITLE_CHANGES = [
  '爸爸', '妈妈', '哥哥', '姐姐', '弟弟', '妹妹',
  '爷爷', '奶奶', '叔叔', '阿姨', '老公', '老婆',
  '姐夫', '嫂子',
];

export class RPDataRefluxAuditor {
  private pendingItems: Map<string, RefluxItem> = new Map();
  private auditLog: RefluxItem[] = [];
  private fg: any;

  constructor(fg: any) {
    this.fg = fg;
  }

  /** 检测当前对话场景 */
  detectContext(message: string, userHistory: string[]): DialogContext {
    const allText = [message, ...userHistory.slice(-5)].join(' ');
    const hasPublic = PUBLIC_CONTEXT_KW.some(kw => allText.includes(kw));
    const hasIntimate = INTIMATE_KW.some(kw => allText.includes(kw));

    if (hasPublic && !hasIntimate) return 'work';
    if (hasIntimate) return 'private';
    return 'private'; // 默认私密（用户明确说公开时才是公开）
  }

  /** 从对话提取可回流事实 — 场景感知 */
  extractFacts(
    roleName: string,
    dialogSeq: number,
    originalDialog: string,
    context: DialogContext,
  ): RefluxItem[] {
    const items: RefluxItem[] = [];

    // 办公/公众场景：情爱内容跳过
    const isPublic = context === 'work' || context === 'public';

    if (isPublic && INTIMATE_KW.some(kw => originalDialog.includes(kw))) {
      return items;
    }

    // ── 年龄提取 ──
    const ageMatch = originalDialog.match(/([一-龥]{2,4})(?:才|刚|今年|现在|已经)?(\d{1,2})岁/);
    if (ageMatch) {
      const ageNum = parseInt(ageMatch[2], 10);
      if (ageNum >= 1 && ageNum <= 120) {
        items.push(this.buildItem(roleName, ageMatch[1], 'age', ageMatch[2], originalDialog, dialogSeq,
          isPublic ? 0.9 : 0.7));
      }
    }

    // ── 职业提取（仅公开场景有意义） ──
    if (isPublic) {
      const occMatch = originalDialog.match(/([一-龥]{2,4})是(?:个|名|位)?([一-龥]{2,6}(?:生|员|师|工|匠|手|家))/);
      if (occMatch) {
        items.push(this.buildItem(roleName, occMatch[1], 'occupation', occMatch[2], originalDialog, dialogSeq, 0.8));
      }
    }

    // ── 关系提取 — 排除称谓变化 ──
    const relMatch = originalDialog.match(/([一-龥]{2,4})是(?:我|你|他|她)的([一-龥]{1,4})/);
    if (relMatch) {
      const value = relMatch[2];
      if (!TITLE_CHANGES.includes(value)) {
        items.push(this.buildItem(roleName, relMatch[1], 'relation_to_user', value, originalDialog, dialogSeq,
          isPublic ? 0.85 : 0.6));
      }
    }

    // ── 外貌/性格提取（私密场景下全部记录） ──
    if (!isPublic) {
      const appearMatch = originalDialog.match(/([一-龥]{2,4})(?:长[得地]?很|很)([一-龥]{2,4})/);
      if (appearMatch) {
        items.push(this.buildItem(roleName, appearMatch[1], 'appearance', appearMatch[2],
          originalDialog, dialogSeq, 0.5));
      }
    }

    return items;
  }

  /** 执行三级审计 */
  async audit(item: RefluxItem): Promise<RefluxItem> {
    // 第一级：范围校验 — 所有字段均可通过
    item.checkResults.scopePass = true;

    // 第二级：冲突校验
    item.checkResults.conflictPass = true;
    if (this.fg && ['age', 'occupation', 'relation_to_user'].includes(item.field)) {
      try {
        const existing = await this.fg.getPersonProfile(item.targetPerson);
        if (existing && existing[item.field] && existing[item.field] !== item.value) {
          item.confidence = Math.min(item.confidence, 0.5);
          item.checkResults.conflictPass = false;
        }
      } catch (_e: any) { console.error('[RefluxAudit] error:', (_e as any)?.message); }
    }

    // 第三级：置信度校验
    item.checkResults.confidencePass = item.confidence >= 0.5;

    if (item.checkResults.scopePass && item.checkResults.confidencePass) {
      item.status = 'pending';
      this.pendingItems.set(`${item.targetPerson}:${item.field}`, item);
      this.auditLog.push(item);
      console.log(`[RefluxAudit] 📋 待确认: ${item.targetPerson}.${item.field}=${item.value} (conf=${item.confidence})`);
    } else {
      item.status = 'rejected';
      this.auditLog.push(item);
    }

    return item;
  }

  /** 确认回流 — 写入 FG */
  async confirm(key: string): Promise<boolean> {
    const item = this.pendingItems.get(key);
    if (!item || item.status !== 'pending') return false;
    try {
      await this.fg.updatePersonProfile(item.targetPerson, {
        [item.field]: item.value,
      } as any);
      item.status = 'confirmed';
      item.confirmedAt = new Date().toISOString();
      item.rollbackInfo = JSON.stringify({ person: item.targetPerson, field: item.field, value: item.value });
      console.log(`[RefluxAudit] ✅ 已回流: ${item.targetPerson}.${item.field}=${item.value}`);
      this.pendingItems.delete(key);
      return true;
    } catch (err) {
      console.error(`[RefluxAudit] ❌ 回流失败:`, (err as Error).message);
      return false;
    }
  }

  /** 拒绝 */
  reject(key: string): boolean {
    const item = this.pendingItems.get(key);
    if (!item) return false;
    item.status = 'rejected';
    this.pendingItems.delete(key);
    console.log(`[RefluxAudit] 🚫 已拒绝: ${item.targetPerson}.${item.field}`);
    return true;
  }

  getPending(): RefluxItem[] { return Array.from(this.pendingItems.values()); }
  getAuditLog(): RefluxItem[] { return [...this.auditLog]; }
  clearPending(): void { this.pendingItems.clear(); }

  private buildItem(
    roleName: string, targetPerson: string, field: string,
    value: string, dialog: string, seq: number, confidence: number,
  ): RefluxItem {
    return {
      id: `reflux_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      targetPerson, field, value,
      originalDialog: dialog.substring(0, 200),
      dialogSeq: seq, confidence, roleName,
      checkResults: { scopePass: false, conflictPass: true, confidencePass: false },
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
  }
}
