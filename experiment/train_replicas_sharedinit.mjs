// train_replicas_sharedinit.mjs — v0.2.0 phase-2 POSITIVE CONTROL.
//
// Phase 1 (train_replicas.mjs) receipted an honest semantic FAIL: replicas with
// INDEPENDENT inits train to ~0.006-0.008 loss each, but their weight-mean has
// loss 0.361 — independently-initialized nets land in different loss basins
// (hidden-unit permutation symmetry), so element-wise averaging is meaningless
// across basins. The merge MACHINERY was byte-perfect; the AVERAGING SEMANTICS
// were not.
//
// Phase 2 tests the theory's prediction: replicas sharing ONE init (the genesis
// weights) and diverging ONLY through data order (mini-batch SGD, per-replica
// shuffle seeds) stay in the SAME basin — weight averaging should then be
// meaningful (merged loss in the neighborhood of the per-replica losses, and
// strictly better than every single replica is NOT claimed; the registered
// claim is merged <= worst replica * 1.5, an honest pre-registered bound).
//
// Run: node experiment/train_replicas_sharedinit.mjs
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Replica, merge } from "../src/replica.mjs";
import { canonicalize, sha256, numericValueHex } from "../src/canonical.mjs";
import { referenceMean, valueHex } from "./reference_mean.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_SEED = 20260930;
const GENESIS_SEED = 20260930;           // THE shared init — every replica starts here
const SHUFFLE_SEEDS = { r1: 11, r2: 22, r3: 33, r4: 44 };
const STEPS = 300;
const BATCH = 8;
const LR = 0.08;
const H0 = 6, H1 = 6;
const N_POINTS = 48;
const SCHEMA = ["W0:*", "b0:*", "W1:*", "b1:*", "W2:*", "b2:*"];
// Pre-registered semantic bound (before running): merged loss <= 1.5 x worst replica loss.
const MERGED_BOUND_FACTOR = 1.5;

