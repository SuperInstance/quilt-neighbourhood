// train_replicas.mjs — the v0.2.0 multi-replica training experiment.
//
// CLAIM UNDER TEST: 4 neural replicas whose weight updates live as content-addressed
// CellDiffs in a diff DAG merge to ONE deterministic state — byte-identical in all
// 24 merge orders — and that state is the canonical mean of the replicas' weights,
// bit-for-bit, against an independent reference (reference_mean.mjs).
//
// Setup: synthetic regression y = f(x), 48 seeded points (seed 20260930). A tiny
// 1-6-6-1 MLP (tanh/tanh/linear) with manual backprop, no dependencies, no GPU.
// A genesis replica commits the shared INIT weights as numeric cells BEFORE training;
// 4 replicas with differing init seeds train N=300 full-batch steps on the SAME data
// and serialize their final weight MATRIX PER-ROW (bias per-unit) as numeric cells of
// sheet "mlp0" — cells "W0:row:k" (arrays), "b0:k" (scalars), "W1:row:j", "b1:j",
// "W2:row:0", "b2:0". Replica k emits CellDiffs only for cells whose weights changed
// beyond epsilon=0 (i.e. all of them), with parents = the diffs it has seen (the
// genesis diff-set) — so the 4 post-training sets per cell are concurrent siblings.
//
// Run: node experiment/train_replicas.mjs
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Replica, merge } from "../src/replica.mjs";
import { canonicalize, sha256, numericValueHex } from "../src/canonical.mjs";
import { referenceMean, valueHex } from "./reference_mean.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_SEED = 20260930;
const GENESIS_SEED = 20260930; // fleet baseline init committed to the sheet pre-training
const REPLICA_SEEDS = { r1: 11, r2: 22, r3: 33, r4: 44 };
const STEPS = 300;
const EPSILON = 0;
const LR = 0.08;
const H0 = 6, H1 = 6; // hidden sizes
const N_POINTS = 48;
const SCHEMA = ["W0:*", "b0:*", "W1:*", "b1:*", "W2:*", "b2:*"];

const startedISO = new Date().toISOString();

// ---------- deterministic PRNG (mulberry32) ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- data ----------
function f(x) { return 0.7 * Math.sin(2.5 * x) + 0.3 * x * x * x; }
const rndData = mulberry32(DATA_SEED);
const data = Array.from({ length: N_POINTS }, () => {
  const x = rndData() * 2 - 1;
  return { x, t: f(x) };
});

