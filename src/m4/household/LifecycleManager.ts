/**
 * LifecycleManager — 实体生命周期闭环管理器
 * ============================================
 * V4.0: 替代原先被动/不完整的 status 自动降级机制。
 *
 * 四档状态流转：
 *   active → dormant → archived → (封存，仅手动恢复)
 *   dormant → active (用户再次提及，自动恢复)
 *   active/dormant/archived → deceased (仅用户手动操作，不可逆)
 *
 * 触发机制：
 *   - 实时: getPersonProfile() → _checkStatusDowngrade() (已有，保留)
 *   - 每日: LifecycleManager.runDaily() → 全局批量扫描 (本模块新增)
 *   - 手动: familyGraph.setEntityStatus(name, 'deceased') (本模块新增)
 *
 * 登记制度依据：
 *   《太虚境户籍管理法》第三十条-第三十一条 (四档实体状态、状态转换规则)
 */

import type { FamilyGraph } from './FamilyGraph.js';
import { computeTargetStatus } from './shared/StatusRules.js';

export interface LifecycleReport {
  activeToDormant: number;
  dormantToActive: number;
  dormantToArchived: number;
  totalScanned: number;
  errors: string[];
}

export class LifecycleManager {
  private familyGraph: FamilyGraph;

  constructor(familyGraph: FamilyGraph) {
    this.familyGraph = familyGraph;
  }

  /**
   * 每日批量扫描——全局检查所有 person 节点的 status 是否需要转换。
   * 仅在夜间维护时段调用（每日一次）。
   */
  async runDaily(): Promise<LifecycleReport> {
    const report: LifecycleReport = {
      activeToDormant: 0,
      dormantToActive: 0,
      dormantToArchived: 0,
      totalScanned: 0,
      errors: [],
    };

    const now = Date.now();
    const MS_PER_DAY = 86400_000;

    try {
      const fg = this.familyGraph as any;
      if (!fg || typeof fg.query !== 'function') {
        report.errors.push('FamilyGraph 不可用');
        return report;
      }

      const persons = fg.query(
        "SELECT id, name, status, properties FROM nodes WHERE type = 'person' AND name != '我' AND status != 'deceased'"
      ) as Array<{ id: string; name: string; status: string; properties: string }>;

      for (const p of persons) {
        report.totalScanned++;
        try {
          const props = JSON.parse(p.properties || '{}');
          const lastMentioned = props.last_mentioned;
          if (!lastMentioned) continue;

          const daysSince = Math.floor((now - new Date(lastMentioned).getTime()) / MS_PER_DAY);
          const currentStatus = p.status || 'active';

          const result = computeTargetStatus(currentStatus, daysSince);
          if (result.changed) {
            fg.run('UPDATE nodes SET status = ? WHERE id = ?', [result.to, p.id]);
            this._appendChangeLog(fg, p.id, props, result.from, result.to, result.reason);
            if (result.to === 'dormant' && result.from === 'active') {
              report.activeToDormant++;
              if (report.activeToDormant <= 5) console.log(`[Lifecycle] ${p.name}: active → dormant (${daysSince}天)`);
            } else if (result.to === 'active') {
              report.dormantToActive++;
              console.log(`[Lifecycle] ${p.name}: dormant → active (${daysSince}天内)`);
            } else if (result.to === 'archived') {
              report.dormantToArchived++;
              console.log(`[Lifecycle] ${p.name}: dormant → archived (${daysSince}天)`);
            }
          }
        } catch (e) {
          report.errors.push(`${p.name}: ${(e as Error)?.message || e}`);
        }
      }
    } catch (e) {
      report.errors.push(`全局扫描异常: ${(e as Error)?.message || e}`);
    }

    return report;
  }

  /**
   * 手动设置实体状态。
   *
   * @param entityName - 实体名
   * @param newStatus - 新状态 (active｜dormant｜archived｜deceased)
   * @param reason - 变更原因
   */
  async setEntityStatus(
    entityName: string,
    newStatus: 'active' | 'dormant' | 'archived' | 'deceased',
    reason: string = '手动操作'
  ): Promise<{ success: boolean; error?: string }> {
    const fg = this.familyGraph as any;

    try {
      const node = fg.findPersonNodeByNameOrAlias?.(entityName);
      if (!node) return { success: false, error: `实体不存在: ${entityName}` };

      const currentStatus = node.status || 'active';

      // 规则校验
      if (currentStatus === 'deceased') {
        return { success: false, error: '已注销实体不可恢复' };
      }
      if (currentStatus === 'archived' && newStatus !== 'active') {
        return { success: false, error: '封存实体仅可手动恢复为 active' };
      }

      const props = JSON.parse(node.properties || '{}');

      fg.run('UPDATE nodes SET status = ? WHERE id = ?', [newStatus, node.id]);
      this._appendChangeLog(fg, node.id, props, currentStatus, newStatus, reason);

      console.log(`[Lifecycle] ${entityName}: ${currentStatus} → ${newStatus} (${reason})`);
      return { success: true };
    } catch (e) {
      return { success: false, error: (e as Error)?.message || String(e) };
    }
  }

  /**
   * 为状态变更追加 _changeHistory 记录。
   */
  private _appendChangeLog(
    fg: any,
    nodeId: string,
    props: any,
    from: string,
    to: string,
    reason: string
  ): void {
    try {
      if (!props._changeHistory) props._changeHistory = [];
      props._changeHistory.push({
        time: new Date().toISOString(),
        operation: '状态变更',
        field: 'status',
        before: from,
        after: to,
        reason,
        source: '生命周期管理器',
      });
      if (props._changeHistory.length > 10000) {
        props._changeHistory = props._changeHistory.slice(-10000);
      }
      fg.run('UPDATE nodes SET properties = ?, updated_at = ? WHERE id = ?', [
        JSON.stringify(props),
        new Date().toISOString(),
        nodeId,
      ]);
    } catch {
      // 变更历史记录失败不影响状态更新
    }
  }
}

export default LifecycleManager;
