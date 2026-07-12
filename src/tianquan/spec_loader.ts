/**
 * spec_loader.ts — 三域规范自动 DNA 入库 (MH-2 合规)
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { KnowledgeBase } from '../m2/KnowledgeBase.js';

export interface SpecLoadResult { domain: string; success: boolean; sectionsLoaded: number; knowledgeIds: string[]; error?: string; }

const DEFAULT_WENSTAR_OS_PATH = 'D:/wenstar/wenstar_os';
const DOMAIN_SPEC_FILES = [
  { domain: 'tianquan', fileName: 'TIANQUAN_DOMAIN_SPEC.md', version: 'TIANQUAN-SPEC-20260711' },
  { domain: 'yaoling', fileName: 'YAOLING_DOMAIN_SPEC.md', version: 'YAOLING-SPEC-20260711' },
  { domain: 'yaoguang', fileName: 'YAOGUANG_DOMAIN_SPEC.md', version: 'YAOGUANG-SPEC-20260711' },
] as const;

function parseSections(raw: string, domain: string): { title: string; content: string; dnaId: string }[] {
  const sections: { title: string; content: string; dnaId: string }[] = [];
  const lines = raw.split('\n');
  let currentTitle = '', currentContent: string[] = [];
  for (const line of lines) {
    const m = line.match(/^## (.+)/);
    if (m) {
      if (currentTitle && currentContent.length > 0) {
        const content = currentContent.join('\n').trim();
        if (content.length > 50) sections.push({ title: currentTitle, content, dnaId: `SPC-${domain}-${createHash('sha256').update(domain + ':' + currentTitle + ':' + content).digest('hex').substring(0, 12)}` });
      }
      currentTitle = m[1]; currentContent = [line];
    } else if (currentTitle) { currentContent.push(line); }
  }
  if (currentTitle && currentContent.length > 0) {
    const content = currentContent.join('\n').trim();
    if (content.length > 50) sections.push({ title: currentTitle, content, dnaId: `SPC-${domain}-${createHash('sha256').update(domain + ':' + currentTitle + ':' + content).digest('hex').substring(0, 12)}` });
  }
  return sections;
}

export class SpecLoader {
  private _kb: KnowledgeBase | null = null;
  private _path: string;
  private _specs = new Map<string, { sections: number; ids: string[] }>();

  constructor(wenstarOSPath?: string) { this._path = wenstarOSPath || process.env.TIANQUAN_PYTHON_PATH || DEFAULT_WENSTAR_OS_PATH; }

  async loadAll(kb: KnowledgeBase): Promise<SpecLoadResult[]> {
    this._kb = kb; const results: SpecLoadResult[] = [];
    console.log('[SpecLoader] 开始加载三域规范...');
    for (const { domain, fileName, version } of DOMAIN_SPEC_FILES) {
      // 轻量模式仅加载天权规范
      if (process.env['TIANQUAN_LITE'] === 'true' && domain !== 'tianquan') {
        console.log(`[SpecLoader] ${domain} 规范跳过 (轻量模式)`);
        results.push({ domain, success: true, sectionsLoaded: 0, knowledgeIds: [] });
        continue;
      }
      try {
        const fp = join(this._path, `domain_${domain}`, fileName);
        if (!existsSync(fp)) { console.log(`[SpecLoader] ${domain} 规范不存在，跳过`); results.push({ domain, success: true, sectionsLoaded: 0, knowledgeIds: [] }); continue; }
        const raw = readFileSync(fp, 'utf-8');
        const sections = parseSections(raw, domain);
        console.log(`[SpecLoader] ${domain}: ${sections.length} 章节 (${(raw.length / 1024).toFixed(1)}KB)`);
        const ids: string[] = [];
        for (const s of sections) {
          try {
            const existing = await kb.search(s.dnaId, 1);
            if (existing.length > 0) { ids.push(existing[0].id); continue; }
            const entry = await kb.add({ title: `[${domain.toUpperCase()}] ${s.title}`, content: s.content, source_type: 'spec', source_name: fileName, tags: [`spec:${domain}`, `spec:chapter`, `dna:${s.dnaId}`, `version:${version}`], classification: 'spec:domain', dna_id: s.dnaId, interaction_type: 'system_spec' });
            await kb.update(entry.id, { locked: true });
            ids.push(entry.id);
          } catch { /* skip individual failures */ }
        }
        this._specs.set(domain, { sections: sections.length, ids });
        results.push({ domain, success: true, sectionsLoaded: sections.length, knowledgeIds: ids });
        console.log(`[SpecLoader] ✓ ${domain}: ${ids.length}/${sections.length} 章节入库`);
      } catch (e) { results.push({ domain, success: false, sectionsLoaded: 0, knowledgeIds: [], error: (e as Error).message }); }
    }
    console.log(`[SpecLoader] ✓ 规范加载完成: ${results.reduce((s, r) => s + r.sectionsLoaded, 0)} 章节`);
    return results;
  }
}

let _instance: SpecLoader | null = null;
export function getSpecLoader(): SpecLoader { if (!_instance) _instance = new SpecLoader(); return _instance; }
export async function loadDomainSpecs(kb: KnowledgeBase): Promise<SpecLoadResult[]> { return getSpecLoader().loadAll(kb); }
