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
