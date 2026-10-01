// signed.mjs — DID-signed diffs (v0.3.0): authorship becomes proof.
//
// v0.2.0's honest limitation was that `author` is a CLAIM, not a proof — anyone can
// write any author string into a diff and the id (a hash of the payload) will verify
// it faithfully. This module closes that gap, composition-style: canonical.mjs is
// untouched, diff.mjs gains only a documented sig-strip (see below), and every
// cryptographic decision lives here.
//
// ---- DID FORMAT (precise) -------------------------------------------------
//   did = "did:key:z" + base32(raw 32-byte Ed25519 public key)
//   - base32 = RFC 4648 alphabet "A-Z2-7", NO padding, canonical (zero) trailing
//     bits, uppercase. 32 key bytes -> 256 bits -> 52 chars (padding would add 4 '=').
//   - The did EMBEDS the public key bytes deterministically: publicKeyFromDid(did)
//     recovers the exact Ed25519 key, so a signature can be verified from the did
//     alone. `did:key:z...` is the coasys/AD4M did:key *pattern* (a did whose
//     identifier IS the public key); the concrete multibase encoding here is a
//     study-local choice — the W3C did:key spec for ed25519 uses base58btc of the
//     multicodec-prefixed key (0xed 0x01 || raw). We chose standard base32 because
//     it is ~30 lines, dependency-free, and case/canonicality-checkable; this flavor
//     is NOT interoperable with W3C did:key strings. Documented, deliberate.
//
// ---- WHAT IS SIGNED (precise) ---------------------------------------------
//   sig = base64( Ed25519.Sign( sha256_digest_bytes_of_canonical(diff-without-sig) ) )
//   The diff id already IS sha256(canonical(diff-without-id)), and `sig` is excluded
//   from id/canonical computation (diff.mjs strips it), so "diff-without-sig" hashes
//   to diff.id — meaning: **sig covers the 32 raw bytes of the diff id**
//   (Buffer.from(diff.id, "hex")). We sign the id, not the canonical text, because
//   the id is the content address every replica already agrees on; the signature is
//   therefore an attestation over identity itself. Consequences, both deliberate:
//     - `sig` is an OVERLAY: adding/stripping/re-signing never changes the id, so
//       revisions (sha256 of head ids) stay value-pure — a signed sheet and an
//       unsigned re-run with the same values have byte-identical revisions (S1).
//     - Tampering ANY id-covered field (sheet, cell, op, value, prev, author, ts,
//       parents) invalidates the id AND the signature; recomputing the id without
//       re-signing produces a self-consistent forgery that the id check alone would
//       accept but the signature rejects (S4) — this is the proof-of-authorship.
// ---- SHEET ENFORCEMENT (precise) ------------------------------------------
//   A replica registered `signed: true` requires every accepted diff to carry a valid
//   `sig`; `signed: { authors: [did, ...] }` additionally pins the author allowlist.
//   Failures are receipted with the dedicated kind "reject-sig" (missing/malformed
//   sig, did that does not parse, signature that does not verify, author not on the
//   allowlist). Id-integrity failures (tampered payload, stale id) keep receipting
//   as "reject" exactly as in v0.2.0 — the id check is cheaper and fires first.
//   Unsigned sheets keep v0.2.0 behavior byte-for-byte: they never look at `sig`.
import { generateKeyPairSync, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { verifyDiff as verifyDiffId } from "./diff.mjs";

export const DID_PREFIX = "did:key:z";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648 base32 alphabet
// DER SPKI header for an Ed25519 public key: the 12-byte prefix that wraps the raw
// 32-byte key point in SubjectPublicKeyInfo (OID 1.3.101.112).
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const RAW_KEY_LEN = 32;

// ---------- base32 (RFC 4648, no padding, canonical) ----------
// Encode: 5-byte groups -> 8 chars; a final partial group is zero-padded on the
// right (canonical trailing bits are zero). 32 bytes -> 52 chars.
export function base32Encode(buf) {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]; // zero-padded tail
  return out;
}

