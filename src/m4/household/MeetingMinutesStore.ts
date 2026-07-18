/**
 * MeetingMinutesStore — 多人会晤纪要存储引擎
 *
 * 定位：多人会晤（3人及以上）结束时自动生成会议纪要，存储为 MD 档案，
 * 并双向绑定到每位参与者的 dossier.boundDocuments。
 *
 * 纪要写入路径：
 *   data/webui/meetings/{YYYY-MM-DD}-{meetingName}.md
 *
 * 每人 dossier 增加绑定：
 *   dossier.boundDocuments.push({ docId, title, type: 'meeting', boundAt })
 */

import { writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FamilyGraph } from './FamilyGraph.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEETINGS_DIR = join(__dirname, '..', '..', 'data', 'webui', 'meetings');

/** 单轮对话记录 */
export interface MeetingTurn {
  speaker: string;       // 说话人
  role: 'user' | 'assistant';
  content: string;       // 发言内容（截取前 300 字）
  timestamp: string;
}

/** 会议纪要 */
export interface MeetingMinutes {
  meetingId: string;           // 唯一 ID
  name: string;                // 会议名称
  startedAt: string;
  endedAt: string;
  participants: string[];      // 参与者名单
  turnCount: number;           // 总轮次
  turns: MeetingTurn[];        // 对话记录
  summary: string;             // LLM 生成的摘要（可选）
  rawFilePath: string;         // 存储路径
}

export class MeetingMinutesStore {
  private familyGraph: FamilyGraph;

  constructor(familyGraph: FamilyGraph) {
    this.familyGraph = familyGraph;
  }

  /**
   * 生成并存储会议纪要。
   *
   * @param name - 会议名称
   * @param participants - 参与者 UUID 列表
   * @param turns - 对话轮次
   * @param summary - 摘要文本（可由 LLM 生成，也可由系统自动生成）
   */
  generateAndStore(
    name: string,
    participants: string[],
    turns: MeetingTurn[],
    summary?: string,
  ): MeetingMinutes {
    // 确保目录存在
    if (!existsSync(MEETINGS_DIR)) mkdirSync(MEETINGS_DIR, { recursive: true });

    const now = new Date();
    const dateStr = now.toISOString().substring(0, 10);
    const timestamp = now.toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const meetingId = `MTG-${dateStr.replace(/-/g, '')}-${participants.length}p`;

    // 解析参与者名
    const participantNames = participants
      .map(uuid => this._resolveName(uuid))
      .filter(Boolean);

    // 系统自动生成摘要（如果 LLM 未提供）
    const autoSummary = summary || this._generateAutoSummary(name, participantNames, turns);

    // 构建 MD 内容
    const md = this._buildMarkdown({
      meetingId,
      name,
      startedAt: turns[0]?.timestamp || now.toISOString(),
      endedAt: now.toISOString(),
      participants: participantNames,
      turnCount: turns.length,
      turns,
      summary: autoSummary,
      rawFilePath: '',
    });

    // 写入文件
    const fileName = `${dateStr}-${name.replace(/[\\/:*?"<>|]/g, '-').substring(0, 40)}.md`;
    const filePath = join(MEETINGS_DIR, fileName);

    // 处理重名
    let finalPath = filePath;
    let counter = 1;
    while (existsSync(finalPath)) {
      finalPath = join(MEETINGS_DIR, fileName.replace('.md', `_${counter}.md`));
      counter++;
    }

    writeFileSync(finalPath, md, 'utf-8');

    // 绑定到每个参与者的 dossier
    for (const uuid of participants) {
      this._bindToDossier(uuid, meetingId, name, finalPath);
    }

    console.log(`[MTG] 纪要已存档: ${finalPath} (${participantNames.length}人, ${turns.length}轮)`);

    return {
      meetingId,
      name,
      startedAt: turns[0]?.timestamp || now.toISOString(),
      endedAt: now.toISOString(),
      participants: participantNames,
      turnCount: turns.length,
      turns,
      summary: autoSummary,
      rawFilePath: finalPath,
    };
  }

  /**
   * 查询某人的所有会议记录
   */
  getMeetingsForPerson(personName: string): Array<{ meetingId: string; title: string; filePath: string }> {
    const profile = this.familyGraph.getPersonProfile(personName);
    if (!profile?.dossier?.boundDocuments) return [];

    return profile.dossier.boundDocuments
      .filter((d: any) => d.type === 'meeting')
      .map((d: any) => ({
        meetingId: d.docId,
        title: d.title,
        filePath: d._filePath || '',
      }));
  }

