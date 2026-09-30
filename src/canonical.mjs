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
