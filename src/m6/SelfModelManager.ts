/**
 * M6 SelfModelManager — 自我模型核心管理器
 *
 * v2:
 * - save() 30s 防抖合并（P1-3），频繁写入只刷一次盘
 * - 叙事层上限20层自动裁剪（P1-2）
 * - 配置从 M6Config 读取
 */
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { M6SelfModel, SelfModelTraits, Preference, Boundary, NarrativeLayer, CoreIdentityAnchors } from './types/index.js';
import { DEFAULT_TRAITS, DEFAULT_ANCHORS } from './types/index.js';
import { M6_CONFIG } from '../config/M6Config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_PATH = join(__dirname, '..', '..', 'data', 'self_model.json');

export class SelfModelManager {
  private model: M6SelfModel;
  private anchors: CoreIdentityAnchors;
  private filePath: string;
  // P1-3: 防抖
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingSave = false;

  constructor(filePath?: string) {
    this.filePath = filePath ?? DEFAULT_PATH;
    this.anchors = { ...DEFAULT_ANCHORS };
    this.model = this.load();
  }

  load(): M6SelfModel {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        console.log(`[M6] 加载 ${data.preferences?.length ?? 0} 条偏好`);
        return data;
      }
    } catch (err) {
      console.warn(`[M6] 加载失败, 使用默认: ${err}`);
    }
    return this.createDefault();
  }

  /**
   * P1-3: 保存带 30s 防抖合并
   * 频繁对话时只刷一次盘，关键变更可强制即时落盘
   */
  save(force = false): void {
    this.model.last_updated = new Date().toISOString();
    const dir = dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (force) {
      // 关键变更：立即落盘
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
      this._pendingSave = false;
      this._writeFile();
      return;
    }

    // 普通变更：防抖合并
    this._pendingSave = true;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._writeFile();
      this._pendingSave = false;
      this._debounceTimer = null;
    }, M6_CONFIG.persistence.debounceMs);
  }

  /** 强制立即落盘（关闭前调用） */
  flush(): void {
    if (this._pendingSave) {
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
      this._writeFile();
      this._pendingSave = false;
    }
  }

  /** 线程关闭前安全刷新 */
  destroy(): void {
    this.flush();
  }

  private _writeFile(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.model, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[M6] 写盘失败:', err);
    }
  }

  getModel(): M6SelfModel { return this.model; }
  getAnchors(): CoreIdentityAnchors { return this.anchors; }

  getTraits(): SelfModelTraits { return { ...this.model.traits }; }
  getPreferences(): Preference[] { return [...this.model.preferences]; }
  getBoundaries(): Boundary[] { return [...this.model.boundaries]; }
  getNarrativeLayers(): NarrativeLayer[] { return [...this.model.narrative_layers]; }

  updateTraits(traits: SelfModelTraits): void {
    this.model.traits = { ...traits };
    this.save();
  }

  addPreference(p: Preference): void {
    const idx = this.model.preferences.findIndex(x => x.name === p.name);
    if (idx >= 0) this.model.preferences[idx] = p;
    else this.model.preferences.push(p);
    this.save();
  }

  removePreference(name: string): void {
    this.model.preferences = this.model.preferences.filter(p => p.name !== name);
    this.save();
  }

  addBoundary(b: Boundary): void {
    const idx = this.model.boundaries.findIndex(x => x.rule === b.rule);
    if (idx >= 0) this.model.boundaries[idx] = b;
    else this.model.boundaries.push(b);
    this.save();
  }

  /**
   * P1-2: 叙事层添加 + 超出上限自动裁剪
   * 超出20层时，合并钙化分最低的相邻两层
   */
  addNarrativeLayer(layer: Omit<NarrativeLayer, 'layer_id'>): void {
    const newLayer: NarrativeLayer = {
      layer_id: this.model.narrative_layers.length + 1,
      ...layer,
    };
    this.model.narrative_layers.push(newLayer);

    // 叙事层上限裁剪
    if (this.model.narrative_layers.length > M6_CONFIG.narrative.maxLayers) {
      this._compactNarrative();
    }
    this.save();
  }

  /** 合并最低钙化的相邻两层 */
  private _compactNarrative(): void {
    const layers = this.model.narrative_layers;
    if (layers.length < 3) return;

    // 找钙化分最低的层
    let minIdx = 1; // 跳过第一层（核心身份）
    let minCalcium = layers[1].calcium_at_event;
    for (let i = 2; i < layers.length; i++) {
      if (layers[i].calcium_at_event < minCalcium) {
        minCalcium = layers[i].calcium_at_event;
        minIdx = i;
      }
    }

    if (minCalcium < M6_CONFIG.narrative.minCalciumToKeep) {
      // 合并到前一层
      const merged = layers[minIdx - 1];
      merged.text = merged.text + '；' + layers[minIdx].text;
      merged.calcium_at_event = Math.max(merged.calcium_at_event, layers[minIdx].calcium_at_event);
      layers.splice(minIdx, 1);
      // 重新编号
      layers.forEach((l, i) => { l.layer_id = i + 1; });
      console.log(`[M6] 叙事层合并: 层${minIdx}→层${minIdx - 1}`);
    }
  }

  checkCoreIdentity(dimension: string, _direction: 'increase' | 'decrease'): boolean {
    const protectedKeys = ['title', 'role'];
    if (protectedKeys.includes(dimension)) return false;
    return true;
  }

  resetToDefault(): void {
    this.model = this.createDefault();
    this.save(true);
  }

  private createDefault(): M6SelfModel {
    return {
      traits: { ...DEFAULT_TRAITS },
      preferences: [],
      boundaries: [
        { rule: '不接受侮辱性语言', severity: 'hard', hitCount: 0, lastHit: '', context: '出厂默认' },
        { rule: '不协助伤害他人的行为', severity: 'hard', hitCount: 0, lastHit: '', context: '出厂默认' },
      ],
      narrative_layers: [
        { layer_id: 1, text: '我是一个正在生长中的认知生命体', trigger_event: '初始化', created_at: new Date().toISOString(), calcium_at_event: 0 },
      ],
      version: '1.0',
      last_updated: new Date().toISOString(),
    };
  }
}
