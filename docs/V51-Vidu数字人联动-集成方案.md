# V51 - WenStar <-> Vidu S1/S2 Digital Human Audio Integration Design

> Version: v1.0 | Date: 2026-10-21 | Status: Pending Review
> Related: M5 Expression Layer / WebUI Chat / TTS Subsystem / SSE Push

---

## 0. Goals and Boundaries

### 0.1 Core Goal
Connect WenStar chat TTS output with Vidu S1/S2 digital human generation, so the digital avatar can produce lip-sync, expressions, and gestures driven by WenStar-generated speech in real-time / near-real-time.

### 0.2 Non-Goals (this phase)
- Do NOT replace WenStar existing LLM / TTS engines
- Do NOT use Vidu built-in ASR (user voice input stays on WenStar channel)
- Do NOT do digital human model training / binding (single-image instant avatar)
- Do NOT implement Vidu Real-Time Edition full RTC two-way calling (P2 phase)

---

## 1. Current State Analysis (As-Is)

### 1.1 WenStar Existing Voice Pipeline

```
User message -> /api/chat
  -> M5 DeepSeekLLMProvider streaming token output
  -> IncrementalTTS.feed(delta)  // 120 chars triggers one segment
  -> generateTTSAudio(segments, onSegment)
    -> TTS Worker (Python resident, edge/chattts/moss)
    -> Output mp3/wav to data/webui/audio/
  -> SSE push chat-tts { job_id, index, url: "/audio/xxx.mp3" }
  -> SSE push chat-done { reply, audio_urls: [...] }
  -> Frontend playAudioQueue() plays segments sequentially
```

### 1.2 Key Interface Locations

