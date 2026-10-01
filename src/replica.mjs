// replica.mjs — a neighbourhood member: one quilt sheet replica with a diff-DAG memory.
//
// MERGE POLICY (registered, deterministic, pure function of the DAG):
//   P1  set causally after ALL live tombstones -> resurrect (value applies)
//   P2  set concurrent with ANY tombstone  -> REMOVE WINS  (REMOVE_WINS_CONCURRENT)
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
//   Non-number values on a numeric cell are accepted into the DAG (authors may run
//   divergent schemas) and simply trigger the P3 fallback at merge time.
//   Guards (receipted): a numeric-cell write of NaN / ±Infinity is rejected at write
//   time with a reject receipt; receiving such a diff is rejected with a receipt.
//
// TOMBSTONE-HEAD INVARIANT (v0.4.1, wave-72 regression for the wave-71 git-replay
// finding "removes are first-class heads"): EVERY delete event updates the fold's
// per-cell causality anchors — the live tombstone set — including a delete that
// lands on a cell that is already a tombstone. A later set resurrects only by
// dominating ALL live tombstones; dominating one anchor while staying concurrent
// with another is P2 (remove wins). A fold that anchors on a single tombstone —
// or that ignores deletes outright — makes post-tombstone writes concurrent
// siblings of their tombstone and buries legitimate resurrects (905 seen in the
// animal-ai replay before the wave-71 fix). Guarded by TH1–TH6.
//
// P6 (v0.3.0 — signed sheets, DID-signed diffs; see signed.mjs):
//   A replica registered `signed: true` accepts a remote diff ONLY if it carries a
//   valid Ed25519 signature over its 32-byte diff id, verifiable under the public
//   key embedded in the author's did (`did:key:z` + base32 of the raw key).
//   `signed: { authors: [did, ...] }` additionally pins an author allowlist (a valid
//   signature from an off-list did is still rejected). Unsigned or badly-signed
//   diffs are REJECTED and the rejection is receipted with the dedicated kind
//   "reject-sig"; id-integrity failures keep the v0.2.0 "reject" kind (the id gate
//   is cheaper and fires first). Local writes on a signed sheet REQUIRE
//   opts.privateKey; the author defaults to the signing key's did, and an explicit
//   author that is not the signing key's did is refused — authorship must BE the
//   proof. `sig` is an overlay excluded from id/canonical computation, so revisions
//   stay value-pure (a signed sheet and an unsigned re-run of the same values
//   reach byte-identical revisions). Unsigned sheets keep v0.2.0 behavior exactly:
//   they never look at `sig`. The documented downgrade risk: an unsigned sheet
//   cannot examine signatures at all, so it accepts diffs a signed sheet would
//   reject (NC5) — signatures protect the sheets that enforce them.
//
// Every state change (local append or remote receive, accept or reject) is sealed into
// an append-only receipt chain: {seq, kind, payload_sha, prev_sha, sha}. The chain is
// the neighbourhood's honesty surface — tamper with any entry and verifyReceipts fails.
import { makeDiff, verifyDiff, OP, GENESIS } from "./diff.mjs";
import { canonicalize, sha256 } from "./canonical.mjs";
import { didFromPrivateKey, signDiff, verifyDiffForSheet } from "./signed.mjs";
import { ABSENT, deriveRecDiffs, makeMarker, verifyReconciliationEvent } from "./reconciliation.mjs";

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

