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

---

# TEST-RECEIPT — quilt-neighbourhood v0.3.0

Receipt three-elements: what was run, what came back, what counts as failure.

- **Run**: `node --test test/*.test.mjs` — Node v24.21.0, Linux container.
- **Came back**: 20 tests, **20 pass / 0 fail / 0 skipped** (v0.2.0's 14 + S0–S4 + NC5), ~230ms wall. Re-run 5× consecutively: 20/20 every time (determinism discipline holds with per-run Ed25519 key material — every signed-test assertion is relational, no pinned key bytes, no Math.random).
- **Counts as failure**: any of the v0.2.0 conditions, plus — a base32/did encoding that does not round-trip its key bytes (S0), signatures leaking into id/canonical bytes or revisions differing between a signed sheet and the unsigned re-run of the same values (S1), a value-flipped or cross-key-signed diff accepted or an un-receipted rejection in a signed sheet (S2), the NC5 downgrade asymmetry being *hidden* rather than stated, an allowlisted sheet admitting a validly-signed unknown did (S3), any field tamper surviving verification — in particular a self-consistent (id-recomputed) forgery with a stale signature, which only the signature can catch (S4).

## Signature contract (run-verified)

- `did = "did:key:z" + RFC4648 base32 (no padding, canonical zero tails) of the raw 32-byte ed25519 public key` — 52 chars; S0 pins the RFC §10 vectors ("foobar" → `MZXW6YTBOI`, …) and the did↔key round-trip. Study-local flavor; deliberately not W3C-multibase (base58btc + `0xed 0x01` prefix) — documented in README.
- `sig = base64(Ed25519_sign(sha256_digest_bytes(canonical(diff-without-sig))))` — equivalently, **the signature covers the 32-byte diff-id buffer**. `sig` is an overlay excluded from id/canonical computation (diff.mjs strips it; canonical.mjs untouched): S1 shows `makeDiff` over the same payload with or without `sig` yields identical ids and identical revisions. This is the decision of record: **sigs never enter identity, revisions stay value-pure**.
- Receipt taxonomy: tampered payload → `reject` (id gate, v0.2.0 semantics, S2A/S4); intact payload with missing/malformed/cross-key sig or off-allowlist author → `reject-sig` (S2B/NC5/S3/S4 stale-sig case). The stale-sig self-consistent forgery is the load-bearing negative control: the content hash alone would accept it; the signature is what rejects it.
- The v0.2.0 suite is untouched and green: unsigned sheets keep v0.2.0 behavior exactly (they never examine `sig`).

## Experiment receipts (re-reproduction under v0.3.0)

- Both v0.2.0 experiments re-run untouched (`node experiment/train_replicas.mjs`, `node experiment/train_replicas_sharedinit.mjs`): identical claims re-verified (24/24 merge orders → 1 distinct state/revision; phase-1 semantic fail and phase-2 bound-hold reproduce with identical numbers). Regenerated receipt JSONs diff against the committed v0.2.0 receipts **only in `timestamps.started/finished`** — the signature layer changed no experiment byte.

---

# TEST-RECEIPT — quilt-neighbourhood v0.4.0 (P7 epsilon-diff)

Receipt three-elements: what was run, what came back, what counts as failure.

- **Run**: `node --test test/*.test.mjs` — Node v24.21.0. **Came back**: 28 tests, **28 pass / 0 fail / 0 skipped** (v0.3.0's 20 + E1–E7 + NC6).
- **Counts as failure** (P7 additions): a below-epsilon write emitting a diff, or an above-epsilon write skipped (E1); violation of the bounded-error invariant |merged_eps − merged_exact| ≤ epsilon per element (E2); skip decisions making merges order-dependent (E3); a skipped write contributing to a P5 mean or the mean running over non-emitted values (E4); exact mode skipping anything (E5); array cells not element-wise (E6); a shape/type-incompatible write silently skipped (E7); writes − emits ≠ skip-eps receipts on any replica (NC6 — no silent drops).
- **Experiment of record** (`node experiment/train_replicas_eps.mjs` → `receipts/experiment-v0.4.0-eps.json`): checkpoint federated averaging (4 shared-basin replicas, 300 steps, checkpoints every 50) at ε=1e-4 — **X1 HELD** (max element error 2.0378e-5 ≤ 1e-4, worst cell b1:4), **X2 HELD** (|loss_eps − loss_exact| = 1.4456e-8 ≤ 0.01 band), **X3 HELD** (24/24 orders → 1 revision, byte-identical state), **X4 HELD** (writes 624 − emits 517 = 107 skip receipts exactly; chains verify). Sparsity 17.1% at ε=1e-4 (checkpoint cadence bounds per-episode drift; larger ε trades bound for sparsity — receipted, not swept).
