// epsilon.test.mjs — P7 (epsilon-diff) suite. Failure conditions are stated per test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Replica, merge } from "../src/replica.mjs";

const SCHEMA = { numeric: ["w:*", "s"] };

test("E1: delta <= epsilon emits NO diff and seals a skip-eps receipt; delta > epsilon emits", () => {
  const r = new Replica("r", "s", { numeric: SCHEMA.numeric, epsilon: 0.01 });
  r.set("s", 0.5, { author: "r", ts: 1 });
  const n0 = r.diffCount();
  const skipped = r.set("s", 0.505, { author: "r", ts: 2 }); // |0.005| <= 0.01
  const emitted = r.set("s", 0.6, { author: "r", ts: 3 });   // |0.095| > 0.01
  // failure means: a skip emitted a diff, an emit was skipped, or the skip was silent
  assert.equal(skipped, null);
  assert.ok(emitted, "emit returns the diff");
  assert.equal(r.diffCount(), n0 + 1);
  const skips = r.receipts.filter((x) => x.kind === "skip-eps");
  assert.equal(skips.length, 1);
  assert.equal(r.verifyReceipts(), true); // the skip is sealed (payload hashed by design)
  assert.equal(r.state().s, 0.6); // state holds the last EMITTED value
});

test("E2: the P7 bounded-error invariant — |merged_eps - merged_exact| <= epsilon per element", () => {
  // 3 replicas write drifting numeric cells across 5 rounds; exact (eps=0) vs eps run
  const CELLS = ["w:0", "w:1", "s"];
  const mk = (eps) => {
    const reps = ["a", "b", "c"].map((name) => new Replica(name, "s", { numeric: SCHEMA.numeric, epsilon: eps }));
    reps.forEach((r) => CELLS.forEach((c, i) => r.set(c, 0.1 * i + 0.5, { author: r.name, ts: 100 })));
    return reps;
  };
  const exact = mk(0);
  const approx = mk(0.05);
  // seeded drift schedule: per round, per replica, per cell — small deltas
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let t = 0; t < 5; t++) {
    for (const [ri, r] of exact.entries()) {
      for (const [ci, c] of CELLS.entries()) {
        const d = (rnd() - 0.5) * 0.2; // up to 0.1 — sometimes skips, sometimes emits
        r.set(c, r.state()[c] + d, { author: r.name, ts: 200 + t * 10 + ri });
        approx[ri].set(c, exact[ri].state()[c] === undefined ? undefined : approx[ri].state()[c] + d, { author: approx[ri].name, ts: 200 + t * 10 + ri });
      }
    }
  }
  const mergeAll = (reps) => {
    const coord = new Replica("coord", "s", { numeric: SCHEMA.numeric });
    reps.forEach((r) => merge(r, coord));
    return coord.state();
  };
  const sExact = mergeAll(exact);
  const sApprox = mergeAll(approx);
  for (const c of CELLS) {
    const d = Math.abs(sExact[c] - sApprox[c]);
    // failure means: the bounded-approximation guarantee is violated
    assert.ok(d <= 0.05 + 1e-12, `cell ${c}: |exact - approx| = ${d} > epsilon`);
  }
});

test("E3: merge-order independence holds with skips in play (all 6 orders of 3 replicas)", () => {
  const reps = ["a", "b", "c"].map((name) => new Replica(name, "s", { numeric: SCHEMA.numeric, epsilon: 0.1 }));
  for (const [i, r] of reps.entries()) {
    r.set("s", 0.5, { author: r.name, ts: 100 + i });
    r.set("s", 0.5 + 0.05, { author: r.name, ts: 110 + i }); // skipped (0.05 <= 0.1)
    r.set("s", 0.5 + 0.05 + 0.3, { author: r.name, ts: 120 + i }); // emitted
  }
  const perms = (arr) => (arr.length <= 1 ? [arr] : arr.flatMap((x, i) => perms([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p])));
  const revisions = new Set();
  const states = new Set();
  for (const perm of perms([0, 1, 2])) {
    const coord = new Replica("c", "s", { numeric: SCHEMA.numeric });
    perm.forEach((k) => merge(reps[k], coord));
    revisions.add(coord.revision());
    states.add(JSON.stringify(coord.state().s));
  }
  // failure means: skip decisions made the DAG merge order-dependent
  assert.equal(revisions.size, 1);
  assert.equal(states.size, 1);
});

