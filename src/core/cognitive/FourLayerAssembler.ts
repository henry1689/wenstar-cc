/**
 * FourLayerAssembler — 四层结构化装配基类
 *
 * 通用认知框架：所有智体（玉瑶本体 / 角色扮演角色）共享此结构。
 * 外部继承者只需传入数据层，装配逻辑由本类统一完成。
 *
 * 🔴 铁律：
 *   1. 层级顺序不可逆 — Layer1 永远在最前
 *   2. 每层用分隔符标注边界
 *   3. Layer1+Layer2 同一会话内仅首次加载（由外部调用者控制缓存）
 *   4. 结构化字段独立成行，不压缩进长段落
 */
export interface LayerContent {
  layer1Identity: string;
  layer2Relations: string;
  layer3Memory: string;
  layer4Knowledge: string;
}

/**
 * 装配为完整提示词
 * 顺序固定：Layer1 → Layer2 → Layer3 → Layer4
 */
export function assembleFourLayers(content: LayerContent): string {
  const parts: string[] = [];

  if (content.layer1Identity) {
    parts.push('【核心身份】\n' + content.layer1Identity);
  }

  if (content.layer2Relations) {
    parts.push('【人际关系】\n' + content.layer2Relations);
  }

  if (content.layer3Memory) {
    parts.push('【相关记忆】\n' + content.layer3Memory);
  }

  if (content.layer4Knowledge) {
    parts.push('【知识背景】\n' + content.layer4Knowledge);
  }

  return parts.join('\n\n---\n\n');
}