  // ═══════════════════════════════════════════════════════════════
  // 内部
  // ═══════════════════════════════════════════════════════════════

  private _resolveName(uuid: string): string {
    try {
      const rows = (this.familyGraph as any).query?.(
        "SELECT name FROM nodes WHERE uuid = ? AND type = 'person'",
        [uuid]
      );
      return rows?.[0]?.name || uuid;
    } catch {
      return uuid;
    }
  }

  private _generateAutoSummary(name: string, participants: string[], turns: MeetingTurn[]): string {
    const userTurns = turns.filter(t => t.role === 'user').length;
    const assistantTurns = turns.filter(t => t.role === 'assistant').length;
    const speakers = [...new Set(turns.map(t => t.speaker))];

    // 提取高频关键词（最简单的实现——后续可接入 LLM）
    const allText = turns.map(t => t.content).join(' ');
    const wordFreq = new Map<string, number>();
    const words = allText.match(/[一-龥]{2,4}/g) || [];
    const stopWords = new Set('的了在是我有不和就人也把被让从对跟说会着没看好看一看是一样能到下而去及但');
    for (const w of words) {
      if (w.split('').some((c: string) => stopWords.has(c))) continue;
      wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
    }
    const topWords = [...wordFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([w]) => w);

    return `## 会议摘要

**会议名称**: ${name || '多人会晤'}
**参与人员**: ${participants.join('、')}
**发言人**: ${speakers.join('、')}
**总轮次**: ${turns.length} 轮（用户 ${userTurns} 轮 · AI ${assistantTurns} 轮）

**高频话题**: ${topWords.join('、')}

> 此摘要由系统自动生成。${participants.length >= 3 ? '本会晤为多人会议，区别于普通私聊。' : ''}`;
  }

  private _buildMarkdown(m: MeetingMinutes): string {
    const lines: string[] = [];

    lines.push('---');
    lines.push(`meetingId: "${m.meetingId}"`);
    lines.push(`title: "会议纪要 · ${m.name}"`);
    lines.push(`type: "meeting"`);
    lines.push(`date: "${m.endedAt.substring(0, 10)}"`);
    lines.push(`participants: [${m.participants.map(p => `"${p}"`).join(', ')}]`);
    lines.push(`turnCount: ${m.turnCount}`);
    lines.push('---');
    lines.push('');
    lines.push(`# 会议纪要 · ${m.name}`);
    lines.push('');
    lines.push(`- **日期**: ${m.startedAt.substring(0, 10)}`);
    lines.push(`- **参与人员**: ${m.participants.join('、')}`);
    lines.push(`- **轮次**: ${m.turnCount} 轮`);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(m.summary);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## 对话记录');
    lines.push('');

    for (let i = 0; i < m.turns.length; i++) {
      const turn = m.turns[i];
      const label = turn.role === 'user' ? '👤 用户' : `🤖 ${turn.speaker}`;
      const time = turn.timestamp?.substring(11, 16) || '';
      lines.push(`### ${i + 1}. ${label} \`${time}\``);
      lines.push('');
      // 截取内容避免纪要文件过大
      const content = turn.content.length > 500
        ? turn.content.substring(0, 500) + '...'
        : turn.content;
      lines.push(content);
      lines.push('');
    }

    return lines.join('\n');
  }

  private _bindToDossier(uuid: string, meetingId: string, title: string, filePath: string): void {
    try {
      const entity = (this.familyGraph as any).getEntityByUUID?.(uuid);
      if (!entity) return;
      const name = entity.name || (entity as any).node_name;
      if (!name) return;

      // 读取现有 boundDocuments
      const profile = this.familyGraph.getPersonProfile(name);
      const existingDocs = profile?.dossier?.boundDocuments || [];

      // 追加
      const newDoc = {
        docId: meetingId,
        title: `会议纪要 · ${title}`,
        type: 'meeting',
        boundAt: new Date().toISOString(),
        _filePath: filePath,
      };

      const updatedDocs = [...existingDocs, newDoc];
      (this.familyGraph as any).setDossierField?.(name, 'boundDocuments', updatedDocs);
    } catch {
      // 绑定失败不影响纪要存储
    }
  }
}

export default MeetingMinutesStore;