// ---------- the tiny MLP (manual backprop, full-batch SGD) ----------
class MLP {
  constructor(seed) {
    const rnd = mulberry32(seed);
    const u = () => (rnd() * 2 - 1) * 0.5;
    this.W0 = Array.from({ length: H0 }, () => [u()]);
    this.b0 = Array.from({ length: H0 }, u);
    this.W1 = Array.from({ length: H1 }, () => Array.from({ length: H0 }, u));
    this.b1 = Array.from({ length: H1 }, u);
    this.W2 = [Array.from({ length: H1 }, u)];
    this.b2 = [u()];
  }
  forward(x) {
    const a0 = this.W0.map((row, k) => Math.tanh(row[0] * x + this.b0[k]));
    const a1 = this.W1.map((row, j) => {
      let s = this.b1[j];
      for (let k = 0; k < H0; k++) s += row[k] * a0[k];
      return Math.tanh(s);
    });
    let y = this.b2[0];
    for (let j = 0; j < H1; j++) y += this.W2[0][j] * a1[j];
    return { y, a0, a1 };
  }
  predict(x) { return this.forward(x).y; }
  loss(set) {
    let s = 0;
    for (const { x, t } of set) { const d = this.predict(x) - t; s += d * d; }
    return s / set.length;
  }
  trainStep(set, lr) {
    const gW0 = Array.from({ length: H0 }, () => [0]);
    const gb0 = new Array(H0).fill(0);
    const gW1 = Array.from({ length: H1 }, () => new Array(H0).fill(0));
    const gb1 = new Array(H1).fill(0);
    const gW2 = [new Array(H1).fill(0)];
    const gb2 = [0];
    for (const { x, t } of set) {
      const { y, a0, a1 } = this.forward(x);
      const dy = 2 * (y - t) / set.length;
      for (let j = 0; j < H1; j++) gW2[0][j] += dy * a1[j];
      gb2[0] += dy;
      const dh1 = new Array(H1);
      const da0 = new Array(H0).fill(0);
      for (let j = 0; j < H1; j++) {
        dh1[j] = this.W2[0][j] * dy * (1 - a1[j] * a1[j]);
        for (let k = 0; k < H0; k++) { gW1[j][k] += dh1[j] * a0[k]; da0[k] += this.W1[j][k] * dh1[j]; }
        gb1[j] += dh1[j];
      }
      for (let k = 0; k < H0; k++) {
        const dh0 = da0[k] * (1 - a0[k] * a0[k]);
        gW0[k][0] += dh0 * x;
        gb0[k] += dh0;
      }
    }
    for (let k = 0; k < H0; k++) { this.W0[k][0] -= lr * gW0[k][0]; this.b0[k] -= lr * gb0[k]; }
    for (let j = 0; j < H1; j++) { for (let k = 0; k < H0; k++) this.W1[j][k] -= lr * gW1[j][k]; this.b1[j] -= lr * gb1[j]; }
    for (let j = 0; j < H1; j++) this.W2[0][j] -= lr * gW2[0][j];
    this.b2[0] -= lr * gb2[0];
    return this.loss(set);
  }
  train(set, steps, lr) {
    let loss = this.loss(set);
    for (let s = 0; s < steps; s++) loss = this.trainStep(set, lr);
    return loss;
  }
}

// ---------- cell <-> weight mapping ----------
const CELLS = [
  ...Array.from({ length: H0 }, (_, k) => `W0:row:${k}`),
  ...Array.from({ length: H0 }, (_, k) => `b0:${k}`),
  ...Array.from({ length: H1 }, (_, j) => `W1:row:${j}`),
  ...Array.from({ length: H1 }, (_, j) => `b1:${j}`),
  "W2:row:0",
  "b2:0",
];
function getCell(m, cell) {
  const parts = cell.split(":");
  const name = parts[0];
  const i = Number(parts[parts.length - 1]);
  if (name === "W0") return [m.W0[i][0]];
  if (name === "b0") return m.b0[i];
  if (name === "W1") return [...m.W1[i]];
  if (name === "b1") return m.b1[i];
  if (name === "W2") return [...m.W2[0]];
  if (name === "b2") return m.b2[0];
  throw new Error(`unknown cell ${cell}`);
}
function setCell(m, cell, v) {
  const parts = cell.split(":");
  const name = parts[0];
  const i = Number(parts[parts.length - 1]);
  if (name === "W0") m.W0[i][0] = v[0];
  else if (name === "b0") m.b0[i] = v;
  else if (name === "W1") m.W1[i] = [...v];
  else if (name === "b1") m.b1[i] = v;
  else if (name === "W2") m.W2[0] = [...v];
  else if (name === "b2") m.b2[0] = v;
  else throw new Error(`unknown cell ${cell}`);
}
function changed(a, b, eps) {
  if (typeof a === "number") return Math.abs(a - b) > eps;
  return a.some((v, i) => Math.abs(v - b[i]) > eps);
}
function modelFromCells(state) {
  const m = new MLP(0); // shape donor; values overwritten below
  for (const cell of CELLS) setCell(m, cell, state[cell]);
  return m;
}

