/**
 * EngineContext — 引擎上下文共享存储
 *
 * 作为新旧架构之间的轻量桥梁。
 * ontextor 写入 -> chat.ts 读取 -> 注入到 knowledgeBaseText
 */
let _emotionLabel = '';
let _desireHints: string[] = [];
let _emergenceHint = '';
let _relationLabel = '';
let _temporalBlock = '';
let _commMode = 'face_to_face';
const _extras = new Map<string, string>();

export const EngineContext = {
  set(emotion: string, desires: string[], emergence: string, relation: string): void {
    _emotionLabel = emotion;
    _desireHints = desires;
    _emergenceHint = emergence;
    _relationLabel = relation;
  },

  /** 设置扩展字段（供时空规则引擎注入气象/权限标记） */
  setExtra(key: string, value: string): void {
    _extras.set(key, value);
  },

  /** 读取扩展字段 */
  getExtra(key: string): string | undefined {
    return _extras.get(key);
  },

  setTemporalBlock(block: string): void {
    _temporalBlock = block;
  },

  getTemporalBlock(): string {
    return _temporalBlock;
  },

  setCommMode(mode: string): void {
    _commMode = mode;
  },

  getCommMode(): string {
    return _commMode;
  },

  /** 取格式化引擎上下文块（注入到 knowledgeBase） */
  getBlock(): string {
    const parts: string[] = [];
    if (_temporalBlock) parts.push(_temporalBlock);
    if (_emotionLabel) parts.push(`【情感状态】${_emotionLabel}`);
    if (_relationLabel && _relationLabel !== 'stranger') parts.push(`【关系阶段】${_relationLabel}`);
    if (_desireHints.length) parts.push(`【内心】${_desireHints.join('；')}`);
    if (_emergenceHint) parts.push(`【此刻感受】${_emergenceHint}`);
    const weatherPerm = _extras.get('weather_permission');
    const weatherCurrent = _extras.get('weather_current');
    const weatherAlert = _extras.get('weather_alert');
    if (weatherPerm === 'allowed' && weatherCurrent) {
      parts.push(`【天气】${weatherCurrent}`);
      if (weatherAlert) parts.push(`【气象预警】${weatherAlert}`);
    }
    return parts.length ? parts.join('\n') : '';
  },

  reset(): void {
    _emotionLabel = '';
    _desireHints = [];
    _emergenceHint = '';
    _relationLabel = '';
    _temporalBlock = '';
    _extras.clear();
  },
};