| Module | File | Key Functions/Constants |
|--------|------|------------------------|
| Chat Route | src/webui/server-chat-routes.ts | generateTTSAudio(), buildTTSResult(), IncrementalTTS |
| TTS Worker | scripts/tts_worker.py | stdin/stdout JSON line protocol |
| TTS Server | src/webui/tts_server.py | POST /tts (standalone, port 8765) |
| Audio Static | src/webui/server.ts L2607 | GET /audio/* |
| SSE Push | src/webui/server-chat-routes.ts L643 | pushToSSEClients(chat-tts / chat-done) |
| Frontend Play | src/webui/index.html L534+ | playAudioQueue(), _incrTTSTryPlay() |

### 1.3 Vidu S1/S2 Capability Matrix

| Edition | Input | Output | RTC | ASR/LLM/TTS | Latency | Use Case |
|---------|-------|--------|-----|-------------|---------|----------|
| Avatar Real-Time | image+persona+user AV stream | real-time AV stream | Vidu provides | Vidu provides | <1s | Full two-way call |
| Avatar Component | avatar audio + motion text | real-time AV stream | self-built | self-built | <1s | Existing voice system + avatar |
| Avatar Offline | image+audio+motion text | MP4 file | none | self-built | 5-30s | Batch content production |
| Digital Human API | image+audio_url/text | MP4 file | none | optional Vidu TTS | 5-20s | Single segment audio drive |
| Lip Sync API | video_url+audio_url | MP4 file | none | none | 3-15s | Existing video lip-sync |

### 1.4 Core Gaps

1. **Audio URL reachability**: WenStar outputs /audio/xxx.mp3 relative path, Vidu API needs public-accessible URL
2. **Async generation**: Vidu digital human video is async task (create->poll->done), needs adaptation with WenStar incremental TTS per-segment ready model
3. **AV sync**: Frontend needs to play audio and corresponding avatar video segment simultaneously, ensuring lip-sync

---

## 2. Target Architecture (To-Be)

### 2.1 Three-Phase Roadmap

```
P0 Near-Real-Time (Digital Human API)       P1 Experience Opt (Lip Sync + pregen)      P2 True Real-Time (Component + RTC)
+-------------------------------+    +-------------------------------+    +-------------------------------+
| Each TTS segment ready ->     |    | Maintain avatar base video loop|    | Self-build Aliyun RTC channel  |
| call Vidu Digital Human       |    | -> Lip Sync per segment        |    | TTS audio stream push to RTC   |
| -> async poll get video       |    | -> faster gen, stable avatar   |    | Vidu Component subscribe render|
| -> SSE push video URL         |    | -> pre-generate next segment   |    | -> Frontend subscribe realtime |
| -> Frontend AV sync play      |    |                               |    |    video stream               |
| Latency: 8-25s/segment        |    | Latency: 4-12s/segment        |    | Latency: <1s                  |
| Change: +1 module + config    |    | Change: P0 + video loop mgmt   |    | Change: RTC SDK + stream push  |
+-------------------------------+    +-------------------------------+    +-------------------------------+
```

### 2.2 P0 Architecture Overview

```
+------------------------------------------------------------------+
|                      WenStar Node.js Server                      |
|                                                                  |
|  /api/chat                                                       |
|    |                                                             |
|    v                                                             |
|  M5 LLM stream -> IncrementalTTS -> generateTTSAudio()           |
|                         |                      |                 |
|                         | segment ready        | mp3 URL         |
|                         v                      v                 |
|               +-----------------------------------------+        |
|               |       ViduAvatarBridge (NEW)             |       |
|               |  +-----------------------------------+  |        |
|               |  | 1. URL expose: /audio/xxx -> pub  |  |        |
|               |  | 2. POST /ent/v2/digital-human     |  |        |
|               |  | 3. Poll task (exp backoff)         |  |        |
|               |  | 4. Cache video URL (mem+disk)      |  |        |
|               |  +-----------------------------------+  |        |
|               +---------------+-------------------------+        |
|                               | video ready                      |
|                               v                                 |
|  SSE chat-avatar { index, video_url, audio_url }                 |
|  SSE chat-done   { ..., avatar_urls: [...] }                     |
+-------------------------------+----------------------------------+
                                |
                                v
+------------------------------------------------------------------+
|                      Frontend (index.html)                       |
|                                                                  |
|  playAudioQueue()  <-- audio queue (existing)                    |
|  playAvatarQueue() <-- video queue (NEW)                         |
|    -> <video> element plays, aligned with audio by index         |
|    -> placeholder/loading when video not ready                   |
+------------------------------------------------------------------+
                                |
                                v
                    +--------------------------+
                    |   Vidu API (public)      |
                    |   POST /ent/v2/digital-human |
                    |   GET  /ent/v2/tasks/{id}   |
                    +--------------------------+
```

---

## 3. P0 Detailed Design

### 3.1 New Module: src/webui/vidu-avatar.ts

#### 3.1.1 Responsibilities
- Wrap Vidu Digital Human API calls
- Manage audio URL public exposure
- Async task polling + exponential backoff retry
- Video result caching (prevent duplicate generation)
- Concurrency semaphore control (prevent Vidu rate limiting)

#### 3.1.2 Core Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| initViduAvatar(config) | (cfg: Partial<ViduAvatarConfig>) => void | Init from ConfigService |
| generateAvatarForSegment() | (audioRelUrl, index, chatId) => Promise<string> | Generate avatar video for one TTS segment, return video URL |
| toPublicAudioUrl() | (relUrl: string) => string | Convert /audio/xxx.mp3 to public URL |
| pollTask() | (taskId: string) => Promise<string> | Poll task until done/failed |
| getCachedVideo() | (audioRelUrl: string) => string | null | Check cache (same audio no re-gen) |

### 3.2 Integration Point Modifications

#### 3.2.1 server-chat-routes.ts - TTS segment ready callback

In generateTTSAudio onSegment callback (around L627), append Vidu trigger:

```typescript
// Existing: each TTS segment ready
const url = await generateTTSAudio([text], dataDir, (audioUrl, idx) => {
  job.audio.audio_urls[idx] = audioUrl;
  pushFn?.("chat-tts", { job_id: ttsJob, index: idx, url: audioUrl });

  // === NEW: Vidu digital human linkage ===
  if (ViduAvatar.isEnabled()) {
    ViduAvatar.generateAvatarForSegment(audioUrl, idx, jobId)
      .then(videoUrl => {
        pushFn?.("chat-avatar", {
          job_id: jobId,
          index: idx,
          audio_url: audioUrl,
          video_url: videoUrl,
        });
      })
      .catch(err => {
        console.error("[ViduAvatar] gen failed:", err.message);
        pushFn?.("chat-avatar", {
          job_id: jobId, index: idx, audio_url: audioUrl, video_url: null, error: err.message
        });
      });
  }
});
```

#### 3.2.2 chat-done event extension

In L653 chat-done push, append avatar_urls:

```typescript
pushFn?.("chat-done", {
  job_id: jobId,
  reply: job.reply,
  audio_url: audio.audio_url,
  audio_urls: audio.audio_urls,
  tts_job: audio.tts_job,
  // === NEW ===
  avatar_urls: ViduAvatar.getResultsForJob(jobId),
  avatar_done: true,
});
```

#### 3.2.3 server.ts - Config registration

Near L229 TTS_URL, register new config:

```typescript
const VIDU_API_KEY = ConfigService.get("VIDU_API_KEY", "");
const VIDU_API_BASE = ConfigService.get("VIDU_API_BASE", "https://api.vidu.com");
const VIDU_AVATAR_IMAGE = ConfigService.get("VIDU_AVATAR_IMAGE", "");
const VIDU_PUBLIC_BASE_URL = ConfigService.get("VIDU_PUBLIC_BASE_URL", "");
const VIDU_ENABLED = ConfigService.get("VIDU_AVATAR_ENABLED", "false") === "true";
```

### 3.3 Frontend Modifications (index.html)

#### 3.3.1 New video playback queue

```javascript
// Video queue (aligned with audio queue by index)
const _avatarQ = { gen: 0, urls: [], cur: 0, playing: false, finalized: false };

function _avatarTryPlay() {
  if (_avatarQ.playing) return;
  const url = _avatarQ.urls[_avatarQ.cur];
  if (!url) return; // video not ready, wait
  if (url === null) { _avatarQ.cur++; _avatarTryPlay(); return; } // gen failed skip
  _avatarQ.playing = true;
  const vp = document.getElementById("avatar-video");
  vp.src = url;
  vp.onended = () => { _avatarQ.playing = false; _avatarQ.cur++; _avatarTryPlay(); };
  vp.play().catch(e => console.warn("[Avatar] play failed:", e));
}

// SSE event handling
case "chat-avatar":
  if (d.gen !== _avatarQ.gen) return;
  while (_avatarQ.urls.length <= d.index) _avatarQ.urls.push(null);
  _avatarQ.urls[d.index] = d.video_url;
  _avatarTryPlay();
  break;
```

#### 3.3.2 HTML new video container

```html
<div id="avatar-container" style="display:none">
  <video id="avatar-video" autoplay playsinline muted></video>
  <!-- muted: audio played by playAudioQueue unified, video only visual, avoid double audio -->
</div>
```

### 3.4 Audio URL Public Exposure Solutions

Vidu API audio_url parameter must be public-accessible HTTP(S) URL. WenStar runs on localhost by default, needs one of:

| Solution | Implementation | Use Case |
|----------|---------------|----------|
| A. Public domain + reverse proxy | Configure VIDU_PUBLIC_BASE_URL=https://your-domain.com, Nginx/Caddy reverse proxy to WenStar | Production |
| B. Intranet penetration | cloudflared / ngrok / frp map local port to public | Dev/test |
| C. Upload to object storage | After audio gen, upload to OSS/S3, return public URL | Small audio files, acceptable latency |

**P0 recommended A or B**: Configure VIDU_PUBLIC_BASE_URL in .env, toPublicAudioUrl() directly concatenates.

---
## 4. Configuration Checklist

### 4.1 .env New Entries

```bash
# === Vidu Digital Human Integration (V51) ===
VIDU_AVATAR_ENABLED=false          # Master switch, default off
VIDU_API_KEY=Token vda_xxx         # Vidu API Key
VIDU_API_BASE=https://api.vidu.com # Overseas: api.vidu.com / China: api.vidu.cn
VIDU_AVATAR_IMAGE=https://...      # Avatar image URL (clear front-facing single person)
VIDU_AVATAR_MODEL=viduq2-turbo     # viduq2-turbo (fast) / viduq2-pro (quality)
VIDU_AVATAR_RESOLUTION=720p        # 540p / 720p / 1080p
VIDU_PUBLIC_BASE_URL=              # WenStar public address (e.g. https://wenstar.yourdomain.com)
VIDU_MAX_CONCURRENT=2              # Max concurrent generation
VIDU_POLL_INTERVAL_MS=3000         # Poll interval (ms)
VIDU_POLL_TIMEOUT_MS=120000        # Single task timeout (2 min)
```

### 4.2 Prerequisite Checklist

- [ ] Vidu API Key obtained (platform.vidu.com register, 1000 free credits for new users)
- [ ] Avatar image prepared (PNG/JPG, clear front face, single person, <50MB)
- [ ] WenStar service has public-accessible address (domain / intranet penetration)
- [ ] Audio directory data/webui/audio/ accessible via public address
- [ ] Node.js version >= 18 (native fetch support)

---

## 5. API Call Details

### 5.1 Create Digital Human Video Task

```
POST https://api.vidu.com/ent/v2/digital-human
Authorization: Token vda_xxx
Content-Type: application/json

{
  "model": "viduq2-turbo",
  "image": "https://your-domain.com/avatar/yuyao.png",
  "audio_url": "https://your-domain.com/audio/tts_abc123.mp3",
  "resolution": "720p",
  "prompt": "",
  "payload": "{\"chat_id\":\"xxx\",\"segment_index\":0}"
}
```

Response:
```json
{
  "task_id": "task_xxx",
  "state": "created",
  "credits": 4,
  "created_at": "2026-10-21T10:00:00Z"
}
```

### 5.2 Query Task Status

```
GET https://api.vidu.com/ent/v2/tasks/{task_id}
Authorization: Token vda_xxx
```

Response (success):
```json
{
  "task_id": "task_xxx",
  "state": "success",
  "url": "https://cdn.vidu.com/result/xxx.mp4",
  "cover_url": "https://cdn.vidu.com/result/xxx.jpg",
  "credits": 4
}
```

### 5.3 Credit Consumption Estimate

| Model | Resolution | Per segment (~5s) | 10-segment chat |
|-------|-----------|-------------------|-----------------|
| viduq2-turbo | 720p | ~4 | ~40 |
| viduq2-pro | 720p | ~8 | ~80 |
| viduq2-turbo | 1080p | ~6 | ~60 |

> New user 1000 free credits ~= 250 segments turbo 720p video

---

## 6. Risks and Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Vidu API high latency (10-20s/seg) | Long user wait | 1) Incremental TTS triggers on gen; 2) Play audio first + placeholder when video not ready; 3) P1 use Lip Sync to accelerate |
| Audio URL not public | Vidu cannot download audio, task fails | Validate VIDU_PUBLIC_BASE_URL reachability at startup; fallback to audio-only mode on failure |
| Concurrency hits Vidu rate limit | Task queue/fail | VIDU_MAX_CONCURRENT=2 semaphore; excess queues |
| AV out of sync | Poor experience | Frontend strict alignment by segment_index; video muted, audio unified playback |
| Credit consumption too fast | Cost | Cache same audio video result; VIDU_AVATAR_ENABLED can turn off anytime |
| Avatar identity drift | Appearance changes in long chat | Same image per segment; P1 switch to Lip Sync maintaining base video loop |
| Vidu service unavailable | Linkage fails | try-catch fallback: video gen failure does not block audio playback, SSE pushes video_url: null |

---

## 7. P1 / P2 Upgrade Path

### 7.1 P1: Lip Sync + Base Video Loop
- Pre-generate a 5-10s avatar idle/breathing loop video as base
- Each TTS segment calls POST /ent/v2/lip-sync (video_url + audio_url)
- Lip Sync only changes mouth shape, not overall画面, faster gen (3-8s) and stable identity
- New ViduLipSyncService extends ViduAvatarBase

### 7.2 P2: Avatar Component Edition + RTC Real-Time
- Integrate Aliyun RTC SDK, create dedicated channel
- TTS output changed to PCM stream, push via RTC pushExternalAudioFrame in real-time
- Vidu S2 Component Edition subscribes channel audio, real-time renders avatar video
- Frontend subscribes render_uid video stream via RTC SDK
- Latency < 500ms, true real-time linkage
- Requires Vidu business activation for Component Edition access

---

## 8. Implementation Task Breakdown

| # | Task | Est Effort | Priority |
|---|------|-----------|----------|
| 1 | Create src/webui/vidu-avatar.ts core module | 2h | P0 |
| 2 | .env / ConfigService config registration | 0.5h | P0 |
| 3 | server-chat-routes.ts integrate onSegment callback | 1h | P0 |
| 4 | SSE chat-avatar event + chat-done extension | 0.5h | P0 |
| 5 | Frontend video queue + <video> container | 1.5h | P0 |
| 6 | Public URL validation + fallback logic | 1h | P0 |
| 7 | Unit test (vidu-avatar.test.ts) | 1h | P0 |
| 8 | End-to-end integration (Vidu real API) | 2h | P0 |
| 9 | Doc update (change note V51) | 0.5h | P0 |
| **Total** | | **~10h** | |

---

## 9. Verification Criteria

- [ ] With VIDU_AVATAR_ENABLED=true, each TTS segment auto-triggers Vidu avatar video
- [ ] SSE chat-avatar event correctly pushed, frontend plays in order
- [ ] Video-audio lip-sync error < 500ms
- [ ] Vidu failure falls back to audio-only, does not block chat
- [ ] With VIDU_AVATAR_ENABLED=false, behavior identical to existing (zero regression)
- [ ] Same audio not regenerated (cache hit)
- [ ] Credit consumption within expected range

---

*End of document. Next step: after review approval, execute P0 per task breakdown.*