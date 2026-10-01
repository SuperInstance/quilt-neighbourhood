// tombstone-head.test.mjs — the tombstone-head invariant (wave-72 regression for
// the wave-71 finding "removes are first-class heads").
//
// FINDING (wave-71, scripts/w71_dag_replay.mjs over three git histories): a fold
// (or an emitter) that ignores delete events when tracking the per-cell head makes
// post-tombstone writes concurrent SIBLINGS of their tombstone; P2 then buries
// legitimate resurrects (905 resurrects buried in the animal-ai replay before the
// fix). The contract: EVERY delete event updates the fold's per-cell causality
// anchors — the live tombstone set — and a set resurrects only by dominating ALL
// of them (dominating one anchor while staying concurrent with another is P2:
// remove wins).
//
// What counts as failure:
//   TH1 — a post-tombstone set that chains onto the tombstone (child, not sibling)
//         is buried instead of resurrected (the wave-71 bug, linear case);
//   TH2 — a set emitted as a TRUE SIBLING of the tombstone (the emitter never saw
//         the delete — the exact wave-71 emission bug) SURVIVING the fold: that
//         burial is P2 working as designed and must stay;
//   TH3/TH4 — with two concurrent tombstones on a cell, a set that dominates one
//         anchor while concurrent with the other resurrecting (pre-fix behavior:
//         P2 violation, outcome flipped with the concurrent diffs' id order);
//   TH5 — a set chaining through a tombstone CHAIN (delete-after-delete) failing
//         to resurrect (the anchor tracking must not over-bury causal writes);
//   TH6 — arrival order changing the folded state (the fold is topo-pure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Replica } from "../src/replica.mjs";
import { makeDiff, OP } from "../src/diff.mjs";
import { canonicalize } from "../src/canonical.mjs";

// Hand-built diff helper: the DAG shapes below cannot all be produced by a single
// replica's set()/remove() alone (partitioned emission must be simulated).
const mk = (op, value, parents, ts, author) =>
  makeDiff({ sheet: "s", cell: "cell", op, value, prev: null, author, ts, parents });

test("TH1 (tombstone-head): [set A1, remove D, set A2] — A2 is a CHILD of the delete event and resurrects; P2 must not bury it", () => {
  const r = new Replica("r", "s");
  r.set("cell", "A1", { ts: 1000 });
  const D = r.remove("cell", { ts: 1001 });
  const A2 = r.set("cell", "A2", { ts: 1002 });
  // Structural: the tombstone is a first-class head — the replica's next write
  // parents onto it. A2 is a child of the delete, NOT a concurrent sibling.
  assert.deepEqual(A2.parents, [D.id], "A2 must chain onto the tombstone head");
  // Semantic: the resurrect survives the fold. The old bug (deletes not tracked as
  // heads -> post-tombstone write becomes a sibling -> P2 buries it) must NOT appear.
  assert.equal(r.state().cell, "A2", "causally-after post-tombstone write must resurrect");
  // A second witness folding the same DAG agrees.
  const w = new Replica("w", "s");
  for (const d of [A2, D, ...r.diffs.values()].reverse()) w.receive(d);
  assert.equal(w.state().cell, "A2", "witness fold agrees");
});

test("TH2 (NC, the wave-71 bug class itself): a set emitted as a SIBLING of the tombstone is buried by P2 — and must stay buried", () => {
  // This is what the naive wave-71 emitter produced: A2' whose parents name the
  // pre-delete set only, so it never saw the tombstone. P2 (remove wins over a
  // concurrent set) is CORRECT here — the burial is the guarantee, not the bug.
  const A1 = mk(OP.SET, "A1", ["GENESIS"], 2000, "a");
  const D = mk(OP.REMOVE, undefined, [A1.id], 2001, "d");
  const A2sib = mk(OP.SET, "A2", [A1.id], 2002, "a2");
  const r = new Replica("r", "s");
  for (const d of [A1, D, A2sib]) r.receive(d);
  assert.equal(r.state().cell, undefined, "a write concurrent with a tombstone it never saw: P2 remove wins");
});

