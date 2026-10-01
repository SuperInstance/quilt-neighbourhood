# quilt-neighbourhood

**Diff-DAG convergence for Quilt sheets.** A neighbourhood is a set of sheet replicas that partition, diverge freely, and rejoin to **one revision and one state — byte-for-byte, every time, in any merge order**.

> Study credit: the contract is inspired by coasys/AD4M's PerspectiveDiff sync (content-hash diff DAG + OR-Set fold, proven across 13 substrates — see our study of github.com/coasys, Sept 2026). Rebuilt here in SuperInstance's idiom: content-addressed cell diffs, a registered merge policy, and an append-only receipt chain. Their ontological base — *data without authorship is meaningless* — is carried in every diff's `author` field.

## The contract

- **CellDiff** — `{sheet, cell, op: set|remove, value, prev, author, ts, parents[]}`. `parents` are the diff ids the author had seen: the log is a DAG, divergence is structural, and a merge needs no coordinator. `id = sha256(canonical(diff))` — identity is content, tampering is self-evident.
- **Revision** — `sha256(sorted head ids)`. Two replicas agree on the neighbourhood iff their revision bytes agree.
- **Registered merge policy** (deterministic, a pure function of the DAG):
  - `P1` set causally after **all** live tombstones → resurrect
  - `P2` set concurrent with **any** tombstone → **remove wins** (`REMOVE_WINS_CONCURRENT`)
  - `P3` concurrent sets → lexicographically smaller diff id wins
  - `P4` remove/remove → idempotent tombstone
  - `P5` concurrent sets on a **numeric** cell → **mean of contributors, summed in canonical order** (lexicographic diff-id order — the contributor *set* determines the sum order, so the result is byte-identical in every merge order). Mixed numeric/non-numeric contributors fall back to P3; removes still win via P2; a causally-later set after a P5 merge is a plain set. NaN/±Infinity are rejected at cell-write time with a receipted rejection.
  - `P6` **signed sheet** (v0.3.0): every accepted diff must carry a valid **Ed25519 signature over its 32-byte diff id**, verifiable under the public key embedded in the author's did; `signed: { authors: [...] }` additionally pins an author allowlist. Unsigned or badly-signed diffs are rejected with the dedicated receipt kind `reject-sig`.
  - `P7` **epsilon-diff** (v0.4.0): a numeric `set()` whose value is within epsilon (per element) of the replica's current DAG value emits **no diff** — the write is sealed as a receipted `skip-eps` (never silent) and `set()` returns null. THE P7 INVARIANT: after every write, the DAG value is within epsilon of the most recently written value, so the merged state is a **bounded approximation** of the exact-communication state (|merged_eps − merged_exact| ≤ epsilon per element). Shape/type-incompatible writes always emit. `epsilon: 0` is exact v0.3.0 behavior.
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
| TH1 | [set, remove, set]: the post-tombstone write chains onto the delete (child, not sibling) and resurrects | the wave-71 bug: P2 burying a causally-after resurrect |
| TH2 | NC: a set emitted as a true SIBLING of the tombstone stays buried (P2 working) | the burial failing = concurrent writes surviving deletes |
| TH3/TH4 | with two concurrent tombstones, a set dominating one anchor while concurrent with the other stays buried, in both id orders | resurrection by id luck (pre-fix fold behavior) |
| TH5 | a set chaining through a tombstone CHAIN (delete-after-delete) resurrects | over-burial: anchor tracking killing causal writes |
| TH6 | the TH3 DAG folded in reversed arrival order gives identical state | arrival order mattering |
| S0 | base32 is RFC 4648-exact (no padding, canonical tails); the did embeds the exact public key | a did that does not round-trip its key |
| S1 | two signers merge into a signed sheet; sigs verify; revision equals the unsigned re-run of the same values | sig entering id/canonical; revision drifting with signatures |
| S2 | value-flipped and cross-key-signed diffs rejected with receipts in a signed sheet | forgery accepted; un-receipted rejection |
| NC5 | an unsigned sheet accepts the very diffs a signed sheet rejects (downgrade asymmetry, stated, not hidden) | the asymmetry being hidden |
| S3 | a validly-signed unknown did is rejected under an allowlist, accepted without one | allowlist ignoring, or proof conflated with policy |
| S4 | tampering ANY field after signing fails verification; a self-consistent forgery with a stale sig is caught by the signature alone | the sig adding nothing over the content hash |

