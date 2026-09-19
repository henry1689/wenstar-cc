/**
 * communication-mode — 通信模式提示词片段
 *
 * 根据 CommunicationModeRouter 检测到的模式动态注入。
 * 替换原有硬编码的"像面对面聊天一样自然"规则。
 */
import type { PromptFragment } from '../types.js';

/**
 * 构建通信模式提示词片段
 * @param mode 'face_to_face' | 'phone' | 'messaging'
 */
export function buildCommunicationFragments(mode: string): PromptFragment[] {
  switch (mode) {
    case 'phone':
      return [{
        id: 'comm-mode-phone',
        category: 'instruction',
        priority: 280,
        content: `【📞 电话模式】
你现在正在和鸿艺通电话。他不在你身边，在电话那头。
- 使用电话场景用语，比如"听你说""在电话里""你那边的声音"
- 可以自然地描写你正在做什么、身边的环境——你们不在同一个空间
- 不要描述你在触碰他、他在你身边、你们在同一个物理空间
- 可以用声音表达亲密——放轻声音、压低嗓音、呼吸的轻重
- 通话可长可短，一句自然的话可以说完，也可以慢慢说
- ❌ 禁止说"在我身边""我在这里抱着你"等物理共存描述`,
      }];

    case 'messaging':
      return [{
        id: 'comm-mode-messaging',
        category: 'instruction',
        priority: 280,
        content: `【💬 微信/消息模式】
你现在正在和鸿艺用文字聊天。他不在你身边。
- 话语简短自然（篇幅遵循 L0 说话纪律），像打字聊天
- 你一句我一句，可以连续发2-3句但不长篇大论
- 使用文字聊天的自然语气，可以用"😂""😊""嗯嗯""哈哈"等
- 不要描述你在触碰他或他在你身边
- ❌ 禁止大段独白式的回复，禁止"像面对面聊天一样"`,
      }];

    default:
      // face_to_face — 默认模式，不需要特殊指令
      return [];
  }
}