// ---------- 1. genesis: the shared INIT weights, committed BEFORE training ----------
const genesis = new Replica("genesis", "mlp0", { numeric: SCHEMA });
const baseModel = new MLP(GENESIS_SEED);
const genesisBaseline = {};
CELLS.forEach((cell, i) => {
  const v = getCell(baseModel, cell);
  genesisBaseline[cell] = v;
  genesis.set(cell, v, { author: "genesis", ts: 1000 + i });
});
const genesisLoss = baseModel.loss(data);

// ---------- 2. four replicas train, then serialize weights as numeric cells ----------
const replicas = Object.entries(REPLICA_SEEDS).map(([name, seed], k) => {
  const rep = new Replica(name, "mlp0", { numeric: SCHEMA });
  merge(genesis, rep); // the replica has seen the shared genesis diff-set
  const model = new MLP(seed); // LOCAL init — the initialization variance source
  const initSnap = CELLS.map((c) => getCell(model, c));
  const finalLoss = model.train(data, STEPS, LR);
  let emitted = 0;
  CELLS.forEach((cell, i) => {
    const v = getCell(model, cell);
    if (changed(initSnap[i], v, EPSILON)) {
      rep.set(cell, v, { author: name, ts: 2000 + k * 1000 + i }); // fixed ts => deterministic ids
      emitted++;
    }
  });
  return { name, seed, rep, finalLoss, emitted, model };
});

// ---------- 3. merge all 4 diff-sets in ALL 24 orders ----------
function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}
const orders = permutations([0, 1, 2, 3]);
const runs = orders.map((perm, idx) => {
  const coord = new Replica(`coord-${idx}`, "mlp0", { numeric: SCHEMA });
  merge(genesis, coord);
  for (const k of perm) merge(replicas[k].rep, coord);
  const state = coord.state();
  return {
    perm,
    state,
    canonical: canonicalize(state),
    hex: CELLS.map((c) => `${c}=${numericValueHex(state[c])}`).join("|"),
    revision: coord.revision(),
    diffCount: coord.diffCount(),
    receiptsOk: coord.verifyReceipts(),
  };
});

// ---------- 4. assertions ----------
const fail = (msg) => { throw new Error(`EXPERIMENT FAILED: ${msg}`); };
const uniqCanonical = new Set(runs.map((r) => r.canonical));
if (uniqCanonical.size !== 1) fail(`state bytes diverged across merge orders: ${uniqCanonical.size} distinct`);
const uniqHex = new Set(runs.map((r) => r.hex));
if (uniqHex.size !== 1) fail(`float64 bit patterns diverged across merge orders: ${uniqHex.size} distinct`);
const uniqRev = new Set(runs.map((r) => r.revision));
if (uniqRev.size !== 1) fail(`revisions diverged across merge orders: ${uniqRev.size} distinct`);
if (!runs.every((r) => r.diffCount === 26 + 4 * 26)) fail(`knowledge diverged: diffCounts ${runs.map((r) => r.diffCount)}`);
if (!runs.every((r) => r.receiptsOk)) fail("a coordinator receipt chain failed verifyReceipts()");

// (b) merged weights == independent reference canonical mean, BYTE-for-BYTE
const allDiffs = [
  ...genesis.diffs.values(),
  ...replicas.flatMap((r) => [...r.rep.diffs.values()]),
];
const ref = referenceMean(allDiffs); // throws if live classes are not pairwise concurrent
const merged = runs[0].state;
const parity = CELLS.map((c) => {
  const a = numericValueHex(merged[c]);
  const b = valueHex(ref.state[c]);
  if (a !== b) fail(`byte parity broken on ${c}: merged ${a} vs reference ${b}`);
  // cross-examine the two hex encoders against each other as well
  return c;
});
if (parity.length !== CELLS.length) fail("reference parity did not cover every cell");
// contributor provenance: every cell's live class must be exactly the 4 replica sets
for (const cell of CELLS) {
  if (ref.contributors[cell].length !== 4) fail(`cell ${cell}: reference found ${ref.contributors[cell].length} live contributors, expected 4`);
  const authors = ref.contributors[cell].map((id) => allDiffs.find((d) => d.id === id).author);
  if (new Set(authors).size !== 4) fail(`cell ${cell}: contributors are not one per replica: ${authors}`);
}