Negative controls are tests of the guarantees' failure modes — if NC1/NC2 ever pass vacuously, the guarantees are decorative.

## Signed sheets (v0.3.0) — authorship becomes proof

In v0.2.0 `author` was a claim, not a proof. v0.3.0 adds a signature layer (composition — the v0.2.0 modules keep their semantics):

```js
import { generateKeypair, signDiff, verifyDiff } from "@superinstance/quilt-neighbourhood/src/signed.mjs";
import { Replica, merge } from "@superinstance/quilt-neighbourhood/src/replica.mjs";

const kp = generateKeypair();                       // { did, publicKey, privateKey } (ed25519, node:crypto)
const sheet = new Replica("r1", "fleet", {
  schema: { signed: true },                         // or { signed: { authors: [kp.did, otherDid] } }
});
sheet.set("cell", "value", { privateKey: kp.privateKey }); // author defaults to kp.did; unsigned local writes throw (receipted)
merge(otherReplica, sheet);                         // every accepted diff's sig verified at receive
```

- **did format**: `did:key:z` + RFC 4648 base32 (alphabet `A-Z2-7`, **no padding**, canonical zero tail bits) of the **raw 32-byte ed25519 public key** — 52 chars after the prefix. The did embeds its own verifying key, so a signature is checkable from the did alone. *Honest note:* this is the coasys-style did:key *pattern* with a study-local encoding — the W3C did:key spec for ed25519 uses base58btc of the multicodec-prefixed key (`0xed 0x01 ‖ raw`) and is NOT interoperable with this flavor.
- **What is signed**: exactly the **32-byte diff id** (`sig = base64(Ed25519_sign(sha256_digest_bytes_of_canonical(diff-without-sig)))`; since `sig` is excluded from id/canonical computation, that digest is the id). The id is computed before signing; `sig` is an **overlay**: signing/stripping/re-signing never changes the id, so **revisions stay value-pure** — a signed sheet and an unsigned re-run of the same values reach byte-identical revisions (S1 pins this).
- **Why the sig has teeth**: a tampered-AND-id-recomputed forgery passes the content-hash check (self-consistent) but fails the signature check — only someone holding the author's key can make a (payload, id) pair whose id's signature verifies (S4 pins this).
- **Receipt taxonomy**: identity broken (tampered payload/stale id) → kind `reject` (v0.2.0 semantics, NC1); identity intact but authorship unproven (missing/malformed sig, unparseable did, sig that does not verify, author off the allowlist) → kind `reject-sig`.
- **Unsigned sheets are byte-for-byte v0.2.0**: they never examine `sig` (and a v0.3.0 unsigned sheet will happily receive signed diffs — the overlay does not break identity).

## What v0.4.0 added (P7: sparse federated training)

Checkpoint federated averaging with ε=1e-4: 624 potential cell-writes → 517 emitted (17.1% skipped, every skip receipted), while the merged model stayed a *bounded* approximation of the exact-communication merged model — max element error 2.04e-5 (≤ ε), loss difference 1.45e-8, 24/24 merge orders byte-identical. Communication-efficient FL with a proof-shaped bound, in the diff-DAG idiom. Receipts: `receipts/experiment-v0.4.0-eps.json`.

## What v0.2.0 proved with it (ML in quilts)

Neural replicas whose weight updates are numeric cells **merge to one byte-identical model state in all 24 merge orders**, and that state is semantically meaningful **iff replicas share one loss basin**: shared-init replicas averaging to a model *better than every contributor* (loss 0.0010465 vs worst 0.0010889), while independent-init averaging fails honestly (merged loss 0.3614 vs per-replica ~0.0068 — different basins, permutation symmetry). Both directions receipted. Full arc in [EXPERIMENT.md](EXPERIMENT.md).

## Tombstone-head invariant + RFC P8 (v0.4.1)

Wave-71 replayed three real git histories (766 commits, 37,523 diffs) through a CellDiff DAG fold and surfaced two tool-semantics findings, both now contract:

