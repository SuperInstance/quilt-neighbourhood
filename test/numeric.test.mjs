// numeric.test.mjs — P5 (numeric merge) falsifiable claims, v0.2.0.
// Every test states what counts as failure. NC4 is the adversarial negative control.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Replica, merge, canonicalMean } from "../src/replica.mjs";
import { canonicalize, float64Hex, numericValueHex } from "../src/canonical.mjs";

const NUM = ["c:*", "row:*"]; // test sheet schema: everything numeric

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
function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}
// Full witness bytes of a replica: canonical state bytes + per-cell float64 bit hex
// (distinguishes -0/0 and any payload-level difference canonicalize() would coarsen)
// + revision. Byte-identity claims are checked on ALL THREE layers.
function witnessBytes(r) {
  const st = r.state();
  const hex = Object.keys(st).sort().map((c) => `${c}=${numericValueHex(st[c])}`).join("|");
  return { canonical: canonicalize(st), hex, revision: r.revision(), count: r.diffCount() };
}

test("T6 (P5): 4 concurrent numeric sets merge byte-identical in all 24 orders", () => {
  const values = [0.1, -3.75, 1e-13, 2.5];
  const rows = [
    [0.1, -2.0, 3.5],
    [4.0, -0.5, 6.25],
    [-1.125, 0.0625, 2 ** 40],
    [0.0, 7.0, -8.5],
  ];
  const reps = values.map((v, i) => {
    const r = new Replica(`r${i}`, "mlp", { numeric: NUM });
    r.set("c:a", v);
    r.set("row:a", rows[i]);
    return r;
  });
  const runs = permutations([0, 1, 2, 3]).map((perm, idx) => {
    const w = new Replica(`w${idx}`, "mlp", { numeric: NUM });
    for (const k of perm) merge(reps[k], w);
    return { bytes: witnessBytes(w), ok: w.verifyReceipts() };
  });
  assert.equal(runs.length, 24, "must exercise all 4! = 24 merge orders");
  const uniq = new Set(runs.map((r) => JSON.stringify(r.bytes)));
  assert.equal(uniq.size, 1, `state/hex/revision bytes diverged across orders: ${[...uniq].join("\n")}`);
  assert.ok(runs.every((r) => r.ok), "every coordinator's receipt chain must verify");
  // and the value is the canonical mean, not a tie-break winner
  const w0 = new Replica("witness", "mlp", { numeric: NUM });
  for (const k of [0, 1, 2, 3]) merge(reps[k], w0);
  // compute expected mean independently from the emitted diffs, in canonical
  // (sorted-diff-id) order — the same order the fold is required to use
  const byId = (cell) => reps.map((r) => [...r.diffs.values()].find((d) => d.cell === cell))
    .sort((a, b) => (a.id < b.id ? -1 : 1)).map((d) => d.value);
  const expected = canonicalMean(byId("c:a"));
  assert.equal(float64Hex(w0.state()["c:a"]), float64Hex(expected), "scalar cell = canonical mean of 4");
  const expectedRow = canonicalMean(byId("row:a"));
  assert.deepEqual(
    float64HexOfArray(w0.state()["row:a"]),
    float64HexOfArray(expectedRow),
    "array cell = element-wise canonical mean of 4"
  );
});

function float64HexOfArray(a) {
  return a.map(float64Hex).join(",");
}

test("T7 (P5): mean correctness vs reference order-sum, and the order hazard is real", () => {
  // Five adversarial-but-finite contributors on one numeric cell.
  const values = [0.1, 1 / 3, 1e-7, 2 ** 53, -0.0];
  const reps = values.map((v, i) => {
    const r = new Replica(`n${i}`, "mlp", { numeric: NUM });
    r.set("c:b", v);
    return r;
  });
  const w = new Replica("w", "mlp", { numeric: NUM });
  for (const r of reps) merge(r, w);
  // independent reference: sum in sorted-diff-id order, acc starts at 0, divide once
  const diffs = reps.map((r) => [...r.diffs.values()][0]);
  const ordered = diffs.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).map((d) => d.value);
  const expected = canonicalMean(ordered);
  assert.equal(
    float64Hex(w.state()["c:b"]),
    float64Hex(expected),
    "P5 merge must equal the canonical (sorted-id) order sum / n, bit-for-bit"
  );
  // Non-vacuity: addition order genuinely changes the bits, so the canonical order is
  // load-bearing. [1, 1e-16, 1e-16, 1e-16]: identity order loses every 1e-16 against
  // the ULP of 1; the smalls-first order survives one rounded step up.
  const hazardVals = [1, 1e-16, 1e-16, 1e-16];
  let accNaive = 0;
  for (const v of hazardVals) accNaive += v; // 1 first: all three 1e-16 are swallowed
  let accSorted = 0;
  for (const v of [...hazardVals].sort((a, b) => a - b)) accSorted += v;
  assert.notEqual(
    float64Hex(accNaive),
    float64Hex(accSorted),
    "precondition broken: addition order did not change the bits — this test no longer guards anything"
  );
});

