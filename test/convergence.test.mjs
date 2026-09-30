// convergence.test.mjs — the neighbourhood's falsifiable claims.
// Every test states what counts as failure. Negative controls are tests of the
// guarantees' failure modes, per house doctrine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Replica, merge } from "../src/replica.mjs";
import { canonicalize } from "../src/canonical.mjs";

// Seeded PRNG so shuffle order is reproducible — determinism must be a witnessed fact,
// not a hope (same seed => same run on any machine).
function prng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function shuffled(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

test("T1: 3-replica partition/rejoin converges to one revision and one state, any merge order", () => {
  // Three replicas work in isolation (partition), each diverges, then pairwise merges
  // (rejoin) in 10 seeded random orders. Failure = any two replicas disagree on
  // revision bytes, state bytes, or diff knowledge after rejoin.
  for (let trial = 0; trial < 10; trial++) {
    const rand = prng(0xC0FFEE + trial);
    const mk = () => new Replica(`r${trial}`, "fleet");
    const replicas = [mk(), mk(), mk()];

    // partitioned work
    replicas[0].set("lane", "quilts");
    replicas[0].set("entropy", "comet-qrng-v1");
    replicas[1].set("lane", "lattice");
    replicas[2].remove("entropy"); // concurrent with r0's set (P2 case)
    replicas[2].set("frontier", "slackwater");

    // rejoin: pairwise merges in random order until fixpoint
    for (let round = 0; round < 3; round++) {
      const order = shuffled([0, 1, 2], rand);
      merge(replicas[order[0]], replicas[order[1]]);
      merge(replicas[order[1]], replicas[order[2]]);
      merge(replicas[order[2]], replicas[order[0]]);
    }
    const revs = replicas.map((r) => r.revision());
    const states = replicas.map((r) => canonicalize(r.state()));
    const counts = replicas.map((r) => r.diffCount());
    assert.equal(new Set(revs).size, 1, `trial ${trial}: revisions diverged: ${revs}`);
    assert.equal(new Set(states).size, 1, `trial ${trial}: states diverged`);
    assert.equal(new Set(counts).size, 1, `trial ${trial}: knowledge diverged: ${counts}`);
    assert.equal(replicas[0].diffCount(), 5, "all 5 diffs known everywhere");
  }
});

test("T2: fold is deterministic — same DAG folded twice gives byte-identical state", () => {
  const a = new Replica("a"), b = new Replica("b");
  a.set("x", 1); b.set("x", 2); b.set("y", 3);
  merge(a, b); merge(b, a);
  const r = new Replica("witness");
  merge(a, r);
  const first = canonicalize(r.state());
  assert.equal(first, canonicalize(a.state()));
  assert.equal(first, canonicalize(r.state()), "fold twice -> byte-identical");
});

test("T3 (P2): concurrent set vs remove -> remove wins everywhere", () => {
  const a = new Replica("a"), b = new Replica("b");
  a.set("cell", "alive");
  merge(a, b); // b knows the set
  // partition: b removes (causally after), a sets a NEW value concurrently
  b.heads.clear(); b.heads.add(a.revision); // not used; instead craft real concurrency:
  const a2 = new Replica("a2"), b2 = new Replica("b2");
  const seedDiff = a2.set("cell", "v0");
  merge(a2, b2);
  // rewind both to the shared head, then diverge concurrently
  const r1 = new Replica("c1"), r2 = new Replica("c2");
  merge(a2, r1); merge(a2, r2);
  void seedDiff;
  r1.set("cell", "from-r1");
  r2.remove("cell");
  merge(r1, r2); merge(r2, r1);
  assert.equal(r1.state().cell, undefined, "remove must win over the concurrent set");
  assert.equal(r2.state().cell, undefined);
});

test("T4 (P1): set causally AFTER a remove resurrects the cell", () => {
  const a = new Replica("a"), b = new Replica("b");
  a.set("cell", "v1");
  merge(a, b);
  b.remove("cell");
  merge(b, a); // a now knows the tombstone
  a.set("cell", "v2"); // causally after the tombstone -> resurrection is legitimate
  merge(a, b);
  assert.equal(a.state().cell, "v2");
  assert.equal(b.state().cell, "v2");
});

test("T5: revision is a pure function of the head set — identical DAGs, identical bytes", () => {
  const a = new Replica("x"), b = new Replica("y");
  a.set("k", "v"); b.remove("gone");
  const w1 = new Replica("w1"), w2 = new Replica("w2");
  merge(a, w1); merge(b, w1);
  merge(b, w2); merge(a, w2);
  assert.equal(w1.revision(), w2.revision());
  assert.equal(canonicalize(w1.state()), canonicalize(w2.state()));
});

test("NC1: a tampered diff is rejected on sight and the rejection is receipted", () => {
  const a = new Replica("author"), b = new Replica("guard");
  const d = a.set("payload", "honest");
  const forged = { ...d, value: "tampered" }; // value flipped, id not recomputed
  const res = b.receive(forged);
  assert.equal(res.accepted, false, "forged diff must be rejected");
  assert.match(res.reason, /id mismatch/);
  assert.equal(b.diffCount(), 0, "forged diff must not enter the DAG");
  assert.equal(b.receipts.at(-1).kind, "reject", "rejection must be receipted");
  // honest path still works
  assert.equal(b.receive(d).accepted, true);
  assert.equal(b.state().payload, "honest");
});

test("NC2: receipt-chain tamper detection — flipping any entry breaks verifyReceipts", () => {
  const a = new Replica("t");
  a.set("k", "v"); a.remove("k"); a.set("k2", "v2");
  assert.ok(a.verifyReceipts());
  const saved = a.receipts.at(-1);
  a.receipts.at(-1).payload_sha = "0".repeat(64);
  assert.equal(a.verifyReceipts(), false, "tampering the tail must be detected");
  a.receipts.at(-1).payload_sha = saved.payload_sha;
  a.receipts[0].payload_sha = "1".repeat(64);
  assert.equal(a.verifyReceipts(), false, "tampering the head must be detected");
});

test("NC3: merge is monotone — receiving never drops knowledge", () => {
  const a = new Replica("a"), b = new Replica("b");
  a.set("k1", "v1");
  merge(a, b);
  const before = b.diffCount();
  b.set("k2", "v2");
  merge(a, b); // re-merge: nothing new, nothing lost
  assert.equal(b.diffCount(), before + 1);
  assert.equal(b.state().k1, "v1");
  assert.equal(b.state().k2, "v2");
});
