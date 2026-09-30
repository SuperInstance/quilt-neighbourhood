// train_replicas_eps.mjs — v0.4.0 P7 (epsilon-diff) experiment.
//
// CLAIM UNDER TEST: checkpoint-based federated averaging over the quilt DAG
// with P7 epsilon-diff emits a SPARSE diff stream while the merged model stays
// a BOUNDED approximation of the exact-communication merged model:
//   X1: |merged_eps - merged_exact| <= epsilon per element (the P7 invariant,
//       aggregated through the P5 canonical mean).
//   X2: the eps-merged model's loss is within a pre-registered band of the
//       exact-merged model's loss: |loss_eps - loss_exact| <= 0.01 (bound set
//       before running; both are shared-basin replicas per the v0.2.0 result).
//   X3: merge-order independence holds for the eps DAG (all 24 orders -> 1
//       revision, byte-identical state).
//   X4: every skipped write is receipted (writes - emits == skip-eps receipts).
//
// Setup: the v0.2.0 phase-2 protocol (shared genesis init seed 20260930, 4
// replicas diverging only through per-replica mini-batch shuffle seeds, batch 8,
// 300 steps, lr 0.08) extended with CHECKPOINTS every 50 steps: at each
// checkpoint every replica writes ALL 26 weight cells under its sheet's
// epsilon; between checkpoints replicas train locally. Exact twin (eps=0)
// runs the identical schedule.
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Replica, merge } from "../src/replica.mjs";
import { canonicalize, sha256, numericValueHex } from "../src/canonical.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_SEED = 20260930;
const GENESIS_SEED = 20260930;
const SHUFFLE_SEEDS = { r1: 11, r2: 22, r3: 33, r4: 44 };
const STEPS = 300;
const CHECKPOINT = 50; // 6 checkpoints (incl. step 300)
const BATCH = 8;
const LR = 0.08;
const EPSILON = 1e-4;
const H0 = 6, H1 = 6;
const N_POINTS = 48;
const SCHEMA = ["W0:*", "b0:*", "W1:*", "b1:*", "W2:*", "b2:*"];
const LOSS_BAND = 0.01; // pre-registered X2 band

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
    const rnd = mulberry32(shuffleSeed);
    let loss = this.loss(set);
    for (let s = 0; s < steps; s++) {
      const idx = Array.from({ length: set.length }, (_, i) => i);
      for (let i = idx.length - 1; i > 0; i--) {
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
  else if (name === "W1") m.W1[i] = [...v];
  else if (name === "b1") m.b1[i] = v;
  else if (name === "W2") m.W2[0] = [...v];
  else if (name === "b2") m.b2[0] = v;
  else throw new Error(`unknown cell ${cell}`);
}
function modelFromCells(state) {
  const m = new MLP(GENESIS_SEED);
  for (const cell of CELLS) setCell(m, cell, state[cell]);
  return m;
}

function runEpisode(epsilon) {
  // returns {reps, models, writes, emits, genesisLoss, perReplicaFinalLoss}
  const genesis = new Replica("genesis", "mlp0", { numeric: SCHEMA, epsilon });
  const baseModel = new MLP(GENESIS_SEED);
  CELLS.forEach((cell, i) => genesis.set(cell, getCell(baseModel, cell), { author: "genesis", ts: 1000 + i }));
  const genesisLoss = baseModel.loss(data);

  const reps = [], models = [];
  const entries = Object.entries(SHUFFLE_SEEDS);
  for (const [name, seed] of entries) {
    const rep = new Replica(name, "mlp0", { numeric: SCHEMA, epsilon });
    merge(genesis, rep);
    const model = new MLP(GENESIS_SEED);
    for (const cell of CELLS) setCell(model, cell, genesis.state()[cell]); // start AT genesis
    reps.push(rep); models.push([name, seed, model]);
  }

  let writes = 0, emits = 0;
  const perCheckpoint = [];
  for (let ck = 1; ck <= STEPS / CHECKPOINT; ck++) {
    for (const [name, seed, model] of models) {
      const r = reps.find((x) => x.name === name);
      void seed;
      for (let ci = 0; ci < CELLS.length; ci++) {
        writes++;
        const v = getCell(model, CELLS[ci]);
        const d = r.set(CELLS[ci], v, { author: name, ts: 2000 + ck * 1000 + ci });
        if (d !== null) emits++;
      }
    }
    perCheckpoint.push({ checkpoint: ck * CHECKPOINT, emitted: emits, potential: writes });
    if (ck < STEPS / CHECKPOINT) {
      for (const [, seed, model] of models) model.trainBatched(data, CHECKPOINT, BATCH, LR, seed * 1000 + ck);
    }
  }
  const perReplicaFinalLoss = Object.fromEntries(models.map(([name, , m]) => [name, m.loss(data)]));
  return { reps, models, writes, emits, genesisLoss, perReplicaFinalLoss, perCheckpoint };
}

// ---------- eps episode and exact twin ----------
const epsRun = runEpisode(EPSILON);
const exactRun = runEpisode(0);
const fail = (msg) => { throw new Error(`P7 EXPERIMENT FAILED: ${msg}`); };

// ---------- merge eps DAG in all 24 orders; exact in one ----------
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
const epsRuns = orders.map((perm) => {
  const coord = new Replica("coord", "mlp0", { numeric: SCHEMA });
  for (const k of perm) merge(epsRun.reps[k], coord);
  return coord;
});
const uniqRev = new Set(epsRuns.map((c) => c.revision()));
const uniqHex = new Set(epsRuns.map((c) => CELLS.map((cell) => `${cell}=${numericValueHex(c.state()[cell])}`).join("|")));
if (uniqRev.size !== 1) fail(`X3 revisions diverged: ${uniqRev.size}`);
if (uniqHex.size !== 1) fail(`X3 float bits diverged: ${uniqHex.size}`);

const mergedEps = epsRuns[0].state();
const exactCoord = new Replica("coordX", "mlp0", { numeric: SCHEMA });
for (const r of exactRun.reps) merge(r, exactCoord);
const mergedExact = exactCoord.state();

// ---------- X1: per-element bound ----------
let maxErr = 0, worstCell = null;
for (const cell of CELLS) {
  const a = mergedEps[cell], b = mergedExact[cell];
  const diff = typeof a === "number" ? Math.abs(a - b) : Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  if (diff > maxErr) { maxErr = diff; worstCell = cell; }
}
if (maxErr > EPSILON + 1e-15) fail(`X1 violated: max element error ${maxErr} > epsilon ${EPSILON} (cell ${worstCell})`);

// ---------- X2: loss band (pre-registered) ----------
const mergedLossEps = modelFromCells(mergedEps).loss(data);
const mergedLossExact = modelFromCells(mergedExact).loss(data);
if (Math.abs(mergedLossEps - mergedLossExact) > LOSS_BAND) fail(`X2 violated: |loss diff| ${Math.abs(mergedLossEps - mergedLossExact)} > band ${LOSS_BAND}`);

// ---------- X4: receipt accounting (eps replicas) ----------
let skipReceipts = 0;
for (const r of epsRun.reps) skipReceipts += r.receipts.filter((x) => x.kind === "skip-eps").length;
if (epsRun.writes - epsRun.emits !== skipReceipts) fail(`X4 violated: writes-emits=${epsRun.writes - epsRun.emits} != skip receipts=${skipReceipts}`);
if (!epsRun.reps.every((r) => r.verifyReceipts())) fail("X4: receipt chain broken");

// ---------- suite counts ----------
const t = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test/convergence.test.mjs", "test/numeric.test.mjs", "test/epsilon.test.mjs"], {
  cwd: ROOT, encoding: "utf8", timeout: 180000,
});
const count = (re) => { const m = (t.stdout ?? "").match(re); return m ? Number(m[1]) : null; };

