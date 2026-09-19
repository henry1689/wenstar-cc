/**
 * YuyaoMemoryService — 玉瑶记事记忆系统
 *
 * R3: 全部 SQL 从模板字串改为参数化查询（? 占位符），移除 esc()/escN() 辅助函数。
 *     参数化后不再有 SQL 注入风险，且代码更简洁——不再需要手动转义每一个值。
 */
import type { SQLiteAdapter } from '../../m2/SQLiteAdapter.js';
// V12.4 阶段B 根除24D: perception_json 列已删，记事写默认 40D v2（全零）
import { encodeEmptyPerceptionV40 } from '../../m2/PerceptionVector40DCodec.js';

export interface NoteMemory {
  id: string; memory_type: 'note'; sub_type: 'object_location' | 'fact' | 'reminder' | 'person_tag';
  note_key: string; raw_input: string; is_valid: number;
  remind_at: string | null; reminded: number; repeat_rule: string | null;
  dialog_group_id: string | null; dna_root_id: string | null; created_at: string;
}

function noteId(): string {
  return `note_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
}

export class YuyaoMemoryService {
  private sqlite: SQLiteAdapter;
  private entityUuid: string | null;
  constructor(sqlite: SQLiteAdapter, entityUuid?: string) { this.sqlite = sqlite; this.entityUuid = entityUuid || null; }

  /** V13: 设置当前会话的实体UUID（由 chat.ts 每轮更新） */
  setEntityUuid(uuid: string | null): void { this.entityUuid = uuid; }

  storeObjectLocation(key: string, location: string, dgId?: string, dnaId?: string): void {
    // 旧记事作废（只标记不删除，恪守「只增不删」）
    this.sqlite.writeRaw("UPDATE memories SET is_valid=0 WHERE note_key=? AND sub_type='object_location' AND is_valid=1", key);
    // 🔴 2026-09-19 批 3：收口到**唯一公共写入口**（本文件是 memories 最后一处手写列清单）。
    //   原 17 列清单缺 4 列，其中 global_uid 是**关键缺列** —— 缺它则该行落出 UID 归一化链路；
    //   writeMemory 会自动派生 global_uid（MM<sha256(id)> 前 8 位）。
    //   entity_genes / fg_entity_names / location_fingerprint 为 null 是**语义正确**的
    //   （记事无实体提及、无位置）。
    //   以下三处为**有意对齐**规范写入口的默认口径，非副作用：
    //     thread_id：原 NULL → 现 dialogGroupId ?? id；confidence_score：0.5 → 0.55；
    //     stability_score：0.5 → 0.2（钙化 0 的记事）。
    this.sqlite.writeMemory({
      id: noteId(),
      seqPos: Date.now(),
      createdAt: new Date().toISOString(),
      perceptionV40: encodeEmptyPerceptionV40(),
      calciumScore: 0,
      calciumLevel: 0,
      locusPath: 'note.memory',
      leafZone: 'note_zone',
      rawInput: location,
      primaryEmotion: '中性',
      memoryType: 'note',
      subType: 'object_location',
      noteKey: key,
      isValid: 1,
      dialogGroupId: dgId ?? null,
      dnaRootId: dnaId ?? null,
      belongEntityUuid: this.entityUuid,
    });
  }

  getObjectLocation(key: string): NoteMemory | null {
    const rows = this.sqlite.queryAll<NoteMemory>(
      "SELECT id,memory_type,sub_type,note_key,raw_input,is_valid,remind_at,reminded,repeat_rule,dialog_group_id,dna_root_id,created_at FROM memories WHERE note_key=? AND sub_type='object_location' AND is_valid=1 ORDER BY created_at DESC LIMIT 1",
      [key],
    );
    return rows.length > 0 ? rows[0] : null;
  }

  storeFact(key: string, fact: string, dgId?: string, dnaId?: string): void {
    // 旧记事作废（只标记不删除）
    this.sqlite.writeRaw("UPDATE memories SET is_valid=0 WHERE note_key=? AND sub_type='fact' AND is_valid=1", key);
    // 🔴 2026-09-19 批 3：收口到唯一公共写入口（口径与 storeObjectLocation 一致，详见该处注释）
    this.sqlite.writeMemory({
      id: noteId(),
      seqPos: Date.now(),
      createdAt: new Date().toISOString(),
      perceptionV40: encodeEmptyPerceptionV40(),
      calciumScore: 0,
      calciumLevel: 0,
      locusPath: 'note.memory',
      leafZone: 'note_zone',
      rawInput: fact,
      primaryEmotion: '中性',
      memoryType: 'note',
      subType: 'fact',
      noteKey: key,
      isValid: 1,
      dialogGroupId: dgId ?? null,
      dnaRootId: dnaId ?? null,
      belongEntityUuid: this.entityUuid,
    });
  }

  getFact(key: string): NoteMemory | null {
    const rows = this.sqlite.queryAll<NoteMemory>(
      "SELECT id,memory_type,sub_type,note_key,raw_input,is_valid,remind_at,reminded,repeat_rule,dialog_group_id,dna_root_id,created_at FROM memories WHERE note_key=? AND sub_type='fact' AND is_valid=1 ORDER BY created_at DESC LIMIT 1",
      [key],
    );
    return rows.length > 0 ? rows[0] : null;
  }

  setReminder(text: string, remindAt: string, repeatRule?: string, dgId?: string, dnaId?: string): NoteMemory {
    const id = noteId();
    const now = new Date().toISOString();
    // 🔴 2026-09-19 批 3：收口到唯一公共写入口（口径与 storeObjectLocation/storeFact 一致）。
    //   原 20 列清单同样缺 entity_genes/fg_entity_names/global_uid/location_fingerprint。
    this.sqlite.writeMemory({
      id,
      seqPos: Date.now(),
      createdAt: now,
      perceptionV40: encodeEmptyPerceptionV40(),
      calciumScore: 0,
      calciumLevel: 0,
      locusPath: 'note.memory',
      leafZone: 'note_zone',
      rawInput: text,
      primaryEmotion: '中性',
      memoryType: 'note',
      subType: 'reminder',
      noteKey: text,
      isValid: 1,
      remindAt,
      reminded: 0,
      repeatRule: repeatRule ?? null,
      dialogGroupId: dgId ?? null,
      dnaRootId: dnaId ?? null,
      belongEntityUuid: this.entityUuid,
    });
    return { id, memory_type: 'note', sub_type: 'reminder', note_key: text, raw_input: text,
      is_valid: 1, remind_at: remindAt, reminded: 0, repeat_rule: repeatRule ?? null,
      dialog_group_id: dgId ?? null, dna_root_id: dnaId ?? null, created_at: now };
  }

  getPendingReminders(): NoteMemory[] {
    return this.sqlite.queryAll<NoteMemory>(
      "SELECT id,memory_type,sub_type,note_key,raw_input,is_valid,remind_at,reminded,repeat_rule,dialog_group_id,dna_root_id,created_at FROM memories WHERE memory_type='note' AND sub_type='reminder' AND reminded=0 AND is_valid=1 AND remind_at IS NOT NULL AND remind_at<=? ORDER BY remind_at ASC",
      [new Date().toISOString()],
    );
  }

  markReminded(id: string): void { this.sqlite.writeRaw("UPDATE memories SET reminded=1 WHERE id=?", id); }
  markInvalid(id: string): void { this.sqlite.writeRaw("UPDATE memories SET is_valid=0 WHERE id=?", id); }

  search(query: string, limit = 3): NoteMemory[] {
    if (!query.trim()) return [];
    const q = query.trim();
    const rows = this.sqlite.queryAll<NoteMemory>(
      "SELECT id,memory_type,sub_type,note_key,raw_input,is_valid,remind_at,reminded,repeat_rule,dialog_group_id,dna_root_id,created_at FROM memories WHERE memory_type='note' AND is_valid=1 AND (note_key LIKE '%' || ? || '%' OR raw_input LIKE '%' || ? || '%') ORDER BY created_at DESC LIMIT ?",
      [q, q, limit],
    );
    return rows;
  }

  checkMissedOnStartup(): string[] {
    const logs: string[] = [];
    const now = Date.now();
    const pending = this.sqlite.queryAll<any>("SELECT id, raw_input, remind_at FROM memories WHERE memory_type='note' AND sub_type='reminder' AND reminded=0 AND is_valid=1 AND remind_at IS NOT NULL");
    for (const r of pending) {
      const delay = now - new Date(r.remind_at).getTime();
      if (delay < 0) continue;
      if (delay < 5 * 60 * 1000) logs.push(`⏰ 补发提醒: ${r.raw_input} (延误 ${Math.round(delay / 1000)}s)`);
      else if (delay < 30 * 24 * 60 * 60 * 1000) { this.sqlite.writeRaw("UPDATE memories SET reminded=1 WHERE id=?", r.id); logs.push(`⏰ 跳过过期提醒: ${r.raw_input}`); }
      else { this.sqlite.writeRaw("UPDATE memories SET is_valid=0 WHERE id=?", r.id); logs.push(`🗑 清理超期提醒: ${r.raw_input}`); }
    }
    return logs;
  }

  cleanExpired(days = 365): number {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    this.sqlite.writeRaw("DELETE FROM memories WHERE memory_type='note' AND is_valid=0 AND created_at<?", cutoff);
    return this.sqlite.queryAll<any>("SELECT changes() as c")[0]?.c || 0;
  }
}