// ---------- 5. losses ----------
const mergedModel = modelFromCells(merged);
const mergedLoss = mergedModel.loss(data);
const perReplica = Object.fromEntries(replicas.map((r) => [r.name, r.finalLoss]));
const meanOfLosses = replicas.reduce((s, r) => s + r.finalLoss, 0) / replicas.length;

// ---------- 6. suite counts (run-verified, not asserted) ----------
const t = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test/convergence.test.mjs", "test/numeric.test.mjs"], {
  cwd: ROOT, encoding: "utf8", timeout: 120000,
});
const tap = t.stdout ?? "";
const count = (re) => { const m = tap.match(re); return m ? Number(m[1]) : null; };
const testCounts = {
  command: "node --test --test-reporter=tap test/convergence.test.mjs test/numeric.test.mjs",
  tests: count(/# tests (\d+)/),
  pass: count(/# pass (\d+)/),
  fail: count(/# fail (\d+)/),
  exitCode: t.status,
};

// ---------- 7. receipt ----------
const finishedISO = new Date().toISOString();
const receipt = {
  experiment: "quilt-neighbourhood v0.2.0 multi-replica training convergence",
  claims: {
    a: "merged state byte-identical (canonical JSON + float64 bit hex) across all 24 merge orders",
    b: "merged weights == independent reference canonical mean, byte-for-byte on every cell",
    c: "revision equal across all 24 orders",
  },
  seeds: { data: DATA_SEED, genesisInit: GENESIS_SEED, replicas: REPLICA_SEEDS },
  steps: STEPS,
  epsilon: EPSILON,
  learningRate: LR,
  architecture: `mlp ${1}-${H0}-${H1}-${1}, tanh/tanh/linear, manual full-batch backprop`,
  data: { points: N_POINTS, target: "0.7*sin(2.5x) + 0.3*x^3", xDomain: "[-1,1]" },
  sheet: "mlp0",
  numericCells: CELLS.length,
  diffs: { genesis: CELLS.length, perReplica: CELLS.length, total: CELLS.length * 5 },
  genesisBaselineLoss: genesisLoss,
  perReplicaFinalLoss: perReplica,
  meanOfPerReplicaLosses: meanOfLosses,
  mergedLoss,
  mergedVsMeanOfLosses: mergedLoss - meanOfLosses,
  mergeOrders: {
    tested: orders.length,
    distinctStateBytes: uniqCanonical.size,
    distinctFloat64Bits: uniqHex.size,
    distinctRevisions: uniqRev.size,
    revision: [...uniqRev][0],
    stateSha256: sha256(runs[0].canonical),
    orders: orders.map((p, i) => ({ order: p, revision: runs[i].revision })),
  },
  referenceParity: { cellsChecked: CELLS.length, mismatches: 0, contributorsPerCell: 4 },
  coordinatorReceiptChainsVerified: runs.every((r) => r.receiptsOk),
  tests: testCounts,
  node: process.version,
  timestamps: { started: startedISO, finished: finishedISO },
};
mkdirSync(path.join(ROOT, "receipts"), { recursive: true });
writeFileSync(path.join(ROOT, "receipts", "experiment-v0.2.0.json"), JSON.stringify(receipt, null, 2) + "\n");

console.log(JSON.stringify({
  perReplicaFinalLoss: perReplica,
  genesisBaselineLoss: genesisLoss,
  mergedLoss,
  meanOfLosses,
  orders: orders.length,
  distinctStateBytes: uniqCanonical.size,
  distinctRevisions: uniqRev.size,
  revision: [...uniqRev][0],
  tests: testCounts,
  node: process.version,
}, null, 2));
console.log("receipt written: receipts/experiment-v0.2.0.json");
