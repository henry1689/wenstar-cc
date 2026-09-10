/**
 * FGProfileWriteGateway — FG 档案写入门户 (V12.x 写入门户收口)
 * ============================================================
 * FG 人物档案的**唯一写入口**。包装 FamilyGraph 写方法，统一挂载写侧授权。
 *
 * 背景：此前 FG 写入散落在 chat.ts（直接调 getFamilyGraph().updatePersonProfile /
 * addFeatureEdge / integrateSocialRelation），无统一入口、无写侧授权——会晤模式下
 * 会晤实体（LLM）可编造其他已有实体的关系/档案，污染主 FG。
 *
 * 写侧授权语义（见 UUIDPoliceFilter.canWriteEntity）：
 *   - 非会晤 → 一律允许（用户自由录入）
 *   - 会晤中 → 只允许写「会晤实体本人」或「主 FG 中尚不存在的新实体」
 *   - 会晤中 → 主 FG 已有的其他实体 → 拒绝（软拦截，记录日志不 throw）
 *
 * 🔴 软拦截策略：denied 时记录日志并跳过写入，**不 throw、不阻断对话主链路**。
 *    写侧是旁路增强，不是主链路闸门。
 *
 * 复用：写守卫（垃圾过滤/审计/落盘）已内置于 FamilyGraph 内部（addNode 的
 * GarbageEntityGuard、updatePersonProfile 的 _changeHistory + markDirty），本门户
 * 只补「写侧授权」这一层，不重复造守卫。
 */

import type { FamilyGraph } from './FamilyGraph.js';
import { canWriteEntity, type WritePolicy } from '../../governance/police/UUIDPoliceFilter.js';

export class FGProfileWriteGateway {
  constructor(
    /** 惰性 FG 获取器——每次写操作时取当前实例（可能被角色/会晤 override） */
    private fgProvider: () => FamilyGraph,
    /** 动态写策略——每次写操作时读取当前会晤状态（会晤可能在对话中 enter/exit） */
    private policyProvider: () => WritePolicy = () => ({}),
  ) {}

  private get fg(): FamilyGraph {
    return this.fgProvider();
  }

  /** 写前授权：目标实体是否允许写。denied → 记录日志并跳过 */
  private allowed(targetName: string): boolean {
    const fg = this.fg;
    if (!fg) return false;
    const r = canWriteEntity(targetName, this.policyProvider(), fg as any);
    if (!r.allowed) {
      console.warn(`[FGWriteGateway] ${r.reason}`);
      return false;
    }
    return true;
  }

  /** 更新人物档案（P0 外貌/身材 + P3 关系/职业） */
  updatePersonProfile(entityName: string, updates: Record<string, any>, opts?: any): void {
    if (!this.allowed(entityName)) return;
    this.fg?.updatePersonProfile?.(entityName, updates as any, opts);
  }

  /**
   * 更新人物档案，并返回「是否真正写入（授权结果）」。
   *
   * 为何需要（M2-2 写侧收口）：ProfileAcquisitionEngine 需要知道写入是否被授权，
   * 以便正确统计 fieldsWritten / 决定是否写 pendingItems。既有 updatePersonProfile
   * 返回 void，把授权结果丢弃了。
   *
   * 🔴 授权语义与 updatePersonProfile **完全相同**（同一 private allowed() → canWriteEntity）：
   * 非会晤一律允许；会晤中只允许写会晤实体本人或主 FG 尚不存在的新实体；
   * 其余拒绝（软拦截，记日志不 throw）。本方法**只多返回结果，不放宽任何写入路径**。
   *
   * @returns true = 已授权且已发起写入；false = 被授权闸门拒绝，未写入
   */
  tryUpdateProfile(entityName: string, updates: Record<string, any>, opts?: any): boolean {
    if (!this.allowed(entityName)) return false;
    this.fg?.updatePersonProfile?.(entityName, updates as any, opts);
    return true;
  }

  /** 添加外貌/特征边 */
  addFeatureEdge(personName: string, featureName: string, featureType: 'appearance' | 'body' | 'style' | 'trait' = 'appearance'): void {
    if (!this.allowed(personName)) return;
    try {
      this.fg?.addFeatureEdge?.(personName, featureName, featureType)
        ?.catch((e: any) => console.warn('[FG] addFeatureEdge失败:', e?.message));
    } catch (e: any) {
      console.warn('[FG] addFeatureEdge调用异常:', e?.message);
    }
  }

  /** 同步人际关系（熟人边） */
  integrateSocialRelation(personName: string, socialType: string, message: string): void {
    if (!this.allowed(personName)) return;
    this.fg?.integrateSocialRelation?.(personName, socialType, message)
      ?.catch((e: any) => console.warn('[chat] FG关系写入失败:', e?.message));
  }

  /** 社交→家族关系升级 */
  promoteSocialToFamily(personName: string, relation: string, context?: string): void {
    if (!this.allowed(personName)) return;
    this.fg?.promoteSocialToFamily?.(personName, relation, context)
      ?.catch((e: any) => console.warn('[chat] FG家族升级失败:', e?.message));
  }
}

export default FGProfileWriteGateway;