/**
 * AutoRec — M-03 DNA编码生成模块
 *
 * 包装 M1 DNAEncoder 现有规则
 * S2.2 首批 3 子模块
 */
import type { AutoRecModule, PipelineContext, EncodeInput, EncodeOutput } from '../types.js';
import { DNAEncoder } from '../../m1/DNAEncoder.js';
import { getQueue } from '../../hooks/queue.js';

const DEFAULT_SELF_MODEL = {
  identity: { name: '玉瑶', persona: 'lover', birth_date: '2026-01-01' },
  traits: { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, neuroticism: 0.5 },
  boundaries: [],
  preferences: { likes: [], dislikes: [] },
  narrative_identity: 'lover',
};

export class EncodeModule implements AutoRecModule<EncodeInput, EncodeOutput> {
  id = 'encode';
  name = 'DNA编码生成';

  private encoder: DNAEncoder | null = null;

  private getEncoder(selfModel: any): DNAEncoder {
    if (!this.encoder) {
      this.encoder = new DNAEncoder(selfModel || DEFAULT_SELF_MODEL);
    }
    return this.encoder;
  }

  async execute(input: EncodeInput, context: PipelineContext): Promise<EncodeOutput> {
    const _hq = getQueue();
    const _hstart = Date.now();
    const encoder = this.getEncoder(input.selfModel);
    const dna = encoder.encodeSingle(input.text);

    const result = { dna, branch_id: dna.branch_id, seq_pos: dna.seq_pos, locus_path: dna.locus_path };

    // H05 🪝 DNA编码生成
    _hq.push({
      operation_type: 'module_encode', duration_ms: Date.now() - _hstart,
      status: 'success', dna_code: dna.branch_id, timestamp: new Date().toISOString(),
    }).catch(() => {});

    return result;
  }
}
