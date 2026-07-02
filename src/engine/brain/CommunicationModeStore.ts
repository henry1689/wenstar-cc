/**
 * CommunicationModeStore — 通信模式状态管理
 *
 * 负责：
 * 1. 模式状态存储（当前模式 + 防抖计数器）
 * 2. 防抖切换（连续 2 轮确认才切换）
 * 3. 5 轮无任何模式关键词 → 回退到 face_to_face
 */
import type { IStorageProvider } from '../types.js';

export type CommMode = 'face_to_face' | 'phone' | 'messaging';

const STORAGE_KEY = 'comm_mode_state';
const CONFIRM_THRESHOLD = 2;
const FACE_TO_FACE_TIMEOUT = 5;

interface CommModeState {
  currentMode: CommMode;
  confirmationCount: number;
  /** 无任何模式关键词的持续轮数 */
  idleRounds: number;
}

export class CommunicationModeStore {
  private storage: IStorageProvider | null = null;
  private state: CommModeState = {
    currentMode: 'face_to_face',
    confirmationCount: 0,
    idleRounds: 0,
  };

  async init(storage?: IStorageProvider): Promise<void> {
    this.storage = storage ?? null;
    if (storage) {
      try {
        const saved = await storage.get<CommModeState>(STORAGE_KEY);
        if (saved) this.state = saved;
      } catch (e: any) { console.error('[CommModeStore] error:', e?.message); }
    }
  }

  reset(): void {
    this.state = { currentMode: 'face_to_face', confirmationCount: 0, idleRounds: 0 };
    this.persist();
  }

  destroy(): void { this.persist(); }

  /** 获取当前模式 */
  getMode(): CommMode {
    return this.state.currentMode;
  }

  /** 检测一次输入，返回最终模式 */
  detect(message: string): CommMode {
    const detected = this.classify(message);

    if (detected === this.state.currentMode) {
      // 同一模式 → 稳定，重置计数器
      this.state.confirmationCount = 0;
      this.state.idleRounds = 0;
    } else if (detected === 'face_to_face') {
      // 检测到面对面 → 直接切换（面对面是最高优先级）
      this.state.currentMode = 'face_to_face';
      this.state.confirmationCount = 0;
      this.state.idleRounds = 0;
    } else {
      // 新模式 → 确认计数
      this.state.confirmationCount++;
      this.state.idleRounds = 0;
      if (this.state.confirmationCount >= CONFIRM_THRESHOLD) {
        this.state.currentMode = detected;
        this.state.confirmationCount = 0;
      }
    }

    // 长时间无模式关键词 → 回退到面对面
    if (detected === 'face_to_face' && this.state.currentMode !== 'face_to_face') {
      this.state.idleRounds++;
      if (this.state.idleRounds >= FACE_TO_FACE_TIMEOUT) {
        this.state.currentMode = 'face_to_face';
        this.state.confirmationCount = 0;
        this.state.idleRounds = 0;
      }
    }

    this.persist();
    return this.state.currentMode;
  }

  /** 模式中文标签（供注入 prompt） */
  getModeLabel(): string {
    switch (this.state.currentMode) {
      case 'face_to_face': return '面对面';
      case 'phone': return '电话';
      case 'messaging': return '微信';
    }
  }

  /** 纯规则分类 */
  private classify(text: string): CommMode {
    // 面对面关键词（最高优先级）
    if (/身边|在我面前|当着面|你在这|看着你|抱着你|当面|你在我|面对面/.test(text)) {
      return 'face_to_face';
    }
    // 电话模式关键词
    if (/电话|通话|手机里|打电话|电话里|听筒|挂电话|信号不好|你在那边|电话那头|听你说|打给我|语音|通话中/.test(text)) {
      return 'phone';
    }
    // 微信/消息模式关键词
    if (/微信|发消息|打字|短信|在吗|表情包|朋友圈|语音条|刚发的|收到|已读|消息|聊天的/.test(text)) {
      return 'messaging';
    }
    // 出差/远距离辅助检测
    if (/出差|外地|外面|酒店|旅馆|不在家|路上|机场|车站|车上/.test(text)) {
      // 出差场景默认用电话模式（用户不在身边 → 语音或消息）
      // 如果同时含"微信"等词则用 messaging，但这里没有，默认 phone
      return 'phone';
    }
    return 'face_to_face';
  }

  private async persist(): Promise<void> {
    try {
      await this.storage?.set(STORAGE_KEY, this.state);
    } catch (e: any) { console.error('[CommModeStore] error:', e?.message); }
  }
}
