// replica.mjs — a neighbourhood member: one quilt sheet replica with a diff-DAG memory.
//
// MERGE POLICY (registered, deterministic, pure function of the DAG):
//   P1  set vs tombstone, causally after   -> resurrect (value applies)
//   P2  set vs tombstone, concurrent       -> REMOVE WINS  (REMOVE_WINS_CONCURRENT)
//   P3  set vs set, concurrent             -> lexicographically smaller diff id wins
//   P4  remove vs remove, any relation     -> tombstone (idempotent)
// These policies are deliberately coarser than a full OR-Set (per-add-id removal is v2);
// they are registered here so the convergence property is testable and falsifiable.
//
// Every state change (local append or remote receive, accept or reject) is sealed into
// an append-only receipt chain: {seq, kind, payload_sha, prev_sha, sha}. The chain is
// the neighbourhood's honesty surface — tamper with any entry and verifyReceipts fails.
import { makeDiff, verifyDiff, OP, GENESIS } from "./diff.mjs";
import { canonicalize, sha256 } from "./canonical.mjs";

const TOMBSTONE = Symbol("tombstone");

export class Replica {
  constructor(name, sheet = "default") {
    this.name = name;
    this.sheet = sheet;
    this.diffs = new Map(); // id -> diff
    this.heads = new Set(); // diff ids with no known children
    this.receipts = [];
    this._anc = new Map(); // id -> Set(ancestor ids), memoized
    this._seal("genesis", { name });
  }

  // ---------- receipt chain ----------
  _seal(kind, payload) {
    const seq = this.receipts.length;
    const payload_sha = sha256(canonicalize(payload));
    const prev_sha = seq === 0 ? GENESIS : this.receipts[seq - 1].sha;
    const sha = sha256(`${seq}|${kind}|${payload_sha}|${prev_sha}`);
    this.receipts.push({ seq, kind, payload_sha, prev_sha, sha });
    return sha;
  }

  verifyReceipts() {
    for (let i = 0; i < this.receipts.length; i++) {
      const r = this.receipts[i];
      const prev_sha = i === 0 ? GENESIS : this.receipts[i - 1].sha;
      if (r.seq !== i || r.prev_sha !== prev_sha) return false;
      if (sha256(`${r.seq}|${r.kind}|${r.payload_sha}|${r.prev_sha}`) !== r.sha) return false;
    }
    return true;
  }

  // ---------- causal ancestry ----------
  ancestors(id) {
    if (this._anc.has(id)) return this._anc.get(id);
    if (id === GENESIS) { const s = new Set(); this._anc.set(id, s); return s; }
    const d = this.diffs.get(id);
    const s = new Set();
    if (d) for (const p of d.parents) {
      s.add(p);
      for (const a of this.ancestors(p)) s.add(a);
    }
    this._anc.set(id, s);
    return s;
  }

  // ---------- local writes ----------
  set(cell, value, author = this.name) {
    const parents = this._headIds();
    const d = makeDiff({ sheet: this.sheet, cell, op: OP.SET, value, prev: this.valueAt(cell), author, ts: Date.now(), parents });
    this._absorb(d);
    this._seal("set", { cell, id: d.id });
    return d;
  }

  remove(cell, author = this.name) {
    const parents = this._headIds();
    const d = makeDiff({ sheet: this.sheet, cell, op: OP.REMOVE, value: undefined, prev: this.valueAt(cell), author, ts: Date.now(), parents });
    this._absorb(d);
    this._seal("remove", { cell, id: d.id });
    return d;
  }

  // ---------- remote receive ----------
  // Returns {accepted, reason}. Known diffs are idempotent no-ops; tampered diffs are
  // rejected and the rejection is receipted (NC1).
  receive(d) {
    if (this.diffs.has(d.id)) return { accepted: false, reason: "known" };
    const v = verifyDiff(d);
    if (!v.ok) {
      this._seal("reject", { id: d.id ?? "null", reason: v.reason });
      return { accepted: false, reason: v.reason };
    }
    this._absorb(d);
    this._seal("receive", { id: d.id });
    return { accepted: true, reason: "ok" };
  }

