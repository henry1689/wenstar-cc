# MemArch-v2.0.0 / M4-Retrieval

User-facing retrieval pipeline for WenStar OS memory architecture.
Baseline: MemArch-v2.0.0-Baseline (MD5: C3DCBFC83B96EBE88D06D230F26CF503).

## 1. Architecture (text diagram)

```
 raw_query
    │
    ▼
┌─────────────────────┐
│  QueryUnderstanding │  ≤50ms  → vec40[40], p_A, entities, time_range, intent
└─────────┬───────────┘
          │
          ▼
┌──────────────────────────────────────────────────────────────┐
│  8-WAY PARALLEL RECALL (Promise.all, ≤120ms hard budget)     │
│  ┌─────────┐ ┌──────────┐ ┌─────┐ ┌─────────┐ ┌──────────┐ │
│  │ bm25    │ │ semantic │ │ ppr │ │ emotion │ │ blackdia │ │
│  │ (FTS5)  │ │ (vec0↓)  │ │(0.85)│ │ (vec0↓) │ │ (high C) │ │
│  └─────────┘ └──────────┘ └─────┘ └─────────┘ └──────────┘ │
│  ┌─────────┐ ┌──────────┐ ┌──────────┐                       │
│  │ profile │ │   kb     │ │ foresight│                       │
│  │(dossier)│ │(kb facts)│ │(pending) │                       │
│  └─────────┘ └──────────┘ └──────────┘                       │
└─────────┬──────────────────────────────────────────────────────┘
          │ each leg individually raced; timeout → empty + metric
          ▼
┌─────────────────────────────────┐
│  Weighted RRF (k=60)            │  score = Σ w_i(p_A)/(60+rank_i)
│  + M3 prior boost               │  boost = 1 + 0.25*strength + 0.15*activation
└─────────┬───────────────────────┘
          │ top-50
          ▼
┌─────────────────────────────────┐
│  Cross-Encoder Rerank  ≤200ms   │  TODO(ce): bge-reranker
│  fallback: Jaccard + prior       │  timeout → use RRF top-K directly
└─────────┬───────────────────────┘
          │
          ▼
┌─────────────────────────────────┐
│  MMR (λ=0.7) dedupe             │  → top-20 Evidence[]
└─────────┬───────────────────────┘
          │
          ▼
      Evidence[]  (LLM context)
```

## 2. 8-way Recall responsibilities

| Leg | File | Source view / table | What it catches |
|---|---|---|---|
| bm25 | `recall/bm25.ts` | `fts_memories` + `v_mem_real` | Literal keyword overlap (FTS5 trigram) |
| semantic | `recall/semantic_vector.ts` | `vec_mem_semantic` (vec0) | Dense embedding similarity; falls back to FTS5 if vec0 not loaded |
| ppr | `recall/ppr.ts` | `entity_edges` + `trace_entities` | Personalized PageRank from query entities (α=0.85, ≤20 iters) |
| emotion | `recall/emotion_40d.ts` | `vec_mem_perception` (40D) | Affective similarity; falls back to FTS5 if vec0 not loaded |
| blackdiamond | `recall/blackdiamond.ts` | `v_bd_active` + `v_mem_real` | High-consolidation, high-activation landmark memories |
| profile | `recall/profile.ts` | `v_fact_real` (domain=dossier/preference) | User long-term profile facts |
| kb | `recall/knowledge_base.ts` | `v_fact_real` (domain=kb) | Structured knowledge entries |
| foresight | `recall/foresight.ts` | `prospective_items` (status=pending) | Upcoming promises/reminders/plans |

## 3. Weighted RRF — p_A interpolation

`score(d) = Σ_i w_i(p_A) / (k + rank_i(d))` with `k = 60`.

