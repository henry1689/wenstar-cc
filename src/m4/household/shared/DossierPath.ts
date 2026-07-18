/**
 * DossierPath — 户籍卷宗点号路径读写工具
 *
 * household/ 下多个模块各自实现了 split('.') 逐级深入 dossier 的逻辑，
 * 造成 5 处重复实现。本模块提供唯一实现，消除所有重复。
 *
 * 使用方：
 *   - FamilyGraph._getDossierField → dossierRead()
 *   - FamilyGraph._setDossierFieldSystem → dossierWrite()
 *   - FamilyGraph.setDossierField → dossierWrite()
 *   - ProfileAcquisitionEngine.getExistingFieldValue → dossierRead()
 *   - ProfileAcquisitionEngine.getFieldValueByPath → dossierReadByPath()
 */

/**
 * 按点号路径从 dossier 对象中读取值。
 * 若路径上任何中间节点不存在或不是对象，返回 undefined。
 */
export function dossierRead(dossier: any, fieldPath: string): any {
  if (!dossier || typeof dossier !== 'object') return undefined;
  const parts = fieldPath.split('.');
  let target: any = dossier;
  for (const key of parts) {
    if (target === undefined || target === null) return undefined;
    if (typeof target !== 'object') return undefined;
    target = target[key];
  }
  return target;
}

/**
 * 按点号路径写入 dossier 对象。
 * 中间缺失的对象节点自动创建。返回写入的值。
 */
export function dossierWrite(dossier: any, fieldPath: string, value: any): { oldValue: any; newValue: any } {
  const parts = fieldPath.split('.');
  let target: any = dossier;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!target[key] || typeof target[key] !== 'object') target[key] = {};
    target = target[key];
  }
  const lastKey = parts[parts.length - 1];
  const oldValue = target[lastKey] !== undefined ? target[lastKey] : null;
  target[lastKey] = value;
  return { oldValue, newValue: value };
}