- **Removes are first-class heads (v0.4.1 fix, `src/replica.mjs` `state()`).** Every delete event updates the fold's per-cell causality anchors — the live tombstone set — including a delete landing on a cell that is already a tombstone. A set resurrects only by dominating **all** live tombstones; dominating one while concurrent with another is P2. A fold that anchors on a single tombstone (or ignores deletes) makes post-tombstone writes concurrent siblings of their tombstone and buries legitimate resurrects — 905 seen in the animal-ai replay before the wave-71 fix. Guarded by TH1–TH6.
- **Git merges are reconciliation events (RFC [P8](RFC-P8-reconciliation-events.md), draft).** A merge commit's tree can differ from **both** parents (criss-cross content — e.g. animal-ai merge `0ec71be`: blob `19d3b98e` differs from both `dc1306c5` and `91320f61`, holding each side's contribution), so it is **not derivable from the diff streams**. P8 specs the event: `parents: [both branch heads]`, `asserted_tree`, one rec-diff per differing cell per parent (asserted against BOTH parents). It is an emission-layer event, not a sixth conflict policy — rec-diffs are causally after both heads, so the existing P1–P5 fold applies them unchanged. Seed of record: 45 merges → 13,062 rec-diffs, replay converged 1,017 == 1,017 on git HEAD.

## Reconciliation events (v0.5.0) — P8 implemented

RFC P8 is now code: `src/reconciliation.mjs` (event schema, identity gate,
deterministic rec-diff emission) + `Replica.applyReconciliation` (fail-closed
application). A criss-cross merge result — content matching NEITHER parent —
travels as a first-class DAG event: marker rep(R) parented on BOTH branch heads,
plus rec-diffs (one per differing cell per parent) that apply through the
UNCHANGED P1-P5 fold. Application is fail-closed: tampered events fail the id
gate, unknown parents refuse (partial knowledge is not applicable), signed
sheets refuse unsigned rec-diffs (P6 interplay stays an open question, Q2),
and the fold must land exactly on the asserted tree or nothing applies.
Re-application of a known event is a no-op; emission is deterministic
(identical marker id on independent replicas). Guarded by R1-R5 in
`test/reconciliation.test.mjs`, including a seeded 50-iteration random-history
replay property (both sides + shuffled witness converge on the asserted tree).

## Honest limitations (v0.3.0)

- The policy is **coarser than a full OR-Set**: removal is per-cell, not per-add-id. Per-add-id removal is a future contract.
- No transport. Replicas exchange diffs in memory; wiring this to `LocalCellTransport`/MCP is the next lane.
- **Ed25519 is not post-quantum** — a quantum adversary with recorded signatures and enough compute could forge authorship. Post-quantum DID signatures are a future contract.
- **Key custody is out of scope**: no revocation, rotation, or recovery protocol. A compromised key is a compromised author until the sheet's allowlist is updated; a lost key is a lost identity. The allowlist (`signed: { authors }`) is the only admission control.
- **Unsigned-sheet downgrade risk (documented, not hidden — NC5)**: an unsigned sheet cannot examine signatures at all, so it accepts any well-formed diff — including ones a signed sheet rejects (cross-key sigs, off-allowlist authors, stripped sigs). Signatures protect the sheets that enforce them; mixing signed and unsigned replicas in one neighbourhood means the neighbourhood is only as strong as its weakest sheet. Also note: a *v0.2.0 replica* (old code) rejects signed diffs outright, because its `verifyDiff` hashes the whole diff minus id — including `sig`. Upgraded-but-unsigned sheets accept them; old binaries reject them.
- The did flavor is study-local (base32 of the raw key), not W3C-multibase interoperable (see Signed sheets).
- No Quilt-engine integration yet — this is the convergence substrate, engine-shaped, not engine-wired.
- P5's mean-of-weights semantics require shared-basin replicas (see EXPERIMENT.md); the substrate enforces determinism, not model alignment.

## Receipt

See [TEST-RECEIPT.md](TEST-RECEIPT.md) and [EXPERIMENT.md](EXPERIMENT.md) for the run-verified numbers behind this version.
