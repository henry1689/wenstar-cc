/**
 * RoleParamsSnapshot — 角色参数快照（P1-5）
 *
 * 每个角色拥有独立的语气/风格/性格参数，
 * 在角色扮演期间替换玉瑶的默认参数。
 *
 * 🔴 铁律：
 *   1. 角色参数只影响该角色，退出时恢复玉瑶参数
 *   2. 未设置的参数继承玉瑶的默认值（渐进式覆写）
 *   3. 参数不持久化到数据库（仅内存，退出即销毁）
 */
export interface RoleParams {
  /** 自称方式（如"诗韵""梓铭"），空则默认"我" */
  selfRef?: string;
  /** 语气风格（'cute' | 'gentle' | 'teasing' | 'respectful' | 'cold' | 'passionate'） */
  tone?: string;
  /** 说话习惯（如"喜欢用语气词"、"爱撒娇"、"话很少"） */
  speechHabit?: string;
  /** 性格标签 */
  traits?: string[];
  /** 对用户的称呼（如"叔叔""爸爸""老公""哥哥"） */
  addressUser?: string;
  /** 语速（slow / normal / fast） */
  speechSpeed?: string;
}

const DEFAULT_PARAMS: Required<RoleParams> = {
  selfRef: '我',
  tone: 'gentle',
  speechHabit: '',
  traits: [],
  addressUser: '你',
  speechSpeed: 'normal',
};

export class RoleParamsSnapshot {
  /** 角色参数 Map */
  private _snapshots = new Map<string, Partial<RoleParams>>();

  /** 注册角色参数 */
  set(roleName: string, params: Partial<RoleParams>): void {
    this._snapshots.set(roleName, params);
  }

  /** 获取角色参数（合入默认值） */
  get(roleName: string): Required<RoleParams> {
    const roleParams = this._snapshots.get(roleName) || {};
    return { ...DEFAULT_PARAMS, ...roleParams };
  }

  /** 清除角色参数 */
  clear(roleName: string): void {
    this._snapshots.delete(roleName);
  }

  /** 清除所有 */
  clearAll(): void {
    this._snapshots.clear();
  }

  /** 导出所有角色参数（用于调试/序列化） */
  getAll(): Record<string, Partial<RoleParams>> {
    const out: Record<string, Partial<RoleParams>> = {};
    for (const [k, v] of this._snapshots) {
      out[k] = v;
    }
    return out;
  }

  /** 对话风格指令片段（供 PromptComposer 注入） */
  buildStyleInstruction(roleName: string): string {
    const p = this.get(roleName);
    const parts: string[] = [];

    if (p.selfRef !== DEFAULT_PARAMS.selfRef) {
      parts.push(`你自称「${p.selfRef}」，不用"我"`);
    }
    if (p.addressUser !== DEFAULT_PARAMS.addressUser) {
      parts.push(`你称呼用户为「${p.addressUser}」`);
    }
    if (p.tone) {
      const toneMap: Record<string, string> = {
        cute: '语气可爱俏皮',
        gentle: '语气温柔体贴',
        teasing: '语气调皮挑逗',
        respectful: '语气恭敬尊重',
        cold: '语气冷淡疏离',
        passionate: '语气热情奔放',
      };
      parts.push(toneMap[p.tone] || `语气${p.tone}`);
    }
    if (p.speechHabit) parts.push(`说话习惯：${p.speechHabit}`);
    if (p.traits.length > 0) parts.push(`性格：${p.traits.join('、')}`);

    return parts.length > 0 ? `\n【角色风格】${parts.join('，')}` : '';
  }
}
