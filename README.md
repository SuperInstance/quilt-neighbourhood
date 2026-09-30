# quilt-neighbourhood

**Diff-DAG convergence for Quilt sheets.** A neighbourhood is a set of sheet replicas that partition, diverge freely, and rejoin to **one revision and one state — byte-for-byte, every time, in any merge order**.

> Study credit: the contract is inspired by coasys/AD4M's PerspectiveDiff sync (content-hash diff DAG + OR-Set fold, proven across 13 substrates — see our study of github.com/coasys, Sept 2026). Rebuilt here in SuperInstance's idiom: content-addressed cell diffs, a registered merge policy, and an append-only receipt chain. Their ontological base — *data without authorship is meaningless* — is carried in every diff's `author` field.

## The contract

- **CellDiff** — `{sheet, cell, op: set|remove, value, prev, author, ts, parents[]}`. `parents` are the diff ids the author had seen: the log is a DAG, divergence is structural, and a merge needs no coordinator. `id = sha256(canonical(diff))` — identity is content, tampering is self-evident.
- **Revision** — `sha256(sorted head ids)`. Two replicas agree on the neighbourhood iff their revision bytes agree.
- **Registered merge policy** (deterministic, a pure function of the DAG):
  - `P1` set causally after a tombstone → resurrect
  - `P2` set concurrent with a tombstone → **remove wins** (`REMOVE_WINS_CONCURRENT`)
  - `P3` concurrent sets → lexicographically smaller diff id wins
  - `P4` remove/remove → idempotent tombstone
  - `P5` concurrent sets on a **numeric** cell → **mean of contributors, summed in canonical order** (lexicographic diff-id order — the contributor *set* determines the sum order, so the result is byte-identical in every merge order). Mixed numeric/non-numeric contributors fall back to P3; removes still win via P2; a causally-later set after a P5 merge is a plain set. NaN/±Infinity are rejected at cell-write time with a receipted rejection.
- **Receipt chain** — every state change (accept or reject) is sealed: `{seq, kind, payload_sha, prev_sha, sha}`. Flip any entry anywhere and `verifyReceipts()` fails. The chain is the honesty surface.

## What counts as failure

The suite (`node --test test/`) states its own failure conditions:

| # | claim | failure means |
|---|-------|---------------|
| T1 | 3-replica partition/rejoin converges in 10 seeded merge orders | any revision/state/knowledge divergence |
| T2 | fold is deterministic (byte-identical, folded twice) | any byte difference |
| T3 | P2: concurrent set vs remove → removed everywhere | cell survives anywhere |
| T4 | P1: causal set after remove resurrects | resurrection rejected |
| T5 | revision is a pure function of the head set | same DAG, different bytes |
| T6 | P5: 4 concurrent numeric sets merge byte-identical in all 24 orders | any order-dependent byte/revision |
| T7 | P5 mean correctness vs reference order-sum (and the order hazard is real) | mean differs from canonical-order sum |
| T8 | P5 × P2/P1: removes dominate numeric groups; causal resurrection is a plain set | a tombstone loses to a numeric mean |
| T9 | P5 fallback: mixed/shape-incompatible contributors resolve by P3, not mean | garbage mean accepted |
| T10 | set causally after a P5 merge is a plain set, not a new mean | mean accumulates across causal steps |
| NC1 | tampered diff rejected + receipted | forgery accepted |
| NC2 | receipt tamper detected (head and tail) | chain lies |
| NC3 | merge is monotone (knowledge never shrinks) | re-merge loses anything |
| NC4 | adversarial floats (0.1, 1/3, 1e-7, 2^53, −0.0) converge through 120 shuffled orders; NaN rejected at write | any order-dependent bit pattern; NaN accepted |

Negative controls are tests of the guarantees' failure modes — if NC1/NC2 ever pass vacuously, the guarantees are decorative.

## What v0.2.0 proved with it (ML in quilts)

Neural replicas whose weight updates are numeric cells **merge to one byte-identical model state in all 24 merge orders**, and that state is semantically meaningful **iff replicas share one loss basin**: shared-init replicas averaging to a model *better than every contributor* (loss 0.0010465 vs worst 0.0010889), while independent-init averaging fails honestly (merged loss 0.3614 vs per-replica ~0.0068 — different basins, permutation symmetry). Both directions receipted. Full arc in [EXPERIMENT.md](EXPERIMENT.md).

## Honest limitations (v0.2.0)

- The policy is **coarser than a full OR-Set**: removal is per-cell, not per-add-id. Per-add-id removal is a future contract.
- No transport. Replicas exchange diffs in memory; wiring this to `LocalCellTransport`/MCP is the next lane.
- No signatures. `author` is a claim, not a proof; DID-signed diffs (coasys's did:key pattern) are next.
- No Quilt-engine integration yet — this is the convergence substrate, engine-shaped, not engine-wired.
- P5's mean-of-weights semantics require shared-basin replicas (see EXPERIMENT.md); the substrate enforces determinism, not model alignment.

## Receipt

See [TEST-RECEIPT.md](TEST-RECEIPT.md) and [EXPERIMENT.md](EXPERIMENT.md) for the run-verified numbers behind this version.