const receipt = {
  experiment: "quilt-neighbourhood v0.4.0 P7 epsilon-diff federated checkpoints",
  claims: {
    X1: `|merged_eps - merged_exact| <= ${EPSILON} per element (measured max ${maxErr} on ${worstCell})`,
    X2: `|loss_eps - loss_exact| <= ${LOSS_BAND} (measured ${Math.abs(mergedLossEps - mergedLossExact)})`,
    X3: "eps DAG merge-order independent: 24/24 orders -> 1 revision, byte-identical state",
    X4: "writes - emits == skip-eps receipts on every replica; chains verify",
  },
  config: { dataSeed: DATA_SEED, sharedInit: GENESIS_SEED, shuffleSeeds: SHUFFLE_SEEDS, steps: STEPS, checkpointEvery: CHECKPOINT, batch: BATCH, lr: LR, epsilon: EPSILON, cells: CELLS.length },
  sparsity: {
    potentialWrites: epsRun.writes,
    emitted: epsRun.emits,
    skipped: epsRun.writes - epsRun.emits,
    skipRatio: +((epsRun.writes - epsRun.emits) / epsRun.writes).toFixed(6),
    perCheckpoint: epsRun.perCheckpoint,
    exactPotential: exactRun.writes,
    exactEmitted: exactRun.emits,
  },
  losses: { genesisBaseline: epsRun.genesisLoss, perReplicaFinal: epsRun.perReplicaFinalLoss, mergedEps: mergedLossEps, mergedExact: mergedLossExact, absDiff: Math.abs(mergedLossEps - mergedLossExact), band: LOSS_BAND },
  bound: { maxElementError: maxErr, worstCell, epsilon: EPSILON, held: maxErr <= EPSILON },
  mergeOrders: { tested: orders.length, distinctRevisions: uniqRev.size, revision: [...uniqRev][0], stateSha256: sha256(canonicalize(mergedEps)) },
  tests: { tests: count(/# tests (\d+)/), pass: count(/# pass (\d+)/), fail: count(/# fail (\d+)/), exitCode: t.status },
  node: process.version,
  timestamps: { started: startedISO, finished: new Date().toISOString() },
};
mkdirSync(path.join(ROOT, "receipts"), { recursive: true });
writeFileSync(path.join(ROOT, "receipts", "experiment-v0.4.0-eps.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify({
  sparsity: receipt.sparsity,
  losses: receipt.losses,
  bound: receipt.bound,
  mergeOrders: { tested: receipt.mergeOrders.tested, distinctRevisions: receipt.mergeOrders.distinctRevisions },
  tests: receipt.tests,
}, null, 2));
console.log("receipt written: receipts/experiment-v0.4.0-eps.json");
