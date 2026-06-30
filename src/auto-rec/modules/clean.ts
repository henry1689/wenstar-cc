/**
 * AutoRec — M-01 素材清洗模块
 *
 * 包装 ingestion-guard + MemoryGate 的现有规则
 * S2.2 首批 3 子模块
 */
import type { AutoRecModule, PipelineContext, CleanInput, CleanOutput } from '../types.js';
import { getQueue } from '../../hooks/queue.js';

export class CleanModule implements AutoRecModule<CleanInput, CleanOutput> {
  id = 'clean';
  name = '素材清洗';

  async execute(input: CleanInput, context: PipelineContext): Promise<CleanOutput> {
    const _hq = getQueue();
    const _hstart = Date.now();
    const text = (input.rawInput || '').trim();

    // 基本安全清洗
    const isSensitive = text.length > 5000;
    const cleanedText = isSensitive ? text.substring(0, 5000) : text;

    // 日常闲聊检测（复制 chat.ts L621-L622 的 isCasualChat 正则）
    const isCasual = /^(在干嘛|忙什么|吃了吗|睡了|晚安|早安|早上好|晚上好|刚起来|下班|到家|今天天气|好开心|好累|心情|感觉|嗯|好|行|对|是|好的|知道了|没事|算了|哈哈|嘿嘿|哎|唉)$/i.test(cleanedText)
      || (cleanedText.length < 10 && /今天|天气|吃|睡|累|困|忙|下班|到家|早安|晚安/.test(cleanedText));

    // 模式分类（简化版 MemoryGate）
    let mode: CleanOutput['mode'] = 'casual';
    if (/知识库|知道吗|查一下|是什么/.test(cleanedText)) mode = 'knowledge_query';
    else if (/上次|你记不记得|后来呢|那个店|那个人/.test(cleanedText)) mode = 'memory_recall';
    else if (isCasual) mode = 'casual';
    else mode = 'memory_recall';  // 默认

    // 安全标签
    const safetyTags: string[] = [];
    if (isSensitive) safetyTags.push('truncated');
    if (cleanedText.length < 2) safetyTags.push('too_short');
    if (/银行卡|密码|身份证|手机号|地址/.test(cleanedText)) safetyTags.push('contains_pii');

    const result: CleanOutput = {
      cleanedText,
      safetyTags,
      isSensitive,
      isCasual,
      mode,
    };

    // H01 🪝 素材清洗完成
    _hq.push({
      operation_type: 'module_clean', duration_ms: Date.now() - _hstart,
      status: 'success', timestamp: new Date().toISOString(),
      input_tags: mode ? [mode] : undefined,
    }).catch(() => {});

    return result;
  }
}