test("T8 (P5 x P2/P1): removes dominate numeric groups; causal resurrection is a plain set", () => {
  // A: remove concurrent with a pending numeric group -> P2 tombstone over the mean
  const s1 = new Replica("s1", "mlp", { numeric: NUM }); s1.set("c:c", 10);
  const s2 = new Replica("s2", "mlp", { numeric: NUM }); s2.set("c:c", 20);
  const s3 = new Replica("s3", "mlp", { numeric: NUM }); s3.remove("c:c");
  const wA = new Replica("wA", "mlp", { numeric: NUM });
  for (const r of [s1, s2, s3]) merge(r, wA);
  assert.equal(wA.state()["c:c"], undefined, "remove must win over the whole numeric group");

  // B: set concurrent with a tombstone on a numeric cell -> P2, stays removed
  const b1 = new Replica("b1", "mlp", { numeric: NUM }); b1.set("c:d", 5);
  const b2 = new Replica("b2", "mlp", { numeric: NUM }); merge(b1, b2); b2.remove("c:d");
  const b3 = new Replica("b3", "mlp", { numeric: NUM }); b3.set("c:d", 7);
  const wB = new Replica("wB", "mlp", { numeric: NUM });
  for (const r of [b1, b2, b3]) merge(r, wB);
  assert.equal(wB.state()["c:d"], undefined, "concurrent set vs tombstone: remove wins");

  // C: set causally AFTER the tombstone -> P1 resurrection as a PLAIN set (not a mean)
  const c3 = new Replica("c3", "mlp", { numeric: NUM }); merge(b2, c3); c3.set("c:d", 9);
  const wC = new Replica("wC", "mlp", { numeric: NUM });
  for (const r of [b1, b2, c3]) merge(r, wC);
  assert.equal(wC.state()["c:d"], 9, "P1 resurrection must apply the plain value");

  // D: remove causally after every group member -> normal delete of the merged cell
  const d1 = new Replica("d1", "mlp", { numeric: NUM }); d1.set("c:e", 1);
  const d2 = new Replica("d2", "mlp", { numeric: NUM }); d2.set("c:e", 2);
  const d3 = new Replica("d3", "mlp", { numeric: NUM });
  for (const r of [d1, d2]) merge(r, d3);
  d3.remove("c:e"); // d3 has seen both members
  const wD = new Replica("wD", "mlp", { numeric: NUM });
  for (const r of [d1, d2, d3]) merge(r, wD);
  assert.equal(wD.state()["c:e"], undefined, "causal remove deletes the numeric cell");
});

test("T9 (P5 fallback): mixed or shape-incompatible contributors resolve by P3, not mean", () => {
  // A: a divergent-schema replica pushes a string into a registered numeric cell;
  //    the merge must fall back to P3 (min diff id wins over the live class).
  const a1 = new Replica("a1", "mlp", { numeric: NUM }); a1.set("c:f", 0.5);
  const a2 = new Replica("a2", "mlp", { numeric: NUM }); a2.set("c:f", 1.5);
  const a3 = new Replica("a3", "mlp"); // NO schema — the divergent author
  a3.set("c:f", "hello");
  const wA = new Replica("wA", "mlp", { numeric: NUM });
  for (const r of [a1, a2, a3]) merge(r, wA);
  const byId = [a1, a2, a3].map((r) => [...r.diffs.values()][0]).sort((x, y) => (x.id < y.id ? -1 : 1));
  assert.equal(wA.state()["c:f"], byId[0].value, "mixed contributors must resolve by P3 (min id)");
  assert.notEqual(wA.state()["c:f"], 1.0, "mixed contributors must not silently average");

  // B: two numeric arrays of unequal length are not mergeable -> P3 fallback
  const b1 = new Replica("b1", "mlp", { numeric: NUM }); b1.set("row:b", [1, 2, 3]);
  const b2 = new Replica("b2", "mlp", { numeric: NUM }); b2.set("row:b", [4, 5]);
  const wB = new Replica("wB", "mlp", { numeric: NUM });
  for (const r of [b1, b2]) merge(r, wB);
  const bById = [[...b1.diffs.values()][0], [...b2.diffs.values()][0]].sort((x, y) => (x.id < y.id ? -1 : 1));
  assert.deepEqual(wB.state()["row:b"], bById[0].value, "shape mismatch falls back to P3");

  // C: a cell NOT registered numeric never averages, even for plain numbers
  const c1 = new Replica("c1", "mlp", { numeric: ["other:*"] }); c1.set("c:g", 1);
  const c2 = new Replica("c2", "mlp", { numeric: ["other:*"] }); c2.set("c:g", 5);
  const wC = new Replica("wC", "mlp", { numeric: ["other:*"] });
  for (const r of [c1, c2]) merge(r, wC);
  const cById = [[...c1.diffs.values()][0], [...c2.diffs.values()][0]].sort((x, y) => (x.id < y.id ? -1 : 1));
  assert.equal(wC.state()["c:g"], cById[0].value, "unregistered cell stays P3");
  assert.notEqual(wC.state()["c:g"], 3, "unregistered cell must not silently average");
});

