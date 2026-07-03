/**
 * FourLayerAssembler — 四层结构化装配基类
 *
 * 通用认知框架：所有智体（玉瑶本体 / 角色扮演角色）共享此结构。
 *
 * ── 四层结构 ──
 * Layer 1: 核心身份层（常驻必选）— 姓名/年龄/人设/规则
 * Layer 2: 关系常驻层（常驻必选）— 核心亲属+关系状态
 * Layer 3: 记忆激活层（动态必选）— 上下文+语义召回记忆
 * Layer 4: 知识背景层（按需补充）— 知识库条目
 *
 * 🔴 铁律：
 *   1. 层级顺序不可逆 — Layer1 永远在最前
 *   2. 每层用分隔符标注边界
 *   3. Layer1+Layer2 同一会话内仅首次加载
 */
export interface LayerContent {
  layer1Identity: string;     // 核心身份（常驻）
  layer2Relations: string;    // 关系摘要（常驻）
  layer3Memory: string;       // 记忆激活（动态）
  layer4Knowledge: string;    // 知识背景（按需）
}

export interface CognitiveContext {
  roleplay: string;           // 当前角色名
  identity: string;           // 核心身份文本
  relations: string;          // 关系摘要文本
  memories: string[];         // 召回的记忆列表
  knowledge: string[];        // 知识库条目
}

/**
 * 装配为完整提示词
 * 顺序固定：Layer1 → Layer2 → Layer3 → Layer4
 */
export function assembleFourLayers(content: LayerContent): string {
  const parts: string[] = [];

  // Layer 1: 核心身份
  if (content.layer1Identity) {
    parts.push('【核心身份】\n' + content.layer1Identity);
  }

  // Layer 2: 关系
  if (content.layer2Relations) {
    parts.push('【人际关系】\n' + content.layer2Relations);
  }

  // Layer 3: 记忆
  if (content.layer3Memory) {
    parts.push('【相关记忆】\n' + content.layer3Memory);
  }

  // Layer 4: 知识
  if (content.layer4Knowledge) {
    parts.push('【知识背景】\n' + content.layer4Knowledge);
  }

  return parts.join('\n\n---\n\n');
}
