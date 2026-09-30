// reference_mean.mjs — the INDEPENDENT reference for the v0.2.0 experiment.
// Deliberately imports NOTHING from src/: it re-derives, from raw CellDiff objects
// alone, (1) the live concurrent contributor class per cell (a diff is live if no
// other set diff on the same cell is causally after it), (2) the canonical
// summation order (lexicographic diff id), and (3) the mean (acc = 0, add in
// order, divide once). It also carries its own float64 big-endian hex encoder so
// the byte-parity check cross-examines two implementations of the encoding.
//
// Spec it must match (documented in src/replica.mjs, policy P5):
//   contributors = live pairwise-concurrent set diffs of the cell
//   mean = (0 + v_id1 + v_id2 + ... + v_idk) / k, ids sorted lexicographically
//   arrays: element-wise; removes: none expected in this experiment (asserted).

// independent float64 big-endian hex (witness encoding; -0 !== 0, NaN visible)
export function f64hex(v) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, v, false);
  let s = "";
  for (let i = 0; i < 8; i++) s += view.getUint8(i).toString(16).padStart(2, "0");
  return s;
}

export function valueHex(v) {
  if (typeof v === "number") return f64hex(v);
  if (Array.isArray(v)) return "[" + v.map(f64hex).join(",") + "]";
  return JSON.stringify(v, Object.keys(v).sort());
}

function ancestorsOf(id, byId, memo) {
  if (memo.has(id)) return memo.get(id);
  if (id === "GENESIS") { const s = new Set(); memo.set(id, s); return s; }
  const d = byId.get(id);
  const s = new Set();
  if (d) for (const p of d.parents) {
    s.add(p);
    for (const a of ancestorsOf(p, byId, memo)) s.add(a);
  }
  memo.set(id, s);
  return s;
}

export function referenceMean(diffs) {
  const byId = new Map(diffs.map((d) => [d.id, d]));
  const memo = new Map();
  const setsByCell = new Map();
  for (const d of diffs) {
    if (d.op !== "set") throw new Error(`reference expects no removes, saw ${d.op} on ${d.cell}`);
    if (!setsByCell.has(d.cell)) setsByCell.set(d.cell, []);
    setsByCell.get(d.cell).push(d);
  }
  const state = {};
  const contributors = {};
  for (const [cell, ds] of setsByCell) {
    const live = ds.filter((d) => !ds.some((o) => o !== d && ancestorsOf(o.id, byId, memo).has(d.id)));
    for (const a of live) for (const b of live) {
      if (a === b) continue;
      const aa = ancestorsOf(a.id, byId, memo);
      const ab = ancestorsOf(b.id, byId, memo);
      if (aa.has(b.id) || ab.has(a.id)) throw new Error(`live class on ${cell} is not pairwise concurrent`);
    }
    contributors[cell] = live.map((d) => d.id).sort();
    const vals = contributors[cell].map((id) => byId.get(id).value);
    if (typeof vals[0] === "number") {
      let acc = 0;
      for (const v of vals) acc += v;
      state[cell] = acc / vals.length;
    } else {
      const n = vals[0].length;
      const acc = new Array(n).fill(0);
      for (const v of vals) for (let i = 0; i < n; i++) acc[i] += v[i];
      state[cell] = acc.map((s) => s / vals.length);
    }
  }
  return { state, contributors };
}
