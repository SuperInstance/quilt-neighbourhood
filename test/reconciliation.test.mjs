// reconciliation.test.mjs — RFC P8 implementation tests (wave-72j, v0.5.0).
//
// A merge's tree can differ from BOTH parents (criss-cross): that content is a
// fact about history but is NOT derivable from the diff streams, and no per-cell
// fold policy (P1–P5) is licensed to synthesize it. P8 makes the resolver's
// agreed tree a first-class DAG event: marker rep(R) with BOTH branch heads as
// parents, plus rec-diffs (one per differing cell per parent) that apply through
// the UNCHANGED P1–P5 fold, fail-closed on the asserted tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Replica } from "../src/replica.mjs";
import { generateKeypair } from "../src/signed.mjs";
import { makeReconciliationEvent, verifyReconciliationEvent, markerCellFor, ABSENT } from "../src/reconciliation.mjs";

// Fork helper: a base replica's full diff set replayed into two fresh replicas,
// then each side writes concurrently on top of the SAME base head.
function fork(base, a, b) {
  for (const d of base.diffs.values()) { a.receive(d); b.receive(d); }
}
const live = (r) => Object.fromEntries(Object.entries(r.state()).filter(([k]) => !k.startsWith("_")));

test("R1 criss-cross: asserted value from NEITHER parent lands on both replicas; marker is bookkeeping-only", () => {
  const base = new Replica("base", "s");
  base.set("x", "base", { ts: 1000 });
  const a = new Replica("a", "s"), b = new Replica("b", "s");
  fork(base, a, b);
  const A = a.set("x", "from-A", { ts: 1001 });
  const B = b.set("x", "from-B", { ts: 1001 }); // concurrent with A: true criss-cross setup
  // merge B's side into a (so a's heads = [A, B]); the resolver's agreed value x=3
  // exists in NEITHER parent tree — not derivable by any P1-P5 policy.
  b.diffs.forEach((d) => a.receive(d));
  const evt = makeReconciliationEvent({
    parents: [...a.heads], assertedTree: { x: "resolved-3" }, author: "resolver", ts: 1002,
  });
  // b must know BOTH branch heads before it can apply (the DAG gates application):
  // sync a's PRE-EVENT branch work into b (b then has the same parents as a).
  for (const d of a.diffs.values()) if (!b.diffs.has(d.id) && !d.cell.startsWith("_")) b.receive(d);
  const res1 = a.applyReconciliation(evt);
  assert.equal(res1.applied, true, "first application applies");
  assert.equal(a.state().x, "resolved-3", "asserted (criss-cross) value must land");
  // fail-closed evidence: the asserted value is in NO parent tree
  for (const p of evt.parents) assert.notEqual(a.treeAt(p).x, "resolved-3");
  // witness: a fresh replica receiving every diff (marker + rec-diffs included)
  // in ARBITRARY order folds to the same asserted value — topo-purity.
  const w = new Replica("w", "s");
  const all = [...a.diffs.values()].sort((d, e) => (d.id < e.id ? -1 : 1));
  for (const d of all) w.receive(d);
  assert.equal(w.state().x, "resolved-3", "witness fold agrees");
  // marker cell exists in the DAG but never in state (bookkeeping namespace)
  const markerDiff = [...w.diffs.values()].find((d) => d.cell === markerCellFor(evt));
  assert.ok(markerDiff, "marker diff is a DAG node");
  assert.ok(Object.keys(live(w)).every((k) => !k.startsWith("_")), "no bookkeeping cells leak into state");
  // idempotence: re-applying the SAME event is a no-op
  const res2 = a.applyReconciliation(evt);
  assert.equal(res2.applied, false, "second application is a no-op");
  assert.equal(res2.reason, "known");
  assert.equal(a.state().x, "resolved-3");
  // b (other side) can apply the same event and lands on the same value —
  // emission is deterministic: identical marker id on both sides.
  b.applyReconciliation(evt);
  assert.equal(b.state().x, "resolved-3", "both sides converge on the asserted tree");
  assert.equal(a.diffs.get(markerDiff.id)?.id, [...b.diffs.values()].find((d) => d.cell === markerCellFor(evt))?.id, "marker id deterministic");
});

test("R2 ABSENT asserts deletion on sides that still hold the cell", () => {
  const base = new Replica("base", "s");
  base.set("keep", "K", { ts: 1000 });
  base.set("gone", "G", { ts: 1000 });
  const a = new Replica("a", "s"), b = new Replica("b", "s");
  fork(base, a, b);
  const A = a.remove("gone", { ts: 1001 }); // a deleted it; b still holds G
  b.set("keep", "K1b", { ts: 1001 });       // b's own branch write -> two real heads
  b.diffs.forEach((d) => a.receive(d));    // merge -> heads [A, B-head]
  const evt = makeReconciliationEvent({
    parents: [...a.heads], assertedTree: { gone: ABSENT, keep: "K2" }, author: "resolver", ts: 1002,
  });
  a.applyReconciliation(evt);
  assert.ok(!("gone" in a.state()), "ABSENT must remove the cell");
  assert.equal(a.state().keep, "K2", "present key asserted to new value");
});

