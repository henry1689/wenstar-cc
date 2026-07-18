/**
 * RelationLabels — 关系边→中文展示标签映射表
 *
 * household/ 下 FamilyGraph._getEdgeDisplayLabel 和 EntityContextBuilder.DIRECTED_LABEL
 * 各自维护了一份相同的关系→中文映射。本模块提供唯一实现。
 *
 * 使用方：
 *   - FamilyGraph._getEdgeDisplayLabel → getRelationLabel()
 *   - EntityContextBuilder._getRelatedEdges → getRelationLabel()
 */

/** 方向感知标签：[正向标签, 反向标签] */
type DirectedPair = [string, string];

const DIRECTED_FAMILY_LABEL: Record<string, DirectedPair> = {
  'mother_of':             ['母亲',       '子女'],
  'father_of':             ['父亲',       '子女'],
  'child_of':              ['子女',       '父母'],
  'parent_of':             ['父母',       '子女'],
  'spouse_of':             ['配偶',       '配偶'],
  'sibling_of':            ['兄弟姐妹',   '兄弟姐妹'],
  'elder_sister_of':       ['姐姐',       '妹妹'],
  'younger_sister_of':     ['妹妹',       '姐姐'],
  'elder_brother_of':      ['哥哥',       '弟弟'],
  'younger_brother_of':    ['弟弟',       '哥哥'],
  'grandparent_of':        ['祖辈',       '孙辈'],
  'grandfather_of':        ['祖父',       '孙辈'],
  'grandmother_of':        ['祖母',       '孙辈'],
  'grandchild_of':         ['孙辈',       '祖辈'],
  'aunt_of':               ['姑姑/姨',   '侄甥辈'],
  'uncle_of':              ['叔叔/舅',   '侄甥辈'],
  'niece_of':              ['侄甥辈',     '姑姑/姨'],
  'nephew_of':             ['侄甥辈',     '叔叔/舅'],
};

const SOCIAL_LABEL: Record<string, string> = {
  'colleague_of':     '同事',
  'boss_of':          '上级',
  'subordinate_of':   '下属',
  'classmate_of':     '同学',
  'roommate_of':      '室友',
  'friend_of':        '朋友',
  'partner_of':       '合伙人',
  'neighbor_of':      '邻居',
  'teacher_of':       '老师',
  'student_of':       '学生',
  'client_of':        '客户',
  'comrade_of':       '战友',
  'fellow_of':        '会友',
  'competitor_of':    '竞争对手',
  'doctor_of':        '医生',
  'consultant_of':    '顾问',
  'server_of':        '服务方',
  'vendor_of':        '供应商',
  'employer_of':      '雇主',
  'employee_of':      '雇员',
  'investor_of':      '投资人',
  'supplier_of':      '供应商',
  'stranger_of':      '陌生人',
};

/**
 * 根据边类型和方向返回中文展示标签。
 *
 * @param relation - 边类型 (如 "mother_of")
 * @param isOutgoing - 是否正向（true=source→target 方向，false=target→source 方向）
 * @returns 中文标签，如 "母亲"、"姐姐"、"同事"
 */
export function getRelationLabel(relation: string, isOutgoing: boolean): string {
  const entry = DIRECTED_FAMILY_LABEL[relation];
  if (entry) return isOutgoing ? entry[0] : entry[1];
  const social = SOCIAL_LABEL[relation];
  if (social) return social;
  return relation; // fallback: 直接返回原始边类型名
}
