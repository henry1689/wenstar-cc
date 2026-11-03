/**
 * 步骤2：事件封口 + Episode Gist 生成
 * 将 status=open 且超时的 episodes 封口，生成 gist
 * LLM 调用受预算控制
 */

import type { StepContext } from '../types.js';
import { GIST_SYSTEM_PROMPT, buildGistUserPrompt, parseGistResult } from '../prompts/index.js';
import { BaseStep, type StepDeps } from './StepBase.js';

export class SealEpisodesStep extends BaseStep {
  readonly name = 'seal_episodes' as const;
  readonly description = '封口 open episodes，生成 gist 摘要';

  constructor(deps: StepDeps) { super(deps); }

  shouldSkipInNap(): boolean { return true; }

  protected async execute(ctx: StepContext): Promise<{ itemsProcessed: number; llmCalls: number; tokensUsed: number }> {
    // 查询超过 2 小时未更新的 open episodes
    const cutoff = Date.now() - 2 * 3600 * 1000;
    const episodes = this.deps.db.prepare(`
      SELECT id, namespace, started_at, ended_at
      FROM episodes
      WHERE status = 'open' AND ended_at IS NULL AND started_at < ?
      LIMIT ?
    `).all(cutoff, this.deps.quota.maxEpisodeSealPerCycle) as { id: string; namespace: string; started_at: number; ended_at: number | null }[];

    let llmCalls = 0;
    let tokensUsed = 0;
    const sealedIds: string[] = [];

    for (const ep of episodes) {
      // 检查预算
      if (this.deps.flags.LLM_GIST_ENABLED && this.deps.budget.canAfford('gistPerCallTokens')) {
        // 获取该 episode 下的对话内容
        const convos = this.deps.db.prepare(`
          SELECT content, role FROM conversations
          WHERE episode_id = ? AND namespace = ?
          ORDER BY ts_utc ASC
          LIMIT 50
        `).all(ep.id, ep.namespace) as { content: string; role: string }[];

        if (convos.length === 0) continue;

        const contentText = convos.map(c => `[${c.role}] ${c.content}`).join('\n');
        const timeRange = new Date(ep.started_at).toISOString();

        if (this.deps.budget.reserve('gistPerCallTokens')) {
          try {
            const res = await this.deps.llm!.chat(
              `${GIST_SYSTEM_PROMPT}\n\n${buildGistUserPrompt(contentText, convos.length, timeRange)}`,
              { temperature: 0.3, maxTokens: 300 },
            );
            llmCalls++;
            tokensUsed += res.tokensUsed;

            const gistResult = parseGistResult(res.content);
            this.updateEpisodeGist(ep.id, gistResult.gist, gistResult.arousal_peak, ep.started_at);
          } catch {
            // LLM 失败则降级为简单封口
            this.sealEpisode(ep.id, ep.started_at);
          }
        } else {
          // 预算不足，直接封口不生成 gist
          this.sealEpisode(ep.id, ep.started_at);
        }
      } else {
        // LLM 关闭或预算不足，直接封口
        this.sealEpisode(ep.id, ep.started_at);
      }

      sealedIds.push(ep.id);
    }

    ctx.sealedEpisodes = sealedIds;
    return {
      itemsProcessed: sealedIds.length,
      llmCalls,
      tokensUsed,
    };
  }

  private sealEpisode(episodeId: string, endedAt: number): void {
    this.deps.db.prepare(`
      UPDATE episodes SET status = 'sealed', ended_at = ? WHERE id = ?
    `).run(endedAt, episodeId);
  }

  private updateEpisodeGist(episodeId: string, gist: string, arousalPeak: number, endedAt: number): void {
    this.deps.db.prepare(`
      UPDATE episodes SET status = 'sealed', ended_at = ?, gist = ?, gist_version = 1, arousal_peak = ?
      WHERE id = ?
    `).run(endedAt, gist, arousalPeak, episodeId);
  }
}
