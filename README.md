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
| NC1 | tampered diff rejected + receipted | forgery accepted |
| NC2 | receipt tamper detected (head and tail) | chain lies |
| NC3 | merge is monotone (knowledge never shrinks) | re-merge loses anything |

Negative controls are tests of the guarantees' failure modes — if NC1/NC2 ever pass vacuously, the guarantees are decorative.

## Honest limitations (v0.1.0)

- The policy is **coarser than a full OR-Set**: removal is per-cell, not per-add-id. Two concurrent `set`s on one cell resolve by id tie-break, not by keeping both. Per-add-id removal is the v2 contract.
- No transport. Replicas exchange diffs in memory; wiring this to `LocalCellTransport`/MCP is the next lane.
- No signatures. `author` is a claim, not a proof; DID-signed diffs (coasys's did:key pattern) are v2.
- No Quilt-engine integration yet — this is the convergence substrate, engine-shaped, not engine-wired.

## Receipt

See [TEST-RECEIPT.md](TEST-RECEIPT.md) for the run-verified numbers behind this version.