test("E4: P5 x P7 — contributors are the EMITTING replicas only; mean is over emitted", () => {
  const a = new Replica("a", "s", { numeric: SCHEMA.numeric, epsilon: 0.1 });
  const b = new Replica("b", "s", { numeric: SCHEMA.numeric, epsilon: 0.1 });
  a.set("s", 0.4, { author: "a", ts: 1 });
  a.set("s", 0.44, { author: "a", ts: 2 }); // skipped
  b.set("s", 0.8, { author: "b", ts: 3 });  // emitted
  const coord = new Replica("c", "s", { numeric: SCHEMA.numeric });
  merge(a, coord); merge(b, coord);
  // failure means: a skipped write contributed to, or the mean ran over, non-emitted values
  assert.equal(coord.state().s, (0.4 + 0.8) / 2); // a contributes 0.4 (its last EMITTED), b 0.8
  assert.equal(coord.diffCount(), 2);
});

test("E5: epsilon=0 / undefined is exact v0.3.0 behavior — no skip receipts, every set emits", () => {
  const r = new Replica("r", "s", { numeric: SCHEMA.numeric });
  r.set("s", 0.5, { author: "r", ts: 1 });
  r.set("s", 0.5000001, { author: "r", ts: 2 }); // tiny but non-zero delta: must emit
  // failure means: exact mode skipped or receipted a skip
  assert.equal(r.diffCount(), 2);
  assert.equal(r.receipts.filter((x) => x.kind === "skip-eps").length, 0);
  const z = new Replica("z", "s", { numeric: SCHEMA.numeric, epsilon: 0 });
  z.set("s", 0.5, { author: "z", ts: 1 });
  z.set("s", 0.5, { author: "z", ts: 2 }); // identical value still emits (exact mode)
  assert.equal(z.diffCount(), 2);
});

test("E6: array cells are element-wise — one element over epsilon forces the emit", () => {
  const r = new Replica("r", "s", { numeric: SCHEMA.numeric, epsilon: 0.01 });
  r.set("w:0", [0.1, 0.2, 0.3], { author: "r", ts: 1 });
  const skipped = r.set("w:0", [0.105, 0.2, 0.3], { author: "r", ts: 2 });
  const emitted = r.set("w:0", [0.105, 0.2, 0.4], { author: "r", ts: 3 });
  // failure means: element-wise semantics broken (array skipped or fully-vs-partially emitted confusion)
  assert.equal(skipped, null);
  assert.ok(emitted);
  assert.deepEqual(r.state()["w:0"], [0.105, 0.2, 0.4]);
});

test("E7: shape/type-incompatible writes always emit (null delta never skips)", () => {
  const r = new Replica("r", "s", { numeric: SCHEMA.numeric, epsilon: 100 });
  r.set("s", 0.5, { author: "r", ts: 1 });
  const arr = r.set("s", [1, 2], { author: "r", ts: 2 }); // number -> array: emit despite huge eps
  // failure means: an incompatible write was silently skipped
  assert.ok(arr);
  assert.deepEqual(r.state().s, [1, 2]);
});

test("NC6: no silent drops — every below-epsilon write has exactly one skip-eps receipt", () => {
  const r = new Replica("r", "s", { numeric: SCHEMA.numeric, epsilon: 0.02 });
  let writes = 0, emits = 0;
  r.set("s", 0.5, { author: "r", ts: 1 }); writes++; emits++;
  for (let t = 2; t <= 20; t++) {
    writes++;
    const v = 0.5 + (t % 3) * 0.005; // always within 0.01 of 0.5 -> skip
    if (r.set("s", v, { author: "r", ts: t }) !== null) emits++;
  }
  const skips = r.receipts.filter((x) => x.kind === "skip-eps").length;
  // failure means: writes - emits != receipts of skips (a drop went unsealed)
  assert.equal(writes - emits, skips);
  assert.equal(skips, 19);
  assert.equal(r.verifyReceipts(), true);
});