// Decode: strict — uppercase-or-lowercase alphabet, canonical (zero) trailing bits,
// no '=' padding accepted. Lengths mod 8 of 1, 3, or 6 chars are impossible without
// padding and are rejected.
export function base32Decode(s) {
  if (typeof s !== "string") throw new Error("base32Decode: input must be a string");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of s.toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error(`base32Decode: invalid character ${JSON.stringify(ch)}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bits >= 5) throw new Error(`base32Decode: impossible unpadded length ${s.length}`);
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0)
    throw new Error("base32Decode: non-canonical trailing bits");
  return Buffer.from(bytes);
}

// ---------- key <-> did ----------
// Raw 32-byte public key point from an Ed25519 KeyObject (SPKI DER, key at the tail).
export function rawPublicKeyBytes(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  if (der.length !== SPKI_ED25519_PREFIX.length + RAW_KEY_LEN || !der.subarray(0, 12).equals(SPKI_ED25519_PREFIX))
    throw new Error("rawPublicKeyBytes: not an Ed25519 SPKI public key");
  return der.subarray(12);
}

export function didFromPublicKey(publicKey) {
  return DID_PREFIX + base32Encode(rawPublicKeyBytes(publicKey));
}

export function didFromPrivateKey(privateKey) {
  return didFromPublicKey(createPublicKey(privateKey));
}

// Recover the verifying key from the did alone — this is what makes authorship a
// proof: the did carries its own public key.
export function publicKeyFromDid(did) {
  if (typeof did !== "string" || !did.startsWith(DID_PREFIX))
    throw new Error(`not a ${DID_PREFIX} did`);
  const raw = base32Decode(did.slice(DID_PREFIX.length));
  if (raw.length !== RAW_KEY_LEN)
    throw new Error(`did key material must be ${RAW_KEY_LEN} bytes, got ${raw.length}`);
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

// ---------- id-signature primitives (shared with reconciliation events, v0.6.0) ----------
// signId(idHex, privateKey) -> base64 Ed25519 signature over a 32-byte hex id buffer.
// This is exactly what signDiff does for diffs (sig covers the diff id); v0.6.0 exposes
// it so reconciliation events can carry the same attestation over their own id.
export function signId(idHex, privateKey) {
  const buf = Buffer.from(idHex, "hex");
  if (buf.length !== 32) throw new Error(`signId: id must be a 32-byte sha256 hex, got ${buf.length} bytes`);
  return edSign(null, buf, privateKey).toString("base64");
}

// verifySignatureOverId(idHex, did, sig) -> { ok, reason } — the crypto core shared by
// diff and event signature verification: did parses to an embedded Ed25519 key, sig is
// canonical base64 of exactly 64 bytes, and Ed25519 verifies over the id buffer.
export function verifySignatureOverId(idHex, did, sig) {
  if (typeof sig !== "string" || sig.length === 0)
    return { ok: false, reason: "missing sig" };
  if (typeof did !== "string" || !did.startsWith(DID_PREFIX))
    return { ok: false, reason: `author is not a ${DID_PREFIX} did` };
  let pub;
  try {
    pub = publicKeyFromDid(did);
  } catch (e) {
    return { ok: false, reason: `malformed did: ${e.message}` };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sig) || sig.length % 4 !== 0)
    return { ok: false, reason: "malformed sig: not canonical base64" };
  const sigBuf = Buffer.from(sig, "base64");
  if (sigBuf.length !== 64)
    return { ok: false, reason: `malformed sig: Ed25519 signature must be 64 bytes, got ${sigBuf.length}` };
  let idBuf;
  try {
    idBuf = Buffer.from(idHex, "hex");
  } catch {
    return { ok: false, reason: "malformed id: not hex" };
  }
  if (idBuf.length !== 32)
    return { ok: false, reason: `id must be a 32-byte sha256 hex, got ${idBuf.length} bytes` };
  const ok = edVerify(null, idBuf, pub, sigBuf);
  return ok
    ? { ok: true }
    : { ok: false, reason: "signature does not verify under the author did's embedded public key" };
}

// generateKeypair() -> { did, publicKey, privateKey }.
// publicKey/privateKey are node:crypto KeyObjects (pass privateKey to signDiff).
// Key generation uses crypto-grade entropy; the suite's determinism discipline
// (no Math.random) is about assertions, and no test pins key bytes — every signed
// test is relational (derived from the generated keys within one run).
export function generateKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { did: didFromPublicKey(publicKey), publicKey, privateKey };
}

// ---------- sign / verify ----------
// signDiff(diff, privateKey) -> a NEW diff with a `sig` field.
//   sig = base64(Ed25519 signature over the 32-byte diff-id buffer).
// Refuses to sign if diff.author is not exactly the did of privateKey (authorship
// must BE the proof, not a free-form label) or if the id does not match the payload.
// `sig` is an overlay: it is excluded from id/canonical computation, so signing
// never changes the id and revisions stay value-pure.
export function signDiff(diff, privateKey) {
  const did = didFromPrivateKey(privateKey);
  if (diff.author !== did)
    throw new Error(`signDiff: diff.author (${diff.author}) is not the signing key's did (${did}) — set author = did, authorship must be the proof`);
  if (diff.sig !== undefined)
    throw new Error("signDiff: diff already carries a sig — sign a fresh diff, do not re-sign over an existing signature");
  const v = verifyDiffId(diff);
  if (!v.ok) throw new Error(`signDiff: refusing to sign a diff whose id does not match its payload (${v.reason})`);
  const sig = edSign(null, Buffer.from(diff.id, "hex"), privateKey);
  return { ...diff, sig: sig.toString("base64") };
}

// verifySignedDiff(diff) -> { ok, reason } — the detailed variant used for receipts.
// Order of gates (each receipted by the replica as "reject-sig"):
//   1. sig present;
//   2. id integrity: canonical(diff-without-sig-and-id) hashes to diff.id
//      (a self-consistent forgery — payload tampered AND id recomputed — passes
//      this gate and is caught by gate 4);
//   3. author is a parseable did:key:z did embedding a 32-byte Ed25519 key;
//   4. Ed25519 verify of the signature over the 32-byte diff-id bytes against the
//      did's embedded public key.
export function verifySignedDiff(diff) {
  if (!diff || typeof diff !== "object") return { ok: false, reason: "not a diff object" };
  if (typeof diff.sig !== "string" || diff.sig.length === 0)
    return { ok: false, reason: "missing sig — signed sheets require a signature over the diff id" };
  const iv = verifyDiffId(diff);
  if (!iv.ok) return { ok: false, reason: iv.reason };
  if (typeof diff.author !== "string" || !diff.author.startsWith(DID_PREFIX))
    return { ok: false, reason: `author is not a ${DID_PREFIX} did` };
  let pub;
  try {
    pub = publicKeyFromDid(diff.author);
  } catch (e) {
    return { ok: false, reason: `malformed did: ${e.message}` };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(diff.sig) || diff.sig.length % 4 !== 0)
    return { ok: false, reason: "malformed sig: not canonical base64" };
  const sigBuf = Buffer.from(diff.sig, "base64");
  if (sigBuf.length !== 64)
    return { ok: false, reason: `malformed sig: Ed25519 signature must be 64 bytes, got ${sigBuf.length}` };
  const ok = edVerify(null, Buffer.from(diff.id, "hex"), pub, sigBuf);
  return ok
    ? { ok: true }
    : { ok: false, reason: "signature does not verify under the author did's embedded public key" };
}

// verifyDiff(diff) -> boolean — the mission API. True iff the diff is intact AND
// carries a signature valid under its own author did.
export function verifyDiff(diff) {
  return verifySignedDiff(diff).ok;
}

// Sheet-policy layer: `signed` is `true` (any valid signer) or `{ authors: [did...] }`
// (valid signature AND author on the allowlist). The allowlist gate runs AFTER the
// cryptographic one so an unauthorized-but-validly-signed author receipts the precise
// reason "allowlist".
export function verifyDiffForSheet(diff, signed) {
  const v = verifySignedDiff(diff);
  if (!v.ok) return v;
  if (signed && typeof signed === "object" && Array.isArray(signed.authors)) {
    if (!signed.authors.includes(diff.author))
      return { ok: false, reason: `author ${diff.author} is not in the sheet allowlist` };
  }
  return { ok: true };
}
