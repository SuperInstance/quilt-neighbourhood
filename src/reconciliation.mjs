// reconciliation.mjs — RFC P8: reconciliation events (v0.5.0).
//
// A merge commit's tree can differ from BOTH of its parents (criss-cross content:
// the resolver combined branch-side edits into a third value that exists in no
// commit on either branch). That content is a fact about the history — replayed
// HEAD must contain it — but it is NOT derivable from the diff streams, and no
// fold policy (P1–P5 operate per cell) is licensed to synthesize it. P8 makes the
// resolver's agreed tree a FIRST-CLASS DAG EVENT (RFC-P8-reconciliation-events.md):
//
//   Reconciliation {
//     type:          "reconciliation",
//     parents:       [H1, H2],     // BOTH branch heads being reconciled — never one
//     asserted_tree: { cell -> value | ABSENT },   // delta semantics: keys PRESENT
//                                                  // are asserted; keys missing are
//                                                  // unchecked; ABSENT asserts that
//                                                  // the cell does not exist
//     author, ts, id               // id = sha256(canonical(event-without-id))
//   }
//
// A CellDiff names ONE cell, so a reconciliation over k differing cells is
// materialized as ONE event marker + k rec-diffs (RFC P8 §2):
//   - Event marker rep(R): an ordinary set diff on a bookkeeping cell
//     (`_reconciliation/<event.id8>`, value {reconciliation: event.id}) whose
//     parents are BOTH branch heads — everything hanging off it is causally
//     after both sides. This is the seed's `_commit/<sha8>` trick, promoted.
//   - Rec-diff R→Hi(c): for every cell c where the asserted tree differs from
//     tree(Hi), one ordinary CellDiff (set with the asserted value, or remove
//     asserting ABSENT), prev = the value c had on the Hi side, parents =
//     [rep(R), ...per-cell chain tails]. Rec-diffs apply through the UNCHANGED
//     P1–P5 fold — no sixth conflict policy (RFC P8 §3/§4).
//
// Emission protocol (the seed's, proven over 13,062 rec-diffs in wave-71): iterate
// parents, then differing cells; after EVERY rec-diff the cell's anchor moves to the
// rec-diff (tombstone-head invariant: every event updates the anchor), so a cell
// asserted against k parents emits k CHAINED rec-diffs carrying the same asserted
// value. The per-cell anchor ("last-diff-on-c") is the cell's chain tail — the
// maximal diffs on that cell. On emission-shaped DAGs (every diff on a cell chains
// onto the previous one — what the seed's single lastOnCell map produces) that is
// exactly one id; on naively-branched DAGs the rec-diff anchors on ALL undominated
// same-cell diffs so the assertion can never lose a P3 id-lottery to a concurrent
// branch write (resolved in RFC P8 §6).
//
// Application lives in Replica.applyReconciliation (replica.mjs) and is FAIL-CLOSED:
// the fold must land exactly on the asserted tree, or nothing applies.
//
// v0.6.0 (P8 x P6 — DID-signed reconciliation events): the event schema gains an
// optional `sig` OVERLAY (excluded from the id, exactly like a diff's sig) — an
// Ed25519 signature over the 32-byte event-id buffer, verifiable under the public
// key embedded in the author's did (the same primitives as signed diffs;
// signed.mjs signId/verifySignatureOverId). FAIL-CLOSED AUTHORSHIP GATE: an event
// whose author field is a did:key:z string MUST carry a signature that verifies
// under that did, or applyReconciliation refuses — a did claims proof-of-authorship,
// so a did-authored unsigned event is refused rather than trusted (R6b/R6c).
// Events with a plain-string (non-did) author are untouched: they remain valid,
// signature-free, byte-for-byte v0.5.0 (backward compatibility, R1/R2/R5).
// The derived rec-diffs are NOT separately signed at application time: they are
// deterministic derivatives of the signature-verified event and the receiving DAG
// (their ids are a pure function of both), so the event signature is the
// authorship proof for the whole materialization. Emitters holding the key can
// additionally sign the materialized marker + rec-diffs (createReconciliation
// privateKey option) so they survive the P6 receive gate of signed sheets in
// transport; because sig is an identity-invisible overlay, those signed diffs have
// the SAME ids as any applier's re-derivation.
//
// Cells whose name starts with "_" are the bookkeeping namespace (commit markers,
// reconciliation markers): they never appear in asserted trees, parent trees
// (Replica.treeAt filters them), or assertions.
import { makeDiff, OP } from "./diff.mjs";
import { canonicalize, sha256 } from "./canonical.mjs";
import { DID_PREFIX, didFromPrivateKey, signDiff, signId, verifySignatureOverId } from "./signed.mjs";

