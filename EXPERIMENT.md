# EXPERIMENT — trained replicas as quilt cells (v0.2.0)

**Question.** If neural-network weight updates live as content-addressed CellDiffs in a diff DAG, can N independently-training replicas rejoin to **one deterministic model state — byte-for-byte, in every merge order** — and is that state *semantically* meaningful (a model that works)?

**Answer (receipted, two phases):** the substrate is byte-perfect; the semantics of averaging have a **basin condition**.

## Phase 1 — independent inits: machinery PASS, semantics FAIL

4 replicas of a tiny 1-6-6-1 MLP (manual backprop, no deps) each trained 300 full-batch steps on the same 48 seeded points (target `y = 0.7·sin(2.5x) + 0.3x³`, seed 20260930), then serialized every weight row / bias as a numeric cell of sheet `mlp0` (26 cells; genesis committed the shared pre-training weights first). The 4 post-training diffs per cell are concurrent siblings, merged under the **P5 numeric policy** (concurrent sets on a numeric cell → mean, summed in canonical order = lexicographic diff-id order).

| claim | result |
|---|---|
| merged state byte-identical (canonical JSON **and** float64 bit-hex) across all 24 merge orders | **HELD** — 1 distinct state, 1 revision `d0e04458…` |
| merged weights == independent reference mean, byte-for-byte on all 26 cells, 4 contributors/cell | **HELD** — 0 mismatches |
| receipt chains verify on all 24 coordinators | **HELD** |
| merged model's loss ≈ the replicas' losses | **FAILED, honestly** — merged **0.3614** vs per-replica **0.0061–0.0077** (mean 0.0068), genesis baseline 0.4430 |

The failure is real machine learning, not an engineering bug: independently-initialized networks descend into **different loss basins** (hidden units are permutation-symmetric; each replica's unit 3 may encode what another replica's unit 5 learned). Element-wise averaging of weights from different basins interpolates between basins — the merged net lands near the random-init ridge (0.443 → 0.361), not near the trained manifold. The DAG faithfully merged meaningless numbers; the meaning was never in the cells.

## Phase 2 — shared-basin positive control: semantics HELD

Prediction from the theory: averaging is meaningful **iff replicas share one basin**. Test: all 4 replicas start **at the genesis weights** (shared init, seed 20260930) and diverge **only through data order** — mini-batch SGD, batch 8, per-replica shuffle seeds 11/22/33/44, 300 steps. Pre-registered bound (before running): `merged_loss ≤ 1.5 × worst_replica_loss`.

| claim | result |
|---|---|
| structural: 24/24 orders → 1 state, 1 revision, byte-parity with reference, receipts verify | **HELD** |
| semantic (pre-registered bound ≤ 0.0016333) | **HELD** — merged **0.0010465** |
| — and against each replica | merged **beats every replica**: r1 0.0010668, r2 0.0010600, r3 0.0010889 (worst), r4 0.0010521; mean 0.0010669 |

Weight averaging inside one basin behaves like federated averaging is supposed to: the merged model is at least as good as the mean of its contributors, here strictly better than all of them. The DAG gave every weight row provenance (which replica, which diff id), tamper evidence, and a coordinator-free merge — no parameter server, no all-reduce, just content-addressed diffs and a registered policy.

## What this establishes

1. **Training artifacts can live as quilt cells with byte-exact reproducibility** — 26 numeric cells, 130 diffs, 24 merge orders, one revision, every time.
2. **P5 (canonical-order numeric mean) is a sound merge policy**: deterministic, order-independent (T6–T10, NC4: adversarial floats through 120 shuffled orders, NaN rejected at write with a receipt).
3. **The basin condition is the honest boundary of federated averaging in this idiom**: shared init / shared basin ⇒ averaging works (phase 2); independent inits ⇒ averaging is semantically void even when structurally perfect (phase 1). Both directions are receipted with run-verified numbers.

## Honest limitations

- Scale: 1-6-6-1 MLP, 48 points, 300 steps — the claims are about merge semantics, not SGD theory at scale.
- `epsilon = 0`: every changed cell emits a diff. Real federated lanes would diff at epsilon > 0 (sparser DAGs, approximate means — a v3 policy decision).
- Phase 2's "better than every replica" is a measured outcome on one seed set, not a theorem; the pre-registered claim was the 1.5× worst bound.
- No momentum/adaptive optimizers; full-batch phase 1 vs mini-batch phase 2 differ in more than init (receipts carry both configs).
- The mean is of *weights*, not of *functions*; ensembling or logit-averaging the replicas is a different (and also valid) aggregation the substrate does not model.

## Reproduce

```sh
node experiment/train_replicas.mjs                  # phase 1: independent inits
node experiment/train_replicas_sharedinit.mjs       # phase 2: shared basin
node --test test/*.test.mjs                         # 14 tests, all green
```

Receipts: `receipts/experiment-v0.2.0.json`, `receipts/experiment-v0.2.0-sharedinit.json` (run-verified, Node v24.21.0).