const startedISO = new Date().toISOString();

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function f(x) { return 0.7 * Math.sin(2.5 * x) + 0.3 * x * x * x; }
const rndData = mulberry32(DATA_SEED);
const data = Array.from({ length: N_POINTS }, () => {
  const x = rndData() * 2 - 1;
  return { x, t: f(x) };
});

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
  trainBatched(set, steps, batch, lr, shuffleSeed) {
    // mini-batch SGD; per-replica shuffle seed = the ONLY divergence source
    const rnd = mulberry32(shuffleSeed);
    let loss = this.loss(set);
    for (let s = 0; s < steps; s++) {
      const idx = Array.from({ length: set.length }, (_, i) => i);
      for (let i = idx.length - 1; i > 0; i--) { // Fisher-Yates, seeded
        const j = Math.floor(rnd() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
      for (let b = 0; b < set.length; b += batch) {
        const slice = idx.slice(b, b + batch).map((i) => set[i]);
        this.trainStep(slice, lr);
      }
      loss = this.loss(set);
    }
    return loss;
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
}

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
  else if (name === "b1") m.b1[i] = v;
  else if (name === "W1") m.W1[i] = [...v];
  else if (name === "b2") m.b2[0] = v;
  else if (name === "W2") m.W2[0] = [...v];
  else throw new Error(`unknown cell ${cell}`);
}
function modelFromCells(state) {
  const m = new MLP(GENESIS_SEED); // same-basin donor: start from genesis shape+values
  for (const cell of CELLS) setCell(m, cell, state[cell]);
  return m;
}

// ---------- 1. genesis: shared init committed BEFORE training ----------
const genesis = new Replica("genesis", "mlp0", { numeric: SCHEMA });
const baseModel = new MLP(GENESIS_SEED);
CELLS.forEach((cell, i) => genesis.set(cell, getCell(baseModel, cell), { author: "genesis", ts: 1000 + i }));
const genesisLoss = baseModel.loss(data);

// ---------- 2. replicas: SAME init, different shuffle seeds (mini-batch SGD) ----------
const replicas = Object.entries(SHUFFLE_SEEDS).map(([name, seed], k) => {
  const rep = new Replica(name, "mlp0", { numeric: SCHEMA });
  merge(genesis, rep);
  const model = modelFromCells(genesis.state()); // start AT the genesis weights
  const initSnap = CELLS.map((c) => getCell(model, c));
  const finalLoss = model.trainBatched(data, STEPS, BATCH, LR, seed);
  let emitted = 0;
  CELLS.forEach((cell, i) => {
    const v = getCell(model, cell);
    const initV = initSnap[i];
    const isChanged = typeof v === "number" ? v !== initV : v.some((x, j) => x !== initV[j]);
    if (isChanged) {
      rep.set(cell, v, { author: name, ts: 2000 + k * 1000 + i });
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
    perm, state,
    canonical: canonicalize(state),
    hex: CELLS.map((c) => `${c}=${numericValueHex(state[c])}`).join("|"),
    revision: coord.revision(),
    diffCount: coord.diffCount(),
    receiptsOk: coord.verifyReceipts(),
  };
});

// ---------- 4. structural assertions (same as phase 1) ----------
const fail = (msg) => { throw new Error(`PHASE-2 FAILED: ${msg}`); };
const uniqCanonical = new Set(runs.map((r) => r.canonical));
if (uniqCanonical.size !== 1) fail(`state bytes diverged: ${uniqCanonical.size} distinct`);
const uniqHex = new Set(runs.map((r) => r.hex));
if (uniqHex.size !== 1) fail(`float64 bits diverged: ${uniqHex.size} distinct`);
const uniqRev = new Set(runs.map((r) => r.revision));
if (uniqRev.size !== 1) fail(`revisions diverged: ${uniqRev.size} distinct`);
if (!runs.every((r) => r.receiptsOk)) fail("receipt chain verification failed");

// reference parity
const allDiffs = [
  ...genesis.diffs.values(),
  ...replicas.flatMap((r) => [...r.rep.diffs.values()]),
];
const ref = referenceMean(allDiffs);
const merged = runs[0].state;
CELLS.forEach((c) => {
  if (numericValueHex(merged[c]) !== valueHex(ref.state[c])) fail(`byte parity broken on ${c}`);
});
for (const cell of CELLS) {
  if (ref.contributors[cell].length !== 4) fail(`cell ${cell}: ${ref.contributors[cell].length} contributors, expected 4`);
}

// ---------- 5. THE SEMANTIC CLAIM (pre-registered bound) ----------
const mergedModel = modelFromCells(merged);
const mergedLoss = mergedModel.loss(data);
const perReplica = Object.fromEntries(replicas.map((r) => [r.name, r.finalLoss]));
const worst = Math.max(...Object.values(perReplica));
const meanOfLosses = replicas.reduce((s, r) => s + r.finalLoss, 0) / replicas.length;
const bound = worst * MERGED_BOUND_FACTOR;
const semanticClaim = mergedLoss <= bound;

// ---------- 6. suite counts ----------
const t = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test/convergence.test.mjs", "test/numeric.test.mjs"], {
  cwd: ROOT, encoding: "utf8", timeout: 120000,
});
const tap = t.stdout ?? "";
const count = (re) => { const m = tap.match(re); return m ? Number(m[1]) : null; };

// ---------- 7. receipt ----------
const receipt = {
  experiment: "quilt-neighbourhood v0.2.0 phase-2 positive control: shared-basin replicas",
  theory: "weight averaging is meaningful ONLY within one loss basin — replicas sharing the genesis init and diverging only through data order",
  preRegisteredBound: { formula: "merged_loss <= worst_replica_loss * 1.5", factor: MERGED_BOUND_FACTOR },
  seeds: { data: DATA_SEED, sharedInit: GENESIS_SEED, shuffle: SHUFFLE_SEEDS },
  steps: STEPS, batchSize: BATCH, learningRate: LR,
  architecture: `mlp ${1}-${H0}-${H1}-${1}, tanh/tanh/linear, manual mini-batch SGD`,
  genesisBaselineLoss: genesisLoss,
  perReplicaFinalLoss: perReplica,
  worstReplicaLoss: worst,
  meanOfPerReplicaLosses: meanOfLosses,
  mergedLoss,
  bound,
  semanticClaim: semanticClaim ? "HELD" : "FAILED",
  mergeOrders: {
    tested: orders.length,
    distinctStateBytes: uniqCanonical.size,
    distinctFloat64Bits: uniqHex.size,
    distinctRevisions: uniqRev.size,
    revision: [...uniqRev][0],
    stateSha256: sha256(runs[0].canonical),
  },
  referenceParity: { cellsChecked: CELLS.length, mismatches: 0, contributorsPerCell: 4 },
  coordinatorReceiptChainsVerified: runs.every((r) => r.receiptsOk),
  tests: { tests: count(/# tests (\d+)/), pass: count(/# pass (\d+)/), fail: count(/# fail (\d+)/), exitCode: t.status },
  node: process.version,
  timestamps: { started: startedISO, finished: new Date().toISOString() },
};
mkdirSync(path.join(ROOT, "receipts"), { recursive: true });
writeFileSync(path.join(ROOT, "receipts", "experiment-v0.2.0-sharedinit.json"), JSON.stringify(receipt, null, 2) + "\n");

console.log(JSON.stringify({
  genesisBaselineLoss: receipt.genesisBaselineLoss,
  perReplicaFinalLoss: perReplica,
  mergedLoss,
  worstReplicaLoss: worst,
  meanOfLosses,
  bound,
  semanticClaim: receipt.semanticClaim,
  orders: orders.length,
  distinctStateBytes: uniqCanonical.size,
  distinctRevisions: uniqRev.size,
  tests: receipt.tests,
}, null, 2));
console.log("receipt written: receipts/experiment-v0.2.0-sharedinit.json");
