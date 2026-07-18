/**
 * server-household-routes.ts — 户籍管理体系 HTTP API
 * ====================================================
 *
 * GET  /api/household/dashboard     → 管理仪表板（分类分布/完整度排行/dormant预警）
 * GET  /api/household/persons       → 全部在册人员列表
 * GET  /api/household/person?name=  → 单个人完整户籍档案
 * GET  /api/household/pending       → 待采集字段统计
 * GET  /api/household/recent        → 最近N天未提及的人物
 */
import http from 'node:http';

type HouseholdRouteDeps = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  storage?: any;
  readBody(req: http.IncomingMessage): Promise<string>;
};

export async function handleHouseholdRoutes(deps: HouseholdRouteDeps): Promise<boolean> {
  const { req, res, url } = deps;

  try {
    const fg = (globalThis as any).__familyGraph;
    if (!fg || typeof fg.getAllPersonNames !== 'function') return false;

    // ── 管理仪表板 ──
    if (req.method === 'GET' && url.pathname === '/api/household/dashboard') {
      const allNames: string[] = fg.getAllPersonNames?.() || [];
      const persons = allNames
        .filter((n: string) => n !== '我')
        .map((name: string) => {
          try {
            const profile = fg.getPersonProfile?.(name);
            const d = profile?.dossier || {};
            const si = d.socialIdentity || {};
            const bi = d.basicInfo || {};

            // P0 采集度
            const p0Fields = ['gender', 'birthYear', 'ethnicity', 'birthPlace'];
            const p0Filled = p0Fields.filter((k: string) => {
              if (k === 'gender') return !!bi.gender;
              if (k === 'birthYear') return !!(bi.birthYear || profile?.birthYear);
              if (k === 'ethnicity') return !!bi.ethnicity;
              if (k === 'birthPlace') return !!bi.birthPlace;
              return false;
            }).length;

            // 获取状态和分类
            let status = 'active';
            let category = 'G';
            let lastMentioned = '';
            try {
              const raw = (fg as any).query?.(
                "SELECT status, category, updated_at FROM nodes WHERE name = ? AND type = 'person'",
                [name]
              );
              if (raw?.[0]) {
                status = raw[0].status || 'active';
                category = raw[0].category || 'G';
                lastMentioned = raw[0].updated_at || '';
              }
            } catch { /* ignore */ }

            const daysSinceMention = lastMentioned
              ? Math.floor((Date.now() - new Date(lastMentioned).getTime()) / 86400000)
              : 999;

            return {
              name,
              category,
              status,
              p0Score: p0Filled,
              p0Total: 4,
              completeness: profile?.completeness || 0,
              relationToUser: profile?.relation_to_user || '',
              occupation: si.currentOccupation || profile?.occupation || '',
              lastMentioned: lastMentioned?.substring(0, 10) || '',
              daysSinceMention,
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      // 全局统计
      const categoryCounts: Record<string, number> = {};
      const statusCounts: Record<string, number> = {};
      for (const p of persons) {
        const cat = (p as any).category || 'G';
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
        const st = (p as any).status || 'active';
        statusCounts[st] = (statusCounts[st] || 0) + 1;
      }

      // 完整度排行
      const byCompleteness = [...persons].sort((a: any, b: any) => b.completeness - a.completeness).slice(0, 10);
      // 最近未提及（dormant 预警）
      const dormantWarnings = persons
        .filter((p: any) => p.daysSinceMention > 60 && p.status === 'active')
        .sort((a: any, b: any) => b.daysSinceMention - a.daysSinceMention)
        .slice(0, 10);

      // P0 不完整排行
      const byP0Gaps = [...persons]
        .filter((p: any) => p.p0Score < 4)
        .sort((a: any, b: any) => a.p0Score - b.p0Score)
        .slice(0, 10);

      const dashboard = {
        summary: {
          totalPersons: persons.length,
          categoryDistribution: categoryCounts,
          statusDistribution: statusCounts,
        },
        topComplete: byCompleteness,
        dormantWarnings,
        p0Gaps: byP0Gaps,
        allPersons: persons,
      };

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(dashboard));
      return true;
    }

    // ── 全部在册人员列表（简化版）──
    if (req.method === 'GET' && url.pathname === '/api/household/persons') {
      const allNames: string[] = fg.getAllPersonNames?.() || [];
      const list = allNames
        .filter((n: string) => n !== '我')
        .map((name: string) => {
          try {
            const profile = fg.getPersonProfile?.(name);
            const d = profile?.dossier || {};
            return {
              name,
              uuid: (fg as any).getUUIDByName?.(name) || '',
              category: (profile as any)?.category || 'G',
              relationToUser: profile?.relation_to_user || '',
              occupation: d.socialIdentity?.currentOccupation || profile?.occupation || '',
              completeness: profile?.completeness || 0,
            };
          } catch {
            return { name, uuid: '', category: 'G' };
          }
        });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ total: list.length, persons: list }));
      return true;
    }

    // ── 单人完整户籍档案 ──
    if (req.method === 'GET' && url.pathname === '/api/household/person') {
      const name = url.searchParams.get('name') || '';
      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'name required' }));
        return true;
      }

      const profile = fg.getPersonProfile?.(name);
      if (!profile) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `person not found: ${name}` }));
        return true;
      }

      const uuid = (fg as any).getUUIDByName?.(name) || '';
      const status = (fg as any).getRegistrationStatus?.(name) || {};
      const related = fg.getRelatedPersons?.(name) || [];
      const household = profile?.dossier?.misc?._household || null;
      const socialGroups = profile?.dossier?.misc?._socialGroups || [];

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        name,
        uuid,
        registration: {
          status,
          profile: {
            relationToUser: profile.relation_to_user,
            dossier: profile.dossier,
          },
        },
        household,
        socialGroups,
        relatedPersons: related.slice(0, 20).map((p: any) => ({
          name: p.name || p.entity,
          relation: p.relation || '',
        })),
        changeHistory: (profile as any)._changeHistory?.slice(-20) || [],
      }));
      return true;
    }

    // ── 待采集字段统计 ──
    if (req.method === 'GET' && url.pathname === '/api/household/pending') {
      const allNames: string[] = fg.getAllPersonNames?.() || [];
      const pendingList: any[] = [];

      for (const name of allNames) {
        if (name === '我') continue;
        try {
          const regStatus = (fg as any).getRegistrationStatus?.(name);
          if (regStatus?.pendingFields?.length > 0) {
            pendingList.push({
              name,
              pendingCount: regStatus.pendingFields.length,
              pendingFields: regStatus.pendingFields,
              completenessScore: regStatus.completenessScore,
            });
          }
        } catch { /* ignore */ }
      }

      pendingList.sort((a, b) => b.pendingCount - a.pendingCount);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ total: pendingList.length, persons: pendingList }));
      return true;
    }

    // ── 最近N天未提及的人物 ──
    if (req.method === 'GET' && url.pathname === '/api/household/trends') {
      const tName: string = url.searchParams.get('name') || '';
      const tDays: number = parseInt(url.searchParams.get('days') || '90', 10);
      const allN2: string[] = fg.getAllPersonNames?.() || [];
      const targets: string[] = tName ? [tName].filter((n: string) => allN2.includes(n)) : allN2.filter((n: string) => n !== '我');
      const trends: any[] = [];
      const cutoff: number = Date.now() - tDays * 86400000;
      for (const target of targets) {
        try {
          const prof2 = fg.getPersonProfile?.(target);
          const hist: any[] = (prof2 as any)?._changeHistory || [];
          const recent: any[] = hist.filter((h: any) => new Date(h.time || h.timestamp || 0).getTime() > cutoff);
          if (recent.length === 0) continue;
          const byField: Record<string, number> = {};
          for (const h of recent) { const f: string = h.field || '?'; byField[f] = (byField[f] || 0) + 1; }
          trends.push({ name: target, totalChanges: hist.length, recentChanges: recent.length, period: tDays + '天', topFields: Object.entries(byField).sort((a,b) => b[1] - a[1]).slice(0, 5), latest: recent.slice(-3) });
        } catch(e) {}
      }
      trends.sort((a: any, b: any) => b.recentChanges - a.recentChanges);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ period: tDays + '天', persons: trends }));
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/household/recent') {
      const days = parseInt(url.searchParams.get('days') || '30', 10);
      const allNames: string[] = fg.getAllPersonNames?.() || [];
      const now = Date.now();

      const notMentioned: any[] = [];
      for (const name of allNames) {
        if (name === '我') continue;
        try {
          const raw = (fg as any).query?.(
            "SELECT name, category, status, updated_at FROM nodes WHERE name = ? AND type = 'person'",
            [name]
          );
          if (raw?.[0]) {
            const updatedAt = raw[0].updated_at;
            const daysSince = updatedAt
              ? Math.floor((now - new Date(updatedAt).getTime()) / 86400000)
              : 999;
            if (daysSince > days) {
              notMentioned.push({
                name,
                category: raw[0].category,
                status: raw[0].status,
                daysSinceMention: daysSince,
                lastMentioned: updatedAt?.substring(0, 10) || '',
              });
            }
          }
        } catch { /* ignore */ }
      }

      notMentioned.sort((a, b) => b.daysSinceMention - a.daysSinceMention);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ threshold: `${days}天`, count: notMentioned.length, persons: notMentioned }));
      return true;
    }

  } catch { /* 模块未就绪 */ }

  return false;
}
