// replica.mjs — a neighbourhood member: one quilt sheet replica with a diff-DAG memory.
//
// MERGE POLICY (registered, deterministic, pure function of the DAG):
//   P1  set vs tombstone, causally after   -> resurrect (value applies)
//   P2  set vs tombstone, concurrent       -> REMOVE WINS  (REMOVE_WINS_CONCURRENT)
//   P3  set vs set, concurrent             -> lexicographically smaller diff id wins
//   P4  remove vs remove, any relation     -> tombstone (idempotent)
//   P5  set vs set, concurrent, cell REGISTERED NUMERIC in the sheet schema
//                                          -> canonical MEAN of the live concurrent
//                                             contributors (v0.2.0)
//
// P5 (the numeric contract, for ML weights and other numeric cells):
//   Float addition is not associative — (a+b)+c !== a+(b+c) in general — so a merge
//   that is byte-identical regardless of merge order REQUIRES a canonical summation
//   order. P5 fixes the order by CONTENT: contributors are summed in lexicographic
//   order of their diff ids. The contributor SET is a pure function of the DAG (the
//   live concurrent class), so the mean is byte-identical in every merge order, on
//   every IEEE-754 machine (basic ops are correctly rounded; operand order is fixed).
//   Formal semantics for a numeric cell c:
//     - The fold keeps a PENDING GROUP of set diffs that are pairwise concurrent and
//       live (no other set diff on c is causally after them). A set causally after
//       every member supersedes the group (plain set, P1 unchanged). A set causally
//       after some members replaces them and joins (stays concurrent with the rest).
//     - Any REMOVE on c collapses the group to a tombstone: P2 remove-wins holds for
//       removes concurrent with ANY member, and a remove causally after a member is a
//       normal delete. A causally-later set resurrects per P1 — as a plain set.
//     - At fold end a pending group of k >= 2 members resolves to the element-wise
//       mean, acc = 0, summed in sorted-diff-id order, divided by k.
//     - If any member is not mergeable-numeric (a non-number, or arrays of unequal
//       length, or non-finite elements), the group falls back to P3: the member with
//       the lexicographically smallest id wins. Same fallback if the cell is not
//       registered numeric at all (then the fold never forms a group).
//   Guards (receipted): a numeric-cell write of NaN / ±Infinity is rejected at write
//   time with a reject receipt; receiving such a diff is rejected with a receipt.
//   Non-number values on a numeric cell are accepted into the DAG (authors may run
//   divergent schemas) and simply trigger the P3 fallback at merge time.
//
// Every state change (local append or remote receive, accept or reject) is sealed into
// an append-only receipt chain: {seq, kind, payload_sha, prev_sha, sha}. The chain is
// the neighbourhood's honesty surface — tamper with any entry and verifyReceipts fails.
import { makeDiff, verifyDiff, OP, GENESIS } from "./diff.mjs";
import { canonicalize, sha256 } from "./canonical.mjs";

const TOMBSTONE = Symbol("tombstone");

// Is this value mergeable-numeric for P5: a finite number, or an array of finite
// numbers all of one length? NaN / ±Infinity poison canonical summation and their
// JSON encoding collides with null, so they are never mergeable-numeric.
export function mergeableNumeric(v) {
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) {
    return v.every((e) => typeof e === "number" && Number.isFinite(e));
  }
  return false;
}

function sameShape(vals) {
  if (vals.every((v) => typeof v === "number")) return true;
  if (!vals.every((v) => Array.isArray(v))) return false;
  const len = vals[0].length;
  return vals.every((v) => v.length === len);
}

// Does this value carry a non-finite NUMBER anywhere (NaN or ±Infinity)? These
// poison canonical summation and their JSON encoding collides with null, so they
// are rejected on numeric-cell writes and receives. Non-number types (e.g. a
// string pushed by a replica running a divergent schema) are receivable — the
// merge falls back to P3 for them.
export function hasNonFinite(v) {
  if (typeof v === "number") return !Number.isFinite(v);
  if (Array.isArray(v)) return v.some((e) => typeof e === "number" && !Number.isFinite(e));
  return false;
}

// canonicalMean(values): the P5 reduction. `values` MUST already be in canonical
// order (lexicographic diff id of the contributors). acc starts at 0; each element
// is added in order; one division by n at the end. Same operand order => same
// IEEE-754 bits on every machine. Element-wise for arrays.
export function canonicalMean(values) {
  if (values.length === 0) throw new Error("canonicalMean of zero contributors");
  if (typeof values[0] === "number") {
    let acc = 0;
    for (const v of values) acc += v;
    return acc / values.length;
  }
  const n = values[0].length;
  const acc = new Array(n).fill(0);
  for (const v of values) for (let i = 0; i < n; i++) acc[i] += v[i];
  return acc.map((s) => s / values.length);
}

export class Replica {
  // opts.numeric: sheet schema — cell names registered as numeric (P5 applies).
  // Entries are exact cell names ("b2:0") or prefix globs ending in "*" ("W0:*").
  constructor(name, sheet = "default", opts = {}) {
    this.name = name;
    this.sheet = sheet;
    this._numeric = (opts.numeric ?? []).map((p) =>
      p.endsWith("*") ? { prefix: p.slice(0, -1) } : { exact: p }
    );
    this.diffs = new Map(); // id -> diff
    this.heads = new Set(); // diff ids with no known children
    this.receipts = [];
    this._anc = new Map(); // id -> Set(ancestor ids), memoized
    this._seal("genesis", { name });
  }