  _absorb(d) {
    this.diffs.set(d.id, d);
    for (const p of d.parents) if (p !== GENESIS) this.heads.delete(p);
    this.heads.add(d.id);
  }

  _headIds() {
    return this.heads.size ? [...this.heads].sort() : [GENESIS];
  }

  // ---------- deterministic fold ----------
  // Topological order, ties broken by id — a pure function of the DAG, so every replica
  // that knows the same diffs folds to the same state bytes regardless of arrival order.
  _topo() {
    const ids = [...this.diffs.keys()].sort();
    const indeg = new Map();
    const children = new Map();
    for (const id of ids) { indeg.set(id, 0); children.set(id, []); }
    for (const id of ids) for (const p of this.diffs.get(id).parents) {
      if (p !== GENESIS && this.diffs.has(p)) { indeg.set(id, indeg.get(id) + 1); children.get(p).push(id); }
    }
    const queue = ids.filter((id) => indeg.get(id) === 0);
    const out = [];
    while (queue.length) {
      queue.sort();
      const id = queue.shift();
      out.push(id);
      for (const c of children.get(id)) {
        indeg.set(c, indeg.get(c) - 1);
        if (indeg.get(c) === 0) queue.push(c);
      }
    }
    if (out.length !== ids.length) throw new Error("diff DAG has a cycle — identity is broken");
    return out;
  }

  state() {
    const cellState = new Map(); // cell -> {kind:'value'|TOMBSTONE, by:id, value?}
    for (const id of this._topo()) {
      const d = this.diffs.get(id);
      const cur = cellState.get(d.cell);
      if (d.op === OP.SET) {
        if (!cur) { cellState.set(d.cell, { kind: "value", by: id, value: d.value }); continue; }
        if (cur.kind === TOMBSTONE) {
          // P1/P2: resurrect only if the tombstone is an ancestor (causally before)
          if (this.ancestors(id).has(cur.by)) cellState.set(d.cell, { kind: "value", by: id, value: d.value });
          // else P2: remove wins, keep tombstone
          continue;
        }
        // cur is a value
        if (this.ancestors(id).has(cur.by)) { cellState.set(d.cell, { kind: "value", by: id, value: d.value }); continue; }
        if (this.ancestors(cur.by).has(id)) continue; // already superseded (cannot happen in topo, kept for safety)
        // P3: concurrent sets — smaller id wins
        if (id < cur.by) cellState.set(d.cell, { kind: "value", by: id, value: d.value });
      } else {
        // REMOVE
        if (!cur) { cellState.set(d.cell, { kind: TOMBSTONE, by: id }); continue; }
        if (cur.kind === TOMBSTONE) continue; // P4 idempotent
        if (this.ancestors(id).has(cur.by)) { cellState.set(d.cell, { kind: TOMBSTONE, by: id }); continue; }
        // concurrent remove vs value -> P2 remove wins
        cellState.set(d.cell, { kind: TOMBSTONE, by: id });
      }
    }
    const out = {};
    for (const [cell, s] of cellState) if (s.kind === "value") out[cell] = s.value;
    return out;
  }

  valueAt(cell) {
    const s = this.state()[cell];
    return s === undefined ? null : s;
  }

  revision() {
    return sha256([...this.heads].sort().join(","));
  }

  diffCount() { return this.diffs.size; }
}

// merge(src -> dst): ship dst every diff src knows and dst lacks, in src's topo order.
export function merge(src, dst) {
  const srcOrder = new Set(src._topo());
  const missing = src._topo().filter((id) => !dst.diffs.has(id));
  let applied = 0;
  for (const id of missing) applied += dst.receive(src.diffs.get(id)).accepted ? 1 : 0;
  void srcOrder;
  return { applied, revision: dst.revision() };
}
