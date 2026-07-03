/**
 * ReadinessGate — 角色扮演域·数据就绪门（第二步）
 *
 * 职责：在 LLM 生成之前，检查数据是否足够回答用户问题。
 * 如果不够，直接注入明确措辞，不让 LLM 自己决定要不要编造。
 */
import type { CollectedData, ReadinessDecision } from './types.js';

/**
 * 数据就绪判定
 * 按用户意图分类，逐项检查数据是否完备。
 */
export function checkReadiness(data: CollectedData): ReadinessDecision {
  const missingFields: string[] = [];
  const constraints: string[] = [];
  let antiFabricationGuard = '';

  const intent = data.context.intent;

  switch (intent) {
    case 'ask_person':
      if (!data.knownFields.askedPersonFound) {
        missingFields.push('askedPersonFound');
        antiFabricationGuard = '【⚠️ 反编造铁律】用户问了你关于某个人的信息，但你对这个人一无所知。请直接回答"我不清楚""没听说过"或"记不起来了"。绝对不能编造任何名字、关系、经历。';
      }
      break;

    case 'ask_age':
      if (!data.knownFields.hasAge) {
        missingFields.push('hasAge');
        antiFabricationGuard = '【⚠️ 反编造铁律】用户问你的年龄，但你不知道自己多少岁。请直接回答"你没告诉过我，我记不太清了"或"你提醒我一下好不好？"。绝对不能编造任何数字。';
      } else {
        constraints.push('【回答要求】你知道自己的年龄，请根据设定中的年龄回答，不要说出其他年龄。');
      }
      break;

    case 'ask_background':
      if (!data.knownFields.hasPersonality && !data.knownFields.hasAppearance) {
        missingFields.push('hasPersonality', 'hasAppearance');
        antiFabricationGuard = '【⚠️ 反编造铁律】用户让你介绍自己，但你对自己的事情了解有限。请回答"我的事你不是都知道嘛，你想听哪方面"或"你提醒我一下，我记不太清了"。绝对不能编造具体的经历、喜好、性格描述。';
      }
      break;

    case 'ask_relation':
      if (!data.knownFields.hasRelations && !data.knownFields.askedPersonFound) {
        missingFields.push('hasRelations');
        antiFabricationGuard = '【⚠️ 反编造铁律】用户问起某个人的关系，但你对此人没有了解。请直接回答"我不太清楚""没听说过这个人"或"记不起来了"。绝对不能编造关系、名字、故事。';
      }
      break;

    case 'chat':
      // 普通聊天不做约束
      break;
  }

  const canAnswer = missingFields.length === 0;

  return { canAnswer, missingFields, constraints, antiFabricationGuard };
}