| Leg | w(p_A=0) | w(p_A=1) | Interpolation formula |
|---|---|---|---|
| bm25 | 0.25 | 0.10 | `0.25 - 0.15*p_A` |
| semantic | 0.10 | 0.35 | `0.10 + 0.25*p_A` |
| ppr | 0.05 | 0.20 | `0.05 + 0.15*p_A` |
| emotion | 0.05 | 0.05 | `0.05` |
| blackdiamond | 0.15 | 0.10 | `0.15 - 0.05*p_A` |
| profile | 0.20 | 0.08 | `0.20 - 0.12*p_A` |
| kb | 0.15 | 0.07 | `0.15 - 0.08*p_A` |
| foresight | 0.05 | 0.05 | `0.05` |
| **sum** | **1.00** | **1.00** | |

Interpretation: low `p_A` (chitchat) → literal + profile facts dominate;
high `p_A` (serious recall) → semantic + PPR entity diffusion dominate.

M3 prior boost applied AFTER RRF, BEFORE rerank:
`final_score = rrf_score * (1 + 0.25*strength + 0.15*activation)`.

## 4. Degradation timeline

```
 t=0 ───────────────────────────────────────────────────►
 │
 ├─ QueryUnderstanding  ──── [50ms hard timeout]
 │                            on timeout → fallback sync parse
 │
 ├─ 8-way Recall (parallel) ─ [120ms hard budget]
 │   each leg raced independently:
 │     leg.timeout → return [] + metrics.degraded_legs.push(leg.name)
 │
 ├─ RRF fusion (sync, sub-ms)
 │
 ├─ Cross-encoder rerank  ── [200ms hard timeout]
 │                            on timeout → use RRF top-K directly
 │                            metrics.rerank_skipped = true
 │
 └─ MMR (sync) → Evidence[]
```

## 5. Running tests and bench

```bash
# install deps (better-sqlite3 native binary ships prebuilt)
npm install

# run unit tests (20 cases, Jest-compatible)
npx tsc -p tsconfig.json
node bench/run_tests.js

# run benchmark (10k memories, 200 runs)
node dist/bench/bench.js
```

### Bench result (10k memories, 200 runs, in-memory SQLite)

| Phase | p50 | p95 | p99 | max | Budget | Status |
|---|---|---|---|---|---|---|
| query_understand | 0.0ms | 1.0ms | 1.0ms | 2.0ms | ≤50ms | PASS |
| recall_parallel | 2.0ms | 14.0ms | 20.0ms | 23.0ms | ≤120ms | PASS |
| rerank | 0.0ms | 1.0ms | 1.0ms | 1.0ms | ≤200ms | PASS |
| **TOTAL** | **4.0ms** | **16.0ms** | **21.0ms** | **26.0ms** | ≤400ms | **PASS** |

## 6. TODO placeholders (model wiring)

- `TODO(embed)` in `query_understanding/index.ts`: replace 40D hash projection with real bge-small-zh 1024D embedding.
- `TODO(embed)` in `recall/semantic_vector.ts`: real KNN via vec0 once sqlite-vec extension is loaded in production.
- `TODO(ce)` in `rerank/cross_encoder.ts`: wire bge-reranker-base via ONNX Runtime; current fallback is Jaccard + prior.
- `TODO(embed)` in `recall/emotion_40d.ts`: real 40D perception vectors once M3 Step7_ExtractSemantic writes them.

## 7. Hard constraints honored

- ✅ `better-sqlite3` synchronous API (no async sqlite3)
- ✅ TypeScript strict mode
- ✅ All namespace isolation via M1 views (`v_mem_real`, `v_fact_real`, `v_bd_active`, ...)
- ✅ M3 `consolidation` / `activation_cache` used as prior boost after RRF
- ✅ Unified `Evidence[]` output contract
- ✅ vec0 missing → graceful `console.warn` + FTS5 fallback (never throws)
- ✅ All SQL parameterized (no string interpolation of user input)
- ✅ 8-way recall via `Promise.all` (parallel, not serial await)
- ✅ PPR α=0.85, ≤20 iterations, 30ms time budget
- ✅ Black diamond: `consolidation > 0.7 AND activation_cache > 0.5`
- ✅ Per-leg timeout isolation + global rerank timeout → RRF fallback
