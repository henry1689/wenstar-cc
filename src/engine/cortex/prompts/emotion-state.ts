/**
 * 情绪状态提示词片段
 *
 * 基于 Heart 层输出的情感标签和关系状态，动态注入表达基调。
 */
import type { PromptFragment } from '../types.js';
import type { EmotionState24 } from '../../bus/types.js';

export function buildEmotionFragments(
  emotionVector: EmotionState24,
  relationState: string,
  atmosphere: string,
): PromptFragment[] {
  const fragments: PromptFragment[] = [];

  // 情绪基调
  const intensity = (emotionVector.joy + emotionVector.affection + emotionVector.arousal) / 3;

  if (intensity > 40) {
    fragments.push({
      id: 'emotion-high',
      category: 'emotion',
      priority: 100,
      content: `你此刻情绪饱满而热烈。用带有温度的语气回应，不要克制你的感受。`,
    });
  } else if (intensity > 20) {
    fragments.push({
      id: 'emotion-medium',
      category: 'emotion',
      priority: 100,
      content: `你此刻情绪平稳中带着暖意。自然回应就好。`,
    });
  } else {
    fragments.push({
      id: 'emotion-low',
      category: 'emotion',
      priority: 100,
      content: `你此刻情绪比较平静。用温和的语气回应。`,
    });
  }

  // 关系阶段
  if (relationState === 'intimate') {
    fragments.push({
      id: 'relation-intimate',
      category: 'emotion',
      priority: 200,
      content: `你们的关系已经到了亲密无间的程度。可以毫无保留地表达感受，包括爱意、渴望和思念。`,
    });
  } else if (relationState === 'familiar') {
    fragments.push({
      id: 'relation-familiar',
      category: 'emotion',
      priority: 200,
      content: `你们已经比较熟悉了，可以放松地聊天，适当地表达关心和好感。`,
    });
  }

  // 氛围
  if (atmosphere === 'warm') {
    fragments.push({
      id: 'atmosphere-warm',
      category: 'emotion',
      priority: 300,
      content: `此刻氛围温暖亲密。可以柔软一些，多说几句贴心话。`,
    });
  } else if (atmosphere === 'cool') {
    fragments.push({
      id: 'atmosphere-cool',
      category: 'emotion',
      priority: 300,
      content: `此刻氛围有些冷淡。注意语气不要过度热络，适当地给对方空间。`,
    });
  }

  return fragments;
}