// maxDeltaNumeric(cur, next): the P7 gate's distance. Numbers -> |cur-next|;
// equal-shape arrays -> max element-wise |cur-next|; shape/type mismatch -> null
// (always emit — an incompatible write is a real change, never skippable).
function maxDeltaNumeric(cur, next) {
  if (typeof cur === "number" && typeof next === "number") return Math.abs(next - cur);
  if (Array.isArray(cur) && Array.isArray(next) && cur.length === next.length) {
    let m = 0;
    for (let i = 0; i < cur.length; i++) {
      if (typeof cur[i] !== "number" || typeof next[i] !== "number") return null;
      const d = Math.abs(next[i] - cur[i]);
      if (d > m) m = d;
    }
    return m;
  }
  return null;
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
  // Sheet schema — two shapes, both supported:
  //   v0.2.0 style: { numeric: [...cell globs...] }
  //   v0.3.0 style: { schema: { numeric: [...], signed: true | { authors: [did...] } } }
  // numeric: cell names registered as numeric (P5 applies). Entries are exact cell
  //   names ("b2:0") or prefix globs ending in "*" ("W0:*").
  // signed: DID-signature policy. true = every accepted diff must carry a valid
  //   signature; { authors } = and its author did must be on the allowlist;
  //   false/undefined = v0.2.0 behavior, signatures are never examined.
  // epsilon (P7, v0.4.0): epsilon-diff policy for numeric cells. A set() whose
  //   value is within epsilon (per element) of the replica's CURRENT DAG value
  //   emits NO diff — the write is sealed as a receipted "skip-eps" (no silent
  //   drops) and set() returns null. THE P7 INVARIANT: after every set(), the
  //   DAG value is within epsilon (per element) of the most recently written
  //   value — so the merged state is a bounded approximation of the exact one
  //   (|merged_P7 - merged_exact| <= epsilon per element whenever every
  //   contributor has written since its last sync). 0/undefined = exact (v0.3.0).
  constructor(name, sheet = "default", opts = {}) {
    this.name = name;
    this.sheet = sheet;
    const schema = opts.schema ?? {};
    const numeric = schema.numeric ?? opts.numeric ?? [];
    this._numeric = numeric.map((p) =>
      p.endsWith("*") ? { prefix: p.slice(0, -1) } : { exact: p }
    );
    this._signed = schema.signed ?? opts.signed ?? false;
    this._epsilon = schema.epsilon ?? opts.epsilon ?? 0;
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
  // opts: {author?, ts?, privateKey?} — ts lets experiments pin deterministic diff ids.
  // On a signed sheet (v0.3.0) privateKey is REQUIRED: the diff is signed over its id
  // and the author defaults to the signing key's did (an explicit author that is not
  // the signing key's did is refused with a receipted reject-sig). Failure counts as
  // failure: see _localSigner.
  set(cell, value, opts = {}) {
    const o = typeof opts === "string" ? { author: opts } : opts;
    if (this.isNumeric(cell)) this._checkNumericWrite(cell, value);
    const signer = this._localSigner(o, cell);
    // P7 epsilon-diff gate (numeric cells only; runs AFTER the signed gate so a
    // signed sheet still demands its key even when the write ends up skipped).
    const eps = o.epsilon ?? this._epsilon ?? 0;
    if (this.isNumeric(cell) && eps > 0) {
      const cur = this.valueAt(cell);
      if (cur !== undefined) {
        const maxDelta = maxDeltaNumeric(cur, value);
        if (maxDelta !== null && maxDelta <= eps) {
          this._seal("skip-eps", { cell, maxDelta, epsilon: eps });
          return null; // no diff: the P7 invariant pins |cur - value| <= eps
        }
      }
    }
    const parents = this._headIds();
    const d = makeDiff({
      sheet: this.sheet, cell, op: OP.SET, value, prev: this.valueAt(cell),
      author: signer ? signer.did : (o.author ?? this.name), ts: o.ts ?? Date.now(), parents,
    });
    if (signer) Object.assign(d, signDiff(d, signer.privateKey)); // sig is an overlay: id unchanged
    this._absorb(d);
    this._seal("set", { cell, id: d.id });
    return d;
  }

  remove(cell, opts = {}) {
    const o = typeof opts === "string" ? { author: opts } : opts;
    const signer = this._localSigner(o, cell);
    const parents = this._headIds();
    const d = makeDiff({
      sheet: this.sheet, cell, op: OP.REMOVE, value: undefined, prev: this.valueAt(cell),
      author: signer ? signer.did : (o.author ?? this.name), ts: o.ts ?? Date.now(), parents,
    });
    if (signer) Object.assign(d, signDiff(d, signer.privateKey));
    this._absorb(d);
    this._seal("remove", { cell, id: d.id });
    return d;
  }

  // Signed-sheet local-write gate. Returns null on an unsigned sheet; on a signed
  // sheet returns { did, privateKey } or throws after receipting a reject-sig.
  _localSigner(o, cell) {
    if (!this._signed) return null;
    if (!o.privateKey) {
      this._seal("reject-sig", { cell, reason: "signed sheet: local write requires opts.privateKey" });
      throw new TypeError(`signed sheet: local write of "${cell}" requires opts.privateKey (authorship must be a proof)`);
    }
    const did = didFromPrivateKey(o.privateKey);
    if (o.author !== undefined && o.author !== did) {
      this._seal("reject-sig", { cell, reason: `author ${o.author} is not the signing key's did ${did}` });
      throw new TypeError(`signed sheet: author ${o.author} does not match the signing key's did ${did}`);
    }
    return { did, privateKey: o.privateKey };
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
  // rejected and the rejection is receipted (NC1, kind "reject"); on a signed sheet,
  // diffs without a valid signature (or from an off-allowlist author) are rejected
  // with kind "reject-sig" (S2/S3/S4); non-finite values on numeric cells are
  // rejected and receipted (NC4).
  receive(d) {
    if (this.diffs.has(d.id)) return { accepted: false, reason: "known" };
    const v = verifyDiff(d);
    if (!v.ok) {
      this._seal("reject", { id: d.id ?? "null", reason: v.reason });
      return { accepted: false, reason: v.reason };
    }
    if (this._signed) {
      const s = verifyDiffForSheet(d, this._signed);
      if (!s.ok) {
        this._seal("reject-sig", { id: d.id ?? "null", reason: s.reason });
        return { accepted: false, reason: s.reason };
      }
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
    return this._foldState(null);
  }

  // The fold itself: P1–P5 + tombstone-head, over the whole DAG (idFilter = null)
  // or restricted to a subset of diff ids (stateAt). A pure function of the DAG —
  // every replica that knows the same diffs folds to the same state bytes.
  _foldState(idFilter) {
    const cellState = new Map(); // cell -> {kind:'value'|'group'|TOMBSTONE, ...}; a TOMBSTONE carries `tombs`: the live set of remove-diff ids (the cell's causality anchors)
    for (const id of this._topo()) {
      if (idFilter && !idFilter.has(id)) continue;
      const d = this.diffs.get(id);
      const cur = cellState.get(d.cell);
      if (d.op === OP.SET) {
        if (!cur) { cellState.set(d.cell, { kind: "value", by: id, value: d.value }); continue; }
        if (cur.kind === TOMBSTONE) {
          // P1/P2 (tombstone-head invariant): resurrect only if the set dominates
          // EVERY live tombstone anchor on the cell. Dominating one anchor while
          // concurrent with another is P2 — remove wins (TH3/TH4).
          const anc = this.ancestors(id);
          let dominates = true;
          for (const t of cur.tombs) if (!anc.has(t)) { dominates = false; break; }
          if (dominates) cellState.set(d.cell, { kind: "value", by: id, value: d.value });
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
        // REMOVE — a FIRST-CLASS HEAD of the cell (tombstone-head invariant): the
        // delete event updates the cell's causality anchors even when the cell is
        // already a tombstone (a delete-on-delete still joins the live tombstone
        // set — P4 stays idempotent in STATE, but the anchor is not left stale).
        // Collapses values AND pending groups alike:
        //   causally after the current winner -> normal delete;
        //   concurrent with it (or with any group member) -> P2 remove wins.
        if (!cur) { cellState.set(d.cell, { kind: TOMBSTONE, tombs: new Set([id]) }); continue; }
        if (cur.kind === TOMBSTONE) { cur.tombs.add(id); continue; } // P4 idempotent
        cellState.set(d.cell, { kind: TOMBSTONE, tombs: new Set([id]) });
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

  // ---------- branch trees (P8) ----------
  // stateAt(id): the fold restricted to diff `id` and its ancestors — "the state of
  // the branch at head id". The same P1–P5 + tombstone-head fold, walked in the
  // full DAG's topo order with non-member diffs skipped (ancestry is intrinsic, so
  // dominance checks are identical).
  stateAt(id) {
    if (!this.diffs.has(id)) throw new Error(`stateAt: unknown diff ${id}`);
    const keep = this.ancestors(id);
    keep.add(id);
    return this._foldState(keep);
  }

  // treeAt(id): stateAt(id) minus the bookkeeping namespace ("_"-prefixed cells) —
  // the per-parent tree { cell -> value } that P8's rec-diff derivation diffs
  // against (RFC P8 §2: tree(Hi)). A missing key means the cell does not exist on
  // that side.
  treeAt(id) {
    const s = this.stateAt(id);
    const out = {};
    for (const [cell, v] of Object.entries(s)) if (!cell.startsWith("_")) out[cell] = v;
    return out;
  }

  // The per-cell chain tails for `cell`: the diffs on the cell that no other diff
  // on the same cell dominates (via a DIRECT same-cell parent edge — the emission
  // protocol chains every diff on a cell onto its predecessor, so indirect
  // domination cannot hide a tail here; over-counting a tail only ADDS parents to
  // a rec-diff, which is the safe direction: more domination, never less).
  // On emission-shaped DAGs this is exactly the emitter's lastOnCell(c).
  _cellTails(cell, byCell) {
    const ids = byCell.get(cell);
    if (!ids) return [];
    const dominated = new Set();
    for (const id of ids)
      for (const p of this.diffs.get(id).parents) {
        const pd = p !== GENESIS && this.diffs.get(p);
        if (pd && pd.cell === cell) dominated.add(p);
      }
    return ids.filter((id) => !dominated.has(id)).sort();
  }

  // ---------- P8: reconciliation events (v0.5.0) ----------
  // Apply a reconciliation event (RFC P8): derive the event marker + one rec-diff
  // per differing cell per parent (the §2 emission loop, anchors derived from THIS
  // DAG's per-cell chain tails — byte-identical to the emitter's materialization
  // on emission-shaped DAGs), absorb them, fold, and ASSERT the folded state
  // against the event's asserted_tree. FAIL-CLOSED: any assertion mismatch rolls
  // the DAG back to the pre-application state (diffs, heads, ancestry memo), seals
  // a "reject-rec" receipt, and throws — nothing partially applies. Applying an
  // event whose marker this replica already knows is a receipted no-op (the DAG
  // gates re-application).
  //
  // opts.parentTrees: optional array aligned with event.parents — tree(Hi) per
  // parent. OMITTED (default): the trees are DERIVED from the DAG via treeAt(head)
  // — exact for DAGs where each branch head dominates its branch's content (every
  // Replica-built DAG; the rep-chained git-replay shape must supply them, since
  // there file diffs hang OFF the rep chain). A lying caller cannot forge a pass:
  // the assertion checks the fold, not the trees.
  applyReconciliation(event, opts = {}) {
    const v = verifyReconciliationEvent(event);
    if (!v.ok) {
      this._seal("reject-rec", { event: event?.id ?? null, reason: v.reason });
      throw new TypeError(`reconciliation event rejected: ${v.reason}`);
    }
    for (const p of event.parents) {
      if (!this.diffs.has(p)) {
        this._seal("reject-rec", { event: event.id, reason: `unknown parent ${p}` });
        throw new Error(`reconciliation ${event.id.slice(0, 8)}: parent ${p.slice(0, 8)} unknown — partial knowledge is not applicable (the DAG gates application, RFC P8 §6 Q1)`);
      }
    }
    if (this._signed) {
      // P6 interplay is unspecified (RFC P8 §6 Q2): rec-diffs would need signatures
      // this implementation does not produce — fail closed rather than silently
      // accepting unsigned assertions into a signed sheet.
      this._seal("reject-rec", { event: event.id, reason: "signed sheet: reconciliation application unspecified (RFC P8 §6 Q2)" });
      throw new TypeError("signed sheet: applyReconciliation is unspecified (RFC P8 §6 Q2) and refuses to absorb unsigned rec-diffs");
    }
    const marker = makeMarker(event, this.sheet);
    if (this.diffs.has(marker.id)) return { applied: false, reason: "known", marker };

    let parentTrees = opts.parentTrees;
    if (parentTrees === undefined) {
      parentTrees = event.parents.map((p) => this.treeAt(p));
    } else if (!Array.isArray(parentTrees) || parentTrees.length !== event.parents.length) {
      throw new TypeError("opts.parentTrees must be an array aligned with event.parents (or omit it to derive trees from the DAG)");
    }

    // Per-cell chain tails of the KNOWN DAG, for the cells the event asserts.
    const byCell = new Map();
    for (const [id, d] of this.diffs) {
      if (!byCell.has(d.cell)) byCell.set(d.cell, []);
      byCell.get(d.cell).push(id);
    }
    const lastOnCell = new Map();
    for (const cell of Object.keys(event.asserted_tree)) lastOnCell.set(cell, this._cellTails(cell, byCell));

    const recDiffs = deriveRecDiffs({ sheet: this.sheet, event, markerId: marker.id, parentTrees, lastOnCell });

    // Absorb -> fold -> assert; roll back entirely on mismatch (fail-closed).
    const headsSnapshot = new Set(this.heads);
    const added = [];
    try {
      this._absorb(marker);
      added.push(marker.id);
      for (const d of recDiffs) {
        this._absorb(d);
        added.push(d.id);
      }
      const st = this.state();
      for (const [cell, a] of Object.entries(event.asserted_tree)) {
        if (cell.startsWith("_")) continue; // never asserted (guarded at creation too)
        const cur = st[cell];
        if (a === ABSENT) {
          if (cur !== undefined)
            throw new Error(`reconciliation assertion failed: cell "${cell}" is live (${JSON.stringify(cur)}) but the event asserts ABSENT`);
        } else if (cur === undefined || canonicalize(cur) !== canonicalize(a)) {
          throw new Error(`reconciliation assertion failed: cell "${cell}" folds to ${JSON.stringify(cur ?? null)} but the event asserts ${JSON.stringify(a)}`);
        }
      }
    } catch (e) {
      for (const id of added) {
        this.diffs.delete(id);
        this._anc.delete(id); // ancestry memo entries created for the trial diffs
      }
      this.heads = headsSnapshot;
      this._seal("reject-rec", { event: event.id, reason: e.message });
      throw e;
    }
    this._seal("reconciliation", { event: event.id, marker: marker.id, recDiffs: recDiffs.length });
    return { applied: true, event, marker, recDiffs, recDiffCount: recDiffs.length };
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