// ABSENT — the asserted_tree sentinel for "this cell is asserted NOT to exist".
// A NUL byte cannot appear in a git path and JSON-encodes deterministically, so a
// legitimate cell value colliding with this string is pathological by construction.
export const ABSENT = "\u0000ABSENT";

// Build the canonical reconciliation event (RFC P8 §2 schema). parents MUST name
// both (or all) branch heads being reconciled — never one.
export function makeReconciliationEvent({ parents, assertedTree, author, ts }) {
  if (!Array.isArray(parents) || parents.length < 2)
    throw new TypeError("reconciliation event requires >= 2 parents (RFC P8: BOTH branch heads — never one)");
  if (!assertedTree || typeof assertedTree !== "object" || Array.isArray(assertedTree))
    throw new TypeError("assertedTree must be an object { cell -> value | ABSENT }");
  for (const c of Object.keys(assertedTree))
    if (c.startsWith("_"))
      throw new TypeError(`asserted cell "${c}" is in the reserved bookkeeping namespace ("_" prefix)`);
  const evt = { type: "reconciliation", parents: [...parents], asserted_tree: assertedTree, author, ts };
  evt.id = sha256(canonicalize(evt));
  return evt;
}

// Identity gate for a received event (NC1 ethos): the id must be the canonical hash
// of the event without it. Tampering with any field is self-evident. `sig` is an
// OVERLAY (v0.6.0): excluded from identity, so signed and unsigned views of one
// event share the id — stripping or re-signing never changes identity.
export function verifyReconciliationEvent(event) {
  if (!event || typeof event !== "object") return { ok: false, reason: "not a reconciliation event" };
  if (event.type !== "reconciliation") return { ok: false, reason: "not a reconciliation event" };
  if (!event.id) return { ok: false, reason: "no id" };
  const { id, sig, ...rest } = event;
  void sig;
  const expect = sha256(canonicalize(rest));
  if (expect !== id) return { ok: false, reason: `id mismatch: got ${id.slice(0, 12)} want ${expect.slice(0, 12)}` };
  if (!Array.isArray(event.parents) || event.parents.length < 2)
    return { ok: false, reason: "reconciliation event requires >= 2 parents" };
  const at = event.asserted_tree;
  if (!at || typeof at !== "object" || Array.isArray(at))
    return { ok: false, reason: "asserted_tree missing" };
  return { ok: true };
}

// Bookkeeping cell of the event marker rep(R).
export function markerCellFor(event) {
  return `_reconciliation/${event.id.slice(0, 8)}`;
}

// ---------- P8 x P6: DID-signed reconciliation events (v0.6.0) ----------

// signReconciliationEvent(event, privateKey) -> a NEW event carrying `sig`.
//   sig = base64(Ed25519 signature over the 32-byte event-id buffer) — the same
//   attestation shape as a signed diff. Mirrors signDiff's guards: refuses if
//   event.author is not exactly the signing key's did (authorship must BE the
//   proof), if the event already carries a sig, or if the id does not match the
//   payload. `sig` is an overlay: signing never changes the event id.
export function signReconciliationEvent(event, privateKey) {
  if (!event || typeof event !== "object" || !event.id)
    throw new TypeError("signReconciliationEvent: event must be an object with an id");
  const did = didFromPrivateKey(privateKey);
  if (event.author !== did)
    throw new Error(`signReconciliationEvent: event.author (${event.author}) is not the signing key's did (${did}) — set author = did, authorship must be the proof`);
  if (event.sig !== undefined)
    throw new Error("signReconciliationEvent: event already carries a sig — sign a fresh event, do not re-sign over an existing signature");
  const v = verifyReconciliationEvent(event);
  if (!v.ok)
    throw new Error(`signReconciliationEvent: refusing to sign an event whose id does not match its payload (${v.reason})`);
  return { ...event, sig: signId(event.id, privateKey) };
}

