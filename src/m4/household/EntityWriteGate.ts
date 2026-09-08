/**
 * EntityWriteGate — FG 实体写前统一合规闸门 (FG治理 P0, 根治乱提取)
 * =================================================================
 * 诊断实锤(2026-09-09): 实体/档案提取链 5 个写入点各自为政无统一闸门,
 *   一段 LLM 外貌描述被逗号切 12 块全 INSERT object(103886-103897),
 *   整句"说说你的胸怎么这么小"被建档, object 垃圾率 77%。
 *
 * 职责: 所有实体写入 entities 表前必须经本闸门(唯一收口)。
 *   - person 模式: 复用 EntityCandidateGrader.gradeEntity(姓氏表+停用词+句子片段拦截, L3+)。
 *   - object 模式: 拦截句子片段/对话残留/超长/外貌特征词尾(特征应存 FG 特征边, 非独立实体)。
 * 零硬编码人名/特征词之外的清单: 全部来自 app-identity.ENTITY_BLACKLIST + 本模块特征尾词(类别级,非人名)。
 * 返回 { allowed, reason, mode }, 永不抛异常(调用方依据 verdict skip 写入 + audit 日志)。
 */

import { gradeEntity } from '../../app/entity/EntityCandidateGrader.js';
import { ENTITY_BLACKLIST } from '../../config/app-identity.js';

/** 称谓扩展(与 GarbageEntityGuard.FG_EXTRA_BLOCK 对齐, 供 person 判定) */
const FG_EXTRA_BLOCK = new Set([
  '妈妈', '爸爸', '姐姐', '妹妹', '哥哥', '弟弟', '叔叔', '阿姨',
  '老婆', '老公', '儿子', '女儿', '爷爷', '奶奶', '外公', '外婆',
  '宝贝', '亲爱的', '心肝', '乖乖', '小鬼', '妈', '爸', '爱',
]);

/**
 * 外貌/体态/性格描述特征尾词 —— 命中则禁止作为独立 object 实体建档。
 * 这些是"人物的属性", 应存 FG dossier 字段 / FG 特征边(addFeatureEdge),
 * 建独立 object 会造成: 一段描述被逗号切 N 块全入库(垃圾 103886-103897 根因)。
 * 词表为类别级属性词(非人名), 不违反零硬编码人名原则。
 */
const APPEARANCE_FEATURE_TAIL = /(?:脸|面容|眼睛|眼皮|单眼|双眼|大眼|鼻|嘴|牙|头发|发|眼镜|皮肤|身材|胸|臀|腿|腰|肩|手|眉|睫毛|马尾|刘海|酒窝|个子|身高|体态|样子|模样|长相|气质|活泼|安静|文静|内向|可爱|漂亮|婴儿肥|红润|瓜脸)/;

/** object 候选最大中文长度(防整段描述/散文句) */
const OBJECT_MAX_LEN = 6;
/** person 候选最大中文长度(姓+名, 4字民族名以内; 超长=句子/描述段) */
const PERSON_MAX_LEN = 5;
/** 对话残留标记(描述句里常见) */
const CHAT_RESIDUE = /[，。、；：""''“”（）【】…！？的了很多把被你我她他这那在说]/;
/** object 轻量句子特征尾(不以普通名词为敌, 只拦明显句子尾巴) */
const OBJECT_FRAG_TAIL = /(?:的(?:事|话|样子|话吧)|呢|吧|啊|呀|吗|了|过|着|一下|一桩|这个|那个)$/;

export interface GateVerdict {
  allowed: boolean;
  reason: string;
  mode: 'person' | 'object';
}

/** person 写入闸门: L3 人名/已知实体放行; 称谓/黑名单/句子片段拒绝 */
export function checkPersonEntity(
  name: string,
  existingNames: Set<string> = new Set(),
): GateVerdict {
  const n = (name || '').trim();
  if (!n) return { allowed: false, reason: '空实体名', mode: 'person' };
  if (existingNames.has(n)) return { allowed: true, reason: '已登记已知实体', mode: 'person' };
  if (ENTITY_BLACKLIST.has(n) || FG_EXTRA_BLOCK.has(n)) {
    return { allowed: false, reason: `黑名单/称谓禁止: ${n}`, mode: 'person' };
  }
  // 🔴 person 长度上限: 姓+名 2-5 字(4字民族名可); 超长=句子/描述段被当人名(如"大眼睛又圆又亮"以"大"为姓误判 L3)
  if (n.length > PERSON_MAX_LEN || n.length < 2) {
    return { allowed: false, reason: `人名长度非法(${n.length}): ${n}`, mode: 'person' };
  }
  if (CHAT_RESIDUE.test(n)) {
    return { allowed: false, reason: `含对话残留/虚词: ${n}`, mode: 'person' };
  }
  const graded = gradeEntity(n, existingNames);
  if (graded.grade < 3) {
    return { allowed: false, reason: `L${graded.grade}: ${graded.reason}`, mode: 'person' };
  }
  return { allowed: true, reason: graded.reason, mode: 'person' };
}

/** object 写入闸门: 真名词放行; 句子片段/对话残留/外貌特征词/超长拒绝 */
export function checkObjectEntity(name: string): GateVerdict {
  const n = (name || '').trim();
  if (!n) return { allowed: false, reason: '空实体名', mode: 'object' };
  if (n.length > OBJECT_MAX_LEN) {
    return { allowed: false, reason: `object 超长(>${OBJECT_MAX_LEN}字): ${n} — 疑似整句/描述段`, mode: 'object' };
  }
  // 称谓词作独立 object 无意义(宿舍/游戏等真名词不受影响; ENTITY_BLACKLIST 面向 person 泛词, object 不套用防误伤)
  if (FG_EXTRA_BLOCK.has(n)) {
    return { allowed: false, reason: `称谓禁止作 object: ${n}`, mode: 'object' };
  }
  // 轻量句子特征(不以普通名词为敌): 明显句子尾巴/对话残留标点虚词
  if (OBJECT_FRAG_TAIL.test(n) || CHAT_RESIDUE.test(n)) {
    return { allowed: false, reason: `句子片段/对话残留: ${n}`, mode: 'object' };
  }
  // 🔴 外貌/性格特征词尾 → 不建独立实体(属性应存 FG dossier/特征边)
  if (APPEARANCE_FEATURE_TAIL.test(n)) {
    return { allowed: false, reason: `外貌/体态特征词: ${n} — 应存档案字段/特征边而非独立 object`, mode: 'object' };
  }
  return { allowed: true, reason: '合规 object 名词', mode: 'object' };
}

/** 统一入口(调用方不区分模式时按含姓氏判定走 person/object) */
export function checkEntityWrite(
  name: string,
  existingNames: Set<string> = new Set(),
): GateVerdict {
  const n = (name || '').trim();
  if (!n) return { allowed: false, reason: '空实体名', mode: 'object' };
  const person = checkPersonEntity(n, existingNames);
  if (person.allowed) return person;
  return checkObjectEntity(n);
}

export default { checkEntityWrite, checkPersonEntity, checkObjectEntity };
