#!/usr/bin/env python3
"""tts_worker.py — TTS 常驻合成 worker（V26 引擎抽象化）

复用 Python 进程 + 模块级 import 引擎，省去每次 fork 进程 + import 的开销。
通过 stdin/stdout 行协议与 TypeScript 侧 TTSWorker 通信，asyncio 并发合成。

协议（每行一个 JSON，UTF-8）：
  请求: {"id": "<uuid>", "text": "<要合成的文本>", "path": "<输出文件基础路径，不含扩展名>"}
  响应: {"id": "<uuid>", "ok": true, "file": "<实际写入的文件名>"}
     或 {"id": "<uuid>", "ok": false, "error": "<原因>"}

🔴 引擎抽象（V26）：
  引擎以注册表形式可插拔（见 ENGINES）。每个引擎声明 name / ext，并实现
  async synth(text, path) → 把音频写入 path。
  新增引擎只需实现接口 + 注册，调用方（TS 侧）无需改动。
  引擎由环境变量 TTS_ENGINE 选择，默认 edge。

  可选引擎：
    edge — 微软 Edge 在线合成（音质最好；依赖微软服务，协议为逆向实现，服务端策略变更即失效）
    sapi — Windows 本地 SAPI 离线合成（零网络依赖；音质一般）

🔴 为何需要抽象：edge-tts 走的是逆向微软协议，2026-10-13 起被其 WSS 端点 403 拦死
  （同域名 HTTPS voices/list 仍 200，实测任一参数组合均 403；Edge 浏览器自身朗读功能仍正常，
  说明是服务端按客户端特征识别并拒绝）。这类外部依赖必须可替换，故引擎不再硬编码进调用方。

注意：
  - edge 引擎需 edge-tts 宿主 Python（Python 3.13），不能用 PATH 里 hermes venv 的 3.11。
  - 合成失败由 TS 侧重试（空文件检测仍在 generateTTSAudio 的 genOne 里）。
"""
import sys
import os
import json
import asyncio

# 🔴 Windows 下 stdin/stdout 默认按 locale(GBK) 解码，读 UTF-8 JSON 会把中文弄成 surrogate
# （UnicodeEncodeError: surrogates not allowed）。显式强制 UTF-8，否则中文合成必失败。
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# edge 在线语音名（微软神经语音）
EDGE_VOICE = os.environ.get("TTS_VOICE", "zh-CN-XiaoxiaoNeural")
# SAPI 本地语音：留空则用系统默认语音
SAPI_VOICE_HINT = os.environ.get("TTS_SAPI_VOICE", "")
SAPI_RATE = int(os.environ.get("TTS_SAPI_RATE", "0"))  # -10~10，0 为常速


class EdgeEngine:
    """微软 Edge 在线合成（edge-tts）。需联网；逆向协议，服务端策略变更即失效。"""

    name = "edge"
    ext = ".mp3"

    def __init__(self):
        import edge_tts  # 延迟 import：只有选中本引擎才付这笔开销
        self._tts = edge_tts

    async def synth(self, text, path):
        await self._tts.Communicate(text, EDGE_VOICE).save(path)


class SapiEngine:
    """Windows 本地 SAPI 离线合成。零网络依赖，走本机 COM。

    ⚠️ SAPI 输出为 WAV（RIFF），不是 MP3 —— Format.Type=22 实为 22kHz/16bit 单声道 PCM。
    故本引擎 ext=".wav"，服务端按扩展名返回 audio/wav（server.ts 的 /audio/ 路由已支持）。
    SAPI 是同步阻塞 API，放 executor 执行，避免阻塞事件循环。
    """

    name = "sapi"
    ext = ".wav"

    def __init__(self):
        import win32com.client  # pywin32；仅 Windows 可用
        self._win32 = win32com.client

    def _speak_sync(self, text, path):
        # 🔴 COM 需按线程初始化：win32com 只自动初始化主线程，executor 线程池的线程
        # 必须显式 CoInitialize，否则 Dispatch 抛「尚未调用 CoInitialize」（实测踩中）。
        import pythoncom
        pythoncom.CoInitialize()
        try:
            self._speak_inner(text, path)
        finally:
            pythoncom.CoUninitialize()

    def _speak_inner(self, text, path):
        sp = self._win32.Dispatch("SAPI.SpVoice")
        if SAPI_VOICE_HINT:
            for i in range(sp.GetVoices().Count):
                v = sp.GetVoices().Item(i)
                if SAPI_VOICE_HINT in v.GetDescription():
                    sp.Voice = v
                    break
        if SAPI_RATE:
            sp.Rate = max(-10, min(10, SAPI_RATE))
        stream = self._win32.Dispatch("SAPI.SpFileStream")
        stream.Format.Type = 22  # SAFT22kHz16BitMono → WAV
        stream.Open(path, 3, False)  # 3 = SSFMCreateForWrite
        prev = sp.AudioOutputStream
        try:
            sp.AudioOutputStream = stream
            sp.Speak(text)
        finally:
            stream.Close()
            sp.AudioOutputStream = prev

    async def synth(self, text, path):
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._speak_sync, text, path)


# 🔴 引擎注册表：新增引擎在此登记即可，调用方无需改动
ENGINES = {
    EdgeEngine.name: EdgeEngine,
    SapiEngine.name: SapiEngine,
}


def build_engine():
    """按 TTS_ENGINE 构建引擎实例；未知引擎名直接失败（不静默降级）。"""
    want = (os.environ.get("TTS_ENGINE") or "edge").strip().lower()
    cls = ENGINES.get(want)
    if cls is None:
        raise SystemExit(
            "unknown TTS_ENGINE=%r; available: %s" % (want, sorted(ENGINES))
        )
    return cls()


ENGINE = None  # 在 __main__ 里初始化


async def synth(req):
    """合成单段音频。返回协议响应 dict；异常不外抛，回传 TS 侧统一重试/日志。"""
    rid = req.get("id")
    text = req.get("text", "")
    base = req.get("path", "")
    if not text.strip() or not base:
        return {"id": rid, "ok": False, "error": "empty text/path"}
    path = base + ENGINE.ext
    try:
        await ENGINE.synth(text, path)
        if not os.path.exists(path) or os.path.getsize(path) == 0:
            # 空产物就地清理——否则 0 字节文件会永久堆积，并把成功记录挤出
            # cleanupOldAudioFiles 的「最近 500 个」窗口（2026-10-13 实测踩中）。
            try:
                if os.path.exists(path):
                    os.remove(path)
            except OSError:
                pass
            return {"id": rid, "ok": False, "error": "empty audio produced"}
        return {"id": rid, "ok": True, "file": os.path.basename(path)}
    except Exception as e:  # noqa: BLE001 — 错误回传 TS 侧重试，不静默吞
        return {"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"}


async def handle(req):
    """合成 + 立即输出协议响应（每请求一行，按 id 匹配，乱序无妨）。"""
    resp = await synth(req)
    print(json.dumps(resp, ensure_ascii=False), flush=True)


async def main():
    loop = asyncio.get_running_loop()
    tasks = set()
    while True:
        # 同步 stdin.read 会阻塞事件循环 → 放 executor 线程读，保证合成 task 并发执行
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:  # EOF（父进程退出）→ 等剩余任务完成再退
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        task = asyncio.create_task(handle(req))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == "__main__":
    ENGINE = build_engine()
    print(
        "[tts_worker] engine=%s ext=%s" % (ENGINE.name, ENGINE.ext),
        file=sys.stderr,
        flush=True,
    )
    asyncio.run(main())