// verifySignedReconciliationEvent(event) -> { ok, reason } — full gate chain for a
// signed event: sig present; id integrity (canonical(event-without-sig-and-id) hashes
// to event.id — a self-consistent forgery with a STALE sig passes this and is caught
// by the signature); author is a parseable did embedding a 32-byte Ed25519 key;
// Ed25519 verify of the signature over the event-id bytes under that key.
export function verifySignedReconciliationEvent(event) {
  if (!event || typeof event !== "object") return { ok: false, reason: "not a reconciliation event" };
  if (typeof event.sig !== "string" || event.sig.length === 0)
    return { ok: false, reason: "missing sig — a did-authored reconciliation event must carry a signature over its event id (unsigned did-authorship refuses, fail-closed)" };
  const iv = verifyReconciliationEvent(event);
  if (!iv.ok) return { ok: false, reason: iv.reason };
  return verifySignatureOverId(event.id, event.author, event.sig);
}

// verifyEventAuthorship(event) -> { ok, reason?, signed } — the FAIL-CLOSED
// authorship gate applied by Replica.applyReconciliation: an event whose author is
// a did:key:z string claims proof-of-authorship, so it MUST carry a signature that
// verifies under that did (R6) — a did-authored unsigned event is refused, not
// trusted (v0.2.0's "author is a claim" gap, closed for P8 in v0.6.0). Events with
// a plain-string author pass untouched ({ signed: false }) — byte-for-byte v0.5.0
// backward compatibility.
export function verifyEventAuthorship(event) {
  if (event && typeof event.author === "string" && event.author.startsWith(DID_PREFIX)) {
    const v = verifySignedReconciliationEvent(event);
    return v.ok ? { ok: true, signed: true } : v;
  }
  return { ok: true, signed: false };
}

// The event marker: an ordinary CellDiff whose parents are BOTH branch heads
// (never one) — the DAG node that makes every rec-diff causally after both sides.
export function makeMarker(event, sheet) {
  return makeDiff({
    sheet, cell: markerCellFor(event), op: OP.SET,
    value: { reconciliation: event.id }, prev: null,
    author: event.author, ts: event.ts, parents: [...event.parents],
  });
}

// lastOnCell entries accept a single diff id or an array of ids per cell (Map or
// plain object); normalize to an array of anchor ids.
function anchorsFor(lastOnCell, cell) {
  if (!lastOnCell) return [];
  const v = lastOnCell instanceof Map ? lastOnCell.get(cell) : lastOnCell[cell];
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? [...v] : [v];
}

function setAnchor(lastOnCell, cell, id) {
  if (lastOnCell instanceof Map) lastOnCell.set(cell, id);
  else lastOnCell[cell] = id;
}

