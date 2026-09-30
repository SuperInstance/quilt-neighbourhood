// diff.mjs — CellDiff: the atom of a neighbourhood.
// A diff names one sheet cell, one operation, the value it claims, the prior value it
// observed (prev), its author, a timestamp, and its PARENTS: the diff ids it had seen
// when it was made. parents make the log a DAG, not a line — two replicas that diverge
// produce siblings, and a merge is just a diff (or fold) whose parents are both heads.
//
// Identity is content-addressed: id = sha256(canonical(diff-without-id)). Any tampering
// with any field breaks the id, and every replica rejects it on sight (NC1).
//
// v0.3.0 (signed diffs): a diff may carry a `sig` (see signed.mjs). `sig` is an
// OVERLAY — it is excluded from id/canonical computation below, so identity stays
// value-pure: signing, stripping, or re-signing a diff never changes its id, and
// revisions (hashes of head ids) are unaffected by signatures. The id is computed
// BEFORE signing; sig covers the 32-byte id buffer.
import { canonicalSha } from "./canonical.mjs";

export const GENESIS = "GENESIS";
export const OP = { SET: "set", REMOVE: "remove" };

export function makeDiff({ sheet, cell, op, value, prev, author, ts, parents, sig }) {
  if (sig !== undefined)
    throw new Error("makeDiff does not accept sig — ids are computed unsigned; sign the finished diff with signDiff (signed.mjs)");
  if (!sheet || !cell) throw new Error("diff requires sheet and cell");
  if (op !== OP.SET && op !== OP.DELETE && op !== OP.REMOVE)
    throw new Error(`unknown op ${op}`);
  if (op === OP.REMOVE && value !== undefined)
    throw new Error("remove carries no value");
  if (!parents || parents.length === 0) throw new Error("diff requires >=1 parent");
  const d = { sheet, cell, op, value, prev: prev ?? null, author, ts, parents: [...parents] };
  d.id = canonicalSha({ ...d });
  return d;
}

// Local convenience: a replica builds diffs whose parents are its current heads.
export function verifyDiff(d) {
  const { id, sig, ...rest } = d; // sig is an overlay (v0.3.0): excluded from identity
  if (!id) return { ok: false, reason: "no id" };
  const expect = canonicalSha(rest);
  if (expect !== id) return { ok: false, reason: `id mismatch: got ${id.slice(0, 12)} want ${expect.slice(0, 12)}` };
  return { ok: true };
}