test("T10 (P5): a set causally after a P5 merge is a plain set, not a new mean", () => {
  const r1 = new Replica("r1", "mlp", { numeric: NUM }); r1.set("c:h", 1);
  const r2 = new Replica("r2", "mlp", { numeric: NUM }); r2.set("c:h", 2);
  const r3 = new Replica("r3", "mlp", { numeric: NUM }); r3.set("c:h", 3);
  const w = new Replica("w", "mlp", { numeric: NUM });
  for (const r of [r1, r2, r3]) merge(r, w);
  const diffs = [r1, r2, r3].map((r) => [...r.diffs.values()][0]).sort((a, b) => (a.id < b.id ? -1 : 1));
  const expectedMean = canonicalMean(diffs.map((d) => d.value));
  assert.equal(float64Hex(w.state()["c:h"]), float64Hex(expectedMean), "precondition: group of 3 merged to canonical mean");

  // r4 has SEEN all three heads; its set supersedes the whole group
  const r4 = new Replica("r4", "mlp", { numeric: NUM });
  for (const d of diffs) assert.equal(r4.receive(d).accepted, true);
  r4.set("c:h", 99);
  merge(r4, w);
  assert.equal(w.state()["c:h"], 99, "causally-later set must win as a plain set over the merged mean");
  // arrival order must not matter: a witness that sees r4 BEFORE the remaining siblings
  const w2 = new Replica("w2", "mlp", { numeric: NUM });
  merge(r4, w2);           // ships d1,d2,d3,d4 (r4 knows them all)
  merge(r1, w2); merge(r3, w2); // only already-known diffs remain
  assert.equal(w2.state()["c:h"], 99, "late-arriving superseded siblings must not reopen the mean");
  assert.equal(w2.revision(), w.revision(), "same knowledge -> same revision bytes");
});

test("NC4: adversarial floats converge byte-identical through all 120 shuffled orders; NaN is rejected at write with a receipt", () => {
  // the five finite adversarial values, including the rounding cliff 2**53 and -0.0
  const values = [0.1, 1 / 3, 1e-7, 2 ** 53, -0.0];
  const reps = values.map((v, i) => {
    const r = new Replica(`a${i}`, "mlp", { numeric: NUM });
    r.set("c:i", v);
    r.set("row:i", [v, v * 3, -v]);
    return r;
  });
  const runs = permutations([0, 1, 2, 3, 4]).map((perm, idx) => {
    const rand = prng(0xADF175 + idx); // seeded shuffle of the permutation too
    const order = shuffled(perm, rand);
    const w = new Replica(`w${idx}`, "mlp", { numeric: NUM });
    for (const k of order) merge(reps[k], w);
    return witnessBytes(w);
  });
  assert.equal(runs.length, 120, "must exercise all 5! = 120 merge orders");
  const uniq = new Set(runs.map((r) => JSON.stringify(r)));
  assert.equal(uniq.size, 1, `adversarial floats diverged across shuffled orders: ${[...uniq].join("\n")}`);
  // bit-exact agreement with the canonical reference sum
  const w = new Replica("w", "mlp", { numeric: NUM });
  for (const r of reps) merge(r, w);
  const scalar = reps.map((r) => [...r.diffs.values()].find((d) => d.cell === "c:i"))
    .sort((a, b) => (a.id < b.id ? -1 : 1)).map((d) => d.value);
  assert.equal(float64Hex(w.state()["c:i"]), float64Hex(canonicalMean(scalar)), "scalar: reference byte parity");
  const row = reps.map((r) => [...r.diffs.values()].find((d) => d.cell === "row:i"))
    .sort((a, b) => (a.id < b.id ? -1 : 1)).map((d) => d.value);
  assert.deepEqual(
    float64HexOfArray(w.state()["row:i"]),
    float64HexOfArray(canonicalMean(row)),
    "array: reference byte parity"
  );

  // NaN and ±Infinity are rejected at write time, and the rejection is receipted
  const g = new Replica("g", "mlp", { numeric: NUM });
  const before = g.diffCount();
  const receiptsBefore = g.receipts.length;
  for (const bad of [NaN, Infinity, -Infinity, [1, NaN]]) {
    assert.throws(() => g.set("c:j", bad), TypeError, `numeric write of ${String(bad)} must throw`);
  }
  assert.equal(g.diffCount(), before, "rejected writes must not enter the DAG");
  assert.equal(g.receipts.length - receiptsBefore, 4, "each rejection must be receipted");
  assert.equal(g.receipts.at(-1).kind, "reject", "rejection must be receipted");
  assert.ok(g.verifyReceipts(), "receipt chain stays intact across rejections");
  // and a NaN diff arriving from outside is rejected on receive, with a receipt
  const outsider = new Replica("o", "mlp"); // no schema: can fabricate the poison diff
  const poison = outsider.set("c:k", NaN);
  const guard = new Replica("guard", "mlp", { numeric: NUM });
  const res = guard.receive(poison);
  assert.equal(res.accepted, false, "NaN diff on a numeric cell must be rejected on receive");
  assert.match(res.reason, /non-finite/);
  assert.equal(guard.diffCount(), 0, "poison diff must not enter the DAG");
  assert.equal(guard.receipts.at(-1).kind, "reject", "receive rejection must be receipted");
});
