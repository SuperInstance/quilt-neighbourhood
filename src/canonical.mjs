// canonical.mjs — deterministic serialization + hashing.
// Every diff id and revision in a neighbourhood is a function of canonical bytes only,
// so two replicas that never meet still agree bit-for-bit on identity.
import { createHash } from "node:crypto";

// Canonical JSON: object keys sorted recursively, arrays in order, no whitespace.
// undefined-valued object keys are dropped (so {a:1, b:undefined} === {a:1}).
export function canonicalize(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  const keys = Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(v[k])).join(",") + "}";
}

export function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

export function canonicalSha(v) {
  return sha256(canonicalize(v));
}

// ---------- P5 numeric canonicalization (v0.2.0) ----------
// float64Hex(v): the exact IEEE-754 bit pattern of a JS double, big-endian, as 16
// hex chars. This is the *witness* encoding for numeric merges: unlike JSON's
// shortest-round-trip repr it distinguishes -0 from 0 ("8000000000000000" vs
// "0000000000000000") and shows NaN/Infinity payloads instead of collapsing them
// to null. Byte-identity claims about P5 merges are checked through this encoding.
// Note on the existing canonicalize() for numbers: ECMA-262 Number::toString is a
// fully-specified shortest-round-trip representation, so canonical bytes are
// deterministic for a given double on every engine; the known coarsening is -0 -> "0"
// at the identity level (accepted), and non-finite doubles are rejected at numeric
// write/receive time before they can reach canonicalize (see replica.mjs).
export function float64Hex(v) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, v, false); // big-endian
  let s = "";
  for (let i = 0; i < 8; i++) s += view.getUint8(i).toString(16).padStart(2, "0");
  return s;
}

// numericValueHex(v): bit-level canonical form of a numeric cell value — a scalar
// becomes one float64 hex word, an array becomes the concatenation of its elements'
// words; non-numeric values fall back to canonical JSON bytes.
export function numericValueHex(v) {
  if (typeof v === "number") return float64Hex(v);
  if (Array.isArray(v)) return "[" + v.map(float64Hex).join(",") + "]";
  return canonicalize(v);
}