// deriveRecDiffs — the RFC P8 §2 emission loop, shared by createReconciliation
// (emitter side: anchors come from the caller's lastOnCell map) and
// Replica.applyReconciliation (applier side: anchors derived from the DAG).
// parentTrees[i] is tree(Hi) as a plain { cell -> value } object (live cells only;
// a missing key = the cell does not exist on that side). Iteration is parent-major,
// cell-sorted — deterministic, so the same (event, trees, anchors) always yields the
// same rec-diff ids. Mutates `lastOnCell` in place (the protocol: every emission
// updates the anchor) so an emitter loop chains its next diffs onto the rec-diffs.
export function deriveRecDiffs({ sheet, event, markerId, parentTrees, lastOnCell }) {
  const asserted = event.asserted_tree;
  const chained = new Map(); // working anchors: cell -> last rec-diff id on the cell
  const recDiffs = [];
  for (let i = 0; i < event.parents.length; i++) {
    const tree = parentTrees[i] ?? {};
    for (const cell of Object.keys(asserted).filter((c) => !c.startsWith("_")).sort()) {
      const a = asserted[cell];
      const has = Object.prototype.hasOwnProperty.call(tree, cell);
      const t = has ? tree[cell] : undefined;
      let op, value;
      if (a === ABSENT) {
        if (!has) continue; // the parent already lacks the cell: nothing is asserted
        op = OP.REMOVE;
        value = undefined;
      } else {
        if (has && canonicalize(t) === canonicalize(a)) continue; // agrees: nothing asserted
        op = OP.SET;
        value = a;
      }
      // parents = [rep(R), last-diff-on-c]: the working chain anchor if this cell
      // already emitted a rec-diff in THIS event, else the caller/DAG's chain tail(s).
      const prior = chained.get(cell) ?? anchorsFor(lastOnCell, cell);
      const d = makeDiff({
        sheet, cell, op, value,
        prev: has ? (t ?? null) : null, // prev = the value on THIS parent's side
        author: event.author, ts: event.ts,
        parents: [markerId, ...prior],
      });
      recDiffs.push(d);
      chained.set(cell, d.id); // tombstone-head invariant: EVERY emission updates the anchor
    }
  }
  if (lastOnCell) for (const [cell, id] of chained) setAnchor(lastOnCell, cell, id);
  return recDiffs;
}

// createReconciliation — the emitter-side entry point.
//   parents      : both/all branch head diff ids being reconciled (never one)
//   assertedTree : { cell -> value | ABSENT } — the resolver's agreed tree (delta
//                  semantics: keys present are asserted; keys missing are unchecked)
//   lastOnCell   : the emitter's per-cell anchor map (Map or object; id or id array
//                  per cell) — UPDATED IN PLACE per the emission protocol
//   parentTrees  : optional array aligned with parents, tree(Hi) each. GIVEN: the
//                  rec-diffs are materialized here (one per differing cell per
//                  parent — the RFC's diff-tree(Hi, R) made explicit). OMITTED: the
//                  event + marker are returned and rec-diff derivation is deferred
//                  to application time (Replica.applyReconciliation derives the
//                  parent trees from the DAG or accepts opts.parentTrees).
//   author, ts   : the resolver's identity and time (as in CellDiff; the author of
//                  record is the resolver — if author is a did:key:z string the event
//                  MUST be signed (pass privateKey) or no replica will apply it:
//                  applyReconciliation's authorship gate refuses did-authored
//                  unsigned events, fail-closed (v0.6.0)
//   privateKey   : optional Ed25519 private key (node:crypto KeyObject). GIVEN:
//                  author must equal the key's did and the returned event carries a
//                  `sig` over its id; if parentTrees are also given, the materialized
//                  marker + rec-diffs are signed too (they keep the same ids — sig is
//                  an overlay — so they survive the P6 receive gate of signed sheets
//                  in transport). OMITTED: unsigned event (fine for plain-string
//                  authors; refused at application for did authors).
//   sheet        : sheet name for the marker + rec-diffs
export function createReconciliation({ parents, assertedTree, lastOnCell, parentTrees, author, ts, sheet = "default", privateKey }) {
  let event = makeReconciliationEvent({ parents, assertedTree, author, ts });
  if (privateKey !== undefined) event = signReconciliationEvent(event, privateKey);
  const marker = makeMarker(event, sheet);
  let recDiffs = [];
  if (parentTrees !== undefined) {
    if (!Array.isArray(parentTrees) || parentTrees.length !== event.parents.length)
      throw new TypeError("parentTrees must be an array aligned with parents (tree(Hi) per parent) — omit it to defer rec-diff derivation to application time");
    recDiffs = deriveRecDiffs({ sheet, event, markerId: marker.id, parentTrees, lastOnCell });
    if (privateKey !== undefined) {
      // Transport-hardened materialization: same ids, plus per-diff signatures so a
      // signed sheet's P6 receive gate accepts them. (signDiff re-checks author==did
      // and id integrity per diff — defense in depth.)
      return { event, marker: signDiff(marker, privateKey), recDiffs: recDiffs.map((d) => signDiff(d, privateKey)) };
    }
  }
  return { event, marker, recDiffs };
}