test("TH3 (P2, multi-tombstone): a set dominating tombstone D1 while CONCURRENT with tombstone D2 does not resurrect", () => {
  // Ids pinned (ts/author values found by search) so the topo order is D1, D2, S —
  // the exact order in which the pre-fix fold resurrected S (its single anchor
  // stayed on D1) even though S is concurrent with D2's tombstone.
  const A1 = mk(OP.SET, "A1", ["GENESIS"], 5000, "auth-n4");
  const D1 = mk(OP.REMOVE, undefined, [A1.id], 5001, "d1-n4");
  const D2 = mk(OP.REMOVE, undefined, [A1.id], 5002, "d2-n4");
  const S = mk(OP.SET, "resurrect", [D1.id], 5003, "s-n4");
  assert.ok(D1.id < D2.id && D2.id < S.id, "pinned ids must give topo order D1,D2,S");
  const r = new Replica("r", "s");
  for (const d of [A1, D1, D2, S]) r.receive(d);
  assert.equal(r.state().cell, undefined, "dominates D1 but concurrent with D2: P2 remove wins");
});

test("TH4 (P2, multi-tombstone mirror): a set dominating D2 while CONCURRENT with D1 does not resurrect", () => {
  // Mirror of TH3 with the pinned order D2, D1, S — the other id ordering in which
  // the pre-fix fold resurrected. Both mirrors must agree: P2, not id luck.
  const A1 = mk(OP.SET, "A1", ["GENESIS"], 7000, "auth-n0");
  const D1 = mk(OP.REMOVE, undefined, [A1.id], 7001, "d1-n0");
  const D2 = mk(OP.REMOVE, undefined, [A1.id], 7002, "d2-n0");
  const S = mk(OP.SET, "resurrect", [D2.id], 7003, "s-n0");
  assert.ok(D2.id < D1.id && D1.id < S.id, "pinned ids must give topo order D2,D1,S");
  const r = new Replica("r", "s");
  for (const d of [A1, D1, D2, S]) r.receive(d);
  assert.equal(r.state().cell, undefined, "dominates D2 but concurrent with D1: P2 remove wins");
});

test("TH5 (P1, tombstone chain): [set, remove, remove, set] — a set chaining through BOTH deletes resurrects", () => {
  // The anchor tracking must not over-bury: every delete updates the anchors, and
  // a set that causally dominates the whole chain resurrects (P1).
  const r = new Replica("r", "s");
  r.set("cell", "A1", { ts: 8000 });
  r.remove("cell", { ts: 8001 });
  r.remove("cell", { ts: 8002 });
  r.set("cell", "A2", { ts: 8003 });
  assert.equal(r.state().cell, "A2", "a set dominating every tombstone anchor resurrects");
});

test("TH6: the TH3 DAG folded in reversed arrival order gives the identical state (fold is topo-pure)", () => {
  const A1 = mk(OP.SET, "A1", ["GENESIS"], 5000, "auth-n4");
  const D1 = mk(OP.REMOVE, undefined, [A1.id], 5001, "d1-n4");
  const D2 = mk(OP.REMOVE, undefined, [A1.id], 5002, "d2-n4");
  const S = mk(OP.SET, "resurrect", [D1.id], 5003, "s-n4");
  const fwd = new Replica("fwd", "s");
  const rev = new Replica("rev", "s");
  for (const d of [A1, D1, D2, S]) fwd.receive(d);
  for (const d of [S, D2, D1, A1]) rev.receive(d);
  assert.equal(canonicalize(fwd.state()), canonicalize(rev.state()), "arrival order must not matter");
  assert.equal(fwd.state().cell, undefined, "and the state is the P2-correct tombstone");
});