test("R3 fail-closed gates: tampered id, unknown parent, signed sheet", async () => {
  const base = new Replica("base", "s");
  base.set("x", "1", { ts: 1000 });
  const a = new Replica("a", "s"), b = new Replica("b", "s");
  fork(base, a, b);
  const A = a.set("x", "2", { ts: 1001 });
  b.set("y", "yside", { ts: 1001 });       // second branch head -> 2 parents for the event
  b.diffs.forEach((d) => a.receive(d));
  const evt = makeReconciliationEvent({ parents: [...a.heads], assertedTree: { x: "3" }, author: "r", ts: 1002 });
  // tamper: any field edit breaks the id (NC1 ethos) and is rejected BEFORE anything applies
  const forged = { ...evt, asserted_tree: { x: "evil" } };
  assert.equal(verifyReconciliationEvent(forged).ok, false, "forged event fails identity gate");
  assert.throws(() => a.applyReconciliation(forged), /rejected/, "tampered event must not apply");
  assert.equal(a.state().x, "2", "state untouched by rejected event (pre-event fold is a's own branch write)");
  // unknown parent: partial knowledge is not applicable
  const ghost = new Replica("g", "s");
  const G = ghost.set("x", "9", { ts: 999 });
  const evtGhost = makeReconciliationEvent({ parents: [A.id, G.id], assertedTree: { x: "3" }, author: "r", ts: 1003 });
  assert.throws(() => a.applyReconciliation(evtGhost), /parent .* unknown/, "unknown parent refuses");
  assert.equal(a.state().x, "2");
  // signed sheets refuse unsigned rec-diffs rather than silently absorbing them
  // (RFC P8 §6 Q2). Build a REAL two-head signed history so the parents-known
  // gate passes and the SIGNED gate is the one that fires.
  const kp = generateKeypair();
  const sb = new Replica("sb", "s", { schema: { signed: true } });
  sb.set("x", "base", { privateKey: kp.privateKey, ts: 900 });
  const s1 = new Replica("s1", "s", { schema: { signed: true } });
  const s2 = new Replica("s2", "s", { schema: { signed: true } });
  for (const d of sb.diffs.values()) { s1.receive(d); s2.receive(d); }
  s1.set("x", "sa", { privateKey: kp.privateKey, ts: 1001 });
  s2.set("x", "sb", { privateKey: kp.privateKey, ts: 1001 });
  s1.diffs.forEach((d) => s2.receive(d)); // s2 now holds BOTH branch heads
  const evtS = makeReconciliationEvent({ parents: [...s2.heads], assertedTree: { x: "3" }, author: kp.did, ts: 1002 });
  assert.throws(() => s2.applyReconciliation(evtS), /signed/, "signed sheet fails closed (RFC P8 §6 Q2)");
});

test("R5 property: seeded random histories with criss-cross merges replay to the asserted tree (50 iterations)", () => {
  let seed = 0x5eed;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let iter = 0; iter < 50; iter++) {
    const cells = ["c0", "c1", "c2"];
    const base = new Replica("base", "s");
    for (const c of cells) base.set(c, `${c}-base-${iter}`, { ts: 1000 });
    const a = new Replica("a", "s"), b = new Replica("b", "s");
    fork(base, a, b);
    // independent branch work: random sets/removes per side
    for (let i = 0; i < 3; i++) {
      const c = cells[Math.floor(rnd() * 3)];
      if (rnd() < 0.75) a.set(c, `A${i}-${c}`, { ts: 1001 + i });
      else a.remove(c, { ts: 1001 + i });
      const c2 = cells[Math.floor(rnd() * 3)];
      if (rnd() < 0.75) b.set(c2, `B${i}-${c2}`, { ts: 1001 + i });
      else b.remove(c2, { ts: 1001 + i });
    }
    b.diffs.forEach((d) => a.receive(d)); // merge -> a's heads span both sides
    // resolver's asserted tree: for each cell, a random side value, a NOVEL value, or ABSENT
    const asserted = {};
    for (const c of cells) {
      const roll = rnd();
      if (roll < 0.3) asserted[c] = `novel-${iter}-${c}`;             // criss-cross content
      else if (roll < 0.45) asserted[c] = ABSENT;                      // asserted deletion
      else if (roll < 0.7) { const t = a.treeAt([...a.heads][0]); if (t && c in t) asserted[c] = t[c]; }
      // else: key omitted — unchecked (delta semantics)
    }
    if (Object.keys(asserted).length === 0) continue;
    const evt = makeReconciliationEvent({ parents: [...a.heads], assertedTree: asserted, author: "r", ts: 2000 });
    // sync a's PRE-EVENT work into b so both sides know the parents (DAG gate)
    for (const d of a.diffs.values()) if (!b.diffs.has(d.id) && !d.cell.startsWith("_")) b.receive(d);
    a.applyReconciliation(evt);
    // oracle: every asserted key holds exactly the asserted value; absent keys are gone
    for (const [c, v] of Object.entries(asserted)) {
      if (v === ABSENT) assert.ok(!(c in a.state()), `iter ${iter}: ${c} asserted absent`);
      else assert.equal(a.state()[c], v, `iter ${iter}: ${c} asserted value`);
    }
    // both-sides convergence: b applies the same event and agrees on all asserted cells
    b.applyReconciliation(evt);
    for (const [c, v] of Object.entries(asserted)) {
      if (v === ABSENT) assert.ok(!(c in b.state()));
      else assert.equal(b.state()[c], v);
    }
  }
});
