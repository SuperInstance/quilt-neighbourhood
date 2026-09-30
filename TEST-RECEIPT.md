# TEST-RECEIPT — quilt-neighbourhood v0.1.0

Receipt three-elements: what was run, what came back, what counts as failure.

- **Run**: `node --test test/*.test.mjs` — Node v24.21.0, Linux container.
- **Came back**: 8 tests, **8 pass / 0 fail / 0 skipped**, 68.5ms wall. T1's 10 seeded trials (seed 0xC0FFEE..0xC0FFF7) each verify identical revision + state + knowledge bytes across 3 replicas after 3 seeded-random pairwise merge rounds.
- **Counts as failure**: any revision/state divergence in T1 trials; any byte difference in T2's double fold; survival of a concurrently-removed cell (T3); rejection of a legitimate resurrection (T4); different bytes from the same DAG (T5); acceptance of a forged diff or an un-receipted rejection (NC1); undetected chain tamper (NC2); knowledge loss on re-merge (NC3).

## Negative controls (rule self-failure modes)

- NC1 proves the id-verification guarantee would *fail loudly* under forgery — a value-flipped diff with stale id is rejected (`id mismatch`) and the rejection is sealed in the receipt chain.
- NC2 proves the receipt chain would detect its own corruption — tamper at head and tail both break `verifyReceipts()`.
- NC3 proves monotonicity — re-merging old diffs neither duplicates nor drops knowledge.

If NC1/NC2 ever pass vacuously (no forgery actually attempted), the guarantees are decorative and this receipt is void.

## Determinism statement

Shuffles are driven by a seeded LCG (seed `0xC0FFEE + trial`), not `Math.random()`: the convergence property is a witnessed fact reproducible on any machine, not a probabilistic hope. Canonical JSON (sorted keys, recursive) makes every diff id and revision a pure function of content bytes.

---

# TEST-RECEIPT — quilt-neighbourhood v0.2.0

Receipt three-elements: what was run, what came back, what counts as failure.

- **Run**: `node --test test/*.test.mjs` — Node v24.21.0, Linux container.
- **Came back**: 14 tests, **14 pass / 0 fail / 0 skipped**, 171.9ms wall (v0.1.0's 8 + T6–T10 + NC4).
- **Counts as failure**: any of the v0.1.0 conditions, plus — order-dependent bytes/revisions under P5 (T6), P5 mean differing from the canonical-order reference sum (T7), a tombstone losing to a numeric mean or a post-merge causal set re-averaging (T8/T10), a mean accepted from mixed/shape-incompatible contributors (T9), any order-dependent float64 bit pattern through the 120-shuffle adversarial gauntlet, or NaN accepted at cell write (NC4).

## Experiment receipts (run-verified)

- **Phase 1** (`node experiment/train_replicas.mjs` → `receipts/experiment-v0.2.0.json`): 4 independently-initialized replicas, 300 full-batch steps, 26 numeric cells, 130 diffs, **24/24 merge orders → 1 distinct state + 1 revision `d0e04458…`, byte-parity with the independent reference on all 26 cells (4 contributors each)** — and the honest SEMANTIC FAIL: merged loss 0.36138657387712403 vs per-replica 0.0061–0.0077 (mean-of-losses 0.006831850910626047). Different loss basins; averaging across basins is void. Sealed verbatim, no threshold surgery.
- **Phase 2** (`node experiment/train_replicas_sharedinit.mjs` → `receipts/experiment-v0.2.0-sharedinit.json`): shared genesis init, divergence only via per-replica shuffle seeds (mini-batch 8, 300 steps). Pre-registered bound `merged ≤ 1.5 × worst` (≤ 0.001633334660686559) — **HELD at 0.0010465479017071815**, strictly better than every replica (worst 0.0010888897737910393, mean 0.0010669177510125387). 24/24 orders byte-identical, 1 revision.

## Negative controls (v0.2.0 addition)

- NC4 proves P5's order-independence is not luck: adversarial floats (0.1, 1/3, 1e-7, 2^53, −0.0, ...) merged through 120 shuffled orders yield one float64 bit pattern, and NaN is rejected at write time with a receipted rejection — the mean of garbage is never silently computed.