  isNumeric(cell) {
    for (const m of this._numeric) {
      if (m.exact !== undefined ? m.exact === cell : cell.startsWith(m.prefix)) return true;
    }
    return false;
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
  // opts: {author?, ts?} — ts lets experiments pin deterministic diff ids.
  set(cell, value, opts = {}) {
    const o = typeof opts === "string" ? { author: opts } : opts;
    if (this.isNumeric(cell)) this._checkNumericWrite(cell, value);
    const parents = this._headIds();
    const d = makeDiff({
      sheet: this.sheet, cell, op: OP.SET, value, prev: this.valueAt(cell),
      author: o.author ?? this.name, ts: o.ts ?? Date.now(), parents,
    });
    this._absorb(d);
    this._seal("set", { cell, id: d.id });
    return d;
  }

  remove(cell, opts = {}) {
    const o = typeof opts === "string" ? { author: opts } : opts;
    const parents = this._headIds();
    const d = makeDiff({
      sheet: this.sheet, cell, op: OP.REMOVE, value: undefined, prev: this.valueAt(cell),
      author: o.author ?? this.name, ts: o.ts ?? Date.now(), parents,
    });
    this._absorb(d);
    this._seal("remove", { cell, id: d.id });
    return d;
  }

  // Write-time schema guard (P5): NaN and ±Infinity are rejected on numeric cells
  // and the rejection is receipted (NC4). Wrong *types* (e.g. a string from a
  // replica running a divergent schema) are not writable here, but they ARE
  // receivable — the merge falls back to P3 for them (T9).
  _checkNumericWrite(cell, value) {
    const reject = (reason) => {
      this._seal("reject", { cell, reason });
      throw new TypeError(`numeric cell "${cell}": ${reason}`);
    };
    if (typeof value === "number") {
      if (!Number.isFinite(value)) reject(`non-finite value ${String(value)} rejected — P5 canonical summation requires finite floats`);
      return;
    }
    if (Array.isArray(value)) {
      if (!value.every((e) => typeof e === "number" && Number.isFinite(e)))
        reject("array contains a non-finite or non-number element");
      return;
    }
    reject(`value of type ${typeof value} is not numeric`);
  }

  // ---------- remote receive ----------
  // Returns {accepted, reason}. Known diffs are idempotent no-ops; tampered diffs are
  // rejected and the rejection is receipted (NC1); non-finite values on numeric cells
  // are rejected and receipted (NC4).
  receive(d) {
    if (this.diffs.has(d.id)) return { accepted: false, reason: "known" };
    const v = verifyDiff(d);
    if (!v.ok) {
      this._seal("reject", { id: d.id ?? "null", reason: v.reason });
      return { accepted: false, reason: v.reason };
    }
    if (d.op === OP.SET && this.isNumeric(d.cell) && hasNonFinite(d.value)) {
      this._seal("reject", { id: d.id, reason: "non-finite value in numeric cell" });
      return { accepted: false, reason: "non-finite value in numeric cell" };
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
    const cellState = new Map(); // cell -> {kind:'value'|'group'|TOMBSTONE, ...}
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
        if (cur.kind === "group") {
          // P5 pending numeric conflict group (members pairwise concurrent & live)
          const superseded = [...cur.members.keys()].filter((m) => this.ancestors(id).has(m));
          if (superseded.length === cur.members.size) {
            // causally after EVERY member -> the whole conflict is superseded: plain set
            cellState.set(d.cell, { kind: "value", by: id, value: d.value });
          } else {
            const members = new Map(cur.members);
            for (const m of superseded) members.delete(m);
            members.set(id, d.value);
            cellState.set(d.cell, { kind: "group", members });
          }
          continue;
        }
        // cur is a value
        if (this.ancestors(id).has(cur.by)) { cellState.set(d.cell, { kind: "value", by: id, value: d.value }); continue; }
        if (this.ancestors(cur.by).has(id)) continue; // already superseded (cannot happen in topo, kept for safety)
        // concurrent set vs value
        if (this.isNumeric(d.cell)) {
          // P5: open a pending group — resolution (mean vs P3 fallback) happens at fold end
          cellState.set(d.cell, { kind: "group", members: new Map([[cur.by, cur.value], [id, d.value]]) });
        } else if (id < cur.by) {
          // P3: concurrent sets — smaller id wins
          cellState.set(d.cell, { kind: "value", by: id, value: d.value });
        }
      } else {
        // REMOVE — collapses values AND pending groups alike:
        //   causally after the current winner -> normal delete;
        //   concurrent with it (or with any group member) -> P2 remove wins.
        if (!cur) { cellState.set(d.cell, { kind: TOMBSTONE, by: id }); continue; }
        if (cur.kind === TOMBSTONE) continue; // P4 idempotent
        cellState.set(d.cell, { kind: TOMBSTONE, by: id });
      }
    }
    const out = {};
    for (const [cell, s] of cellState) {
      if (s.kind === "group") out[cell] = this._resolveGroup(cell, s.members);
      else if (s.kind === "value") out[cell] = s.value;
    }
    return out;
  }

  // P5 resolution of a pending group: element-wise canonical mean if every member is
  // mergeable-numeric in one shape; otherwise P3 (lexicographically smallest member
  // id wins). Summation order = sorted diff ids — content-addressed, merge-order
  // independent, byte-identical on any IEEE-754 machine.
  _resolveGroup(cell, members) {
    const ids = [...members.keys()].sort();
    const vals = ids.map((id) => members.get(id));
    if (this.isNumeric(cell) && vals.every(mergeableNumeric) && sameShape(vals)) {
      return canonicalMean(vals);
    }
    return members.get(ids[0]); // P3 fallback over the live concurrent class
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
