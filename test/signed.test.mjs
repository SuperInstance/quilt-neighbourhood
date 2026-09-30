// signed.test.mjs — DID-signed diffs (v0.3.0) falsifiable claims.
// Every test states what counts as failure. NC5 is the negative control for the
// documented downgrade risk. Determinism: no Math.random and no pinned key bytes —
// Ed25519 keypairs are generated fresh per run (crypto-grade entropy) and every
// assertion is relational (derived from the generated keys within the same run),
// so the suite is deterministic despite per-run key material.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sign as edSign } from "node:crypto";
import { Replica, merge } from "../src/replica.mjs";
import { canonicalize } from "../src/canonical.mjs";
import { makeDiff } from "../src/diff.mjs";
import {
  generateKeypair, signDiff, verifyDiff, verifySignedDiff,
  base32Encode, base32Decode, didFromPrivateKey, publicKeyFromDid, DID_PREFIX,
} from "../src/signed.mjs";

// S0 — the did:key encoding itself (RFC 4648 base32, no padding).
test("S0: base32 is RFC 4648-exact (no padding, canonical), and the did embeds the public key", () => {
  // RFC 4648 §10 vectors, padding stripped (encoder emits none)
  for (const [bytes, expected] of [
    [Buffer.from(""), ""],
    [Buffer.from("f"), "MY"],
    [Buffer.from("fo"), "MZXQ"],
    [Buffer.from("foo"), "MZXW6"],
    [Buffer.from("foob"), "MZXW6YQ"],
    [Buffer.from("fooba"), "MZXW6YTB"],
    [Buffer.from("foobar"), "MZXW6YTBOI"],
  ]) {
    assert.equal(base32Encode(bytes), expected, `encode(${JSON.stringify(bytes.toString())})`);
    assert.deepEqual([...base32Decode(expected)], [...bytes], `decode(${expected})`);
  }
  // round-trip + strictness
  const raw = Buffer.from([0, 1, 250, 251, 255, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
    200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215]);
  assert.equal(raw.length, 32);
  assert.deepEqual([...base32Decode(base32Encode(raw))], [...raw]);
  assert.throws(() => base32Decode("A"), /impossible unpadded length/, "1-char input is impossible without padding");
  assert.throws(() => base32Decode("ABC1"), /invalid character/, "1 is not in the base32 alphabet");
  assert.throws(() => base32Decode(base32Encode(raw).slice(0, 51) + "B"), /non-canonical|impossible/, "non-canonical tail rejected");
  // did <-> key round-trip: the did carries its own verifying key
  const kp = generateKeypair();
  assert.ok(kp.did.startsWith(DID_PREFIX));
  assert.equal(kp.did.length, DID_PREFIX.length + 52, "32 key bytes -> exactly 52 unpadded base32 chars");
  assert.equal(didFromPrivateKey(kp.privateKey), kp.did, "did derives identically from either half of the keypair");
  assert.deepEqual(publicKeyFromDid(kp.did).export({ type: "spki", format: "der" }),
    kp.publicKey.export({ type: "spki", format: "der" }), "publicKeyFromDid recovers the exact key bytes");
});

// S1 — two signers merge into a signed sheet; sigs verify; revisions stay value-pure.
test("S1: two signers merge into a signed sheet, all diffs verify, and revision matches the unsigned re-run (sig excluded from id)", () => {
  const kp1 = generateKeypair();
  const kp2 = generateKeypair();
  const a = new Replica("a", "s", { schema: { signed: true } });
  const b = new Replica("b", "s", { schema: { signed: true } });
  const d1 = a.set("cell", "v1", { privateKey: kp1.privateKey, ts: 1000 });
  const d2 = b.set("cell2", "v2", { privateKey: kp2.privateKey, ts: 2000 });
  // authorship IS the proof: author field = did of the signing key, sig present
  assert.equal(d1.author, kp1.did);
  assert.equal(d2.author, kp2.did);
  assert.equal(typeof d1.sig, "string");
  assert.equal(typeof d2.sig, "string");
  assert.equal(verifyDiff(d1), true, "signed diff must verify");
  assert.equal(verifyDiff(d2), true);
  assert.equal(a.receive(d1).reason, "known", "locally-written diff is already known (id unchanged by sig)");
  // merge both signers into a signed witness
  const w = new Replica("w", "s", { schema: { signed: true } });
  merge(a, w);
  merge(b, w);
  assert.equal(w.diffCount(), 2);
  assert.equal(w.state().cell, "v1");
  assert.equal(w.state().cell2, "v2");
  assert.ok(w.verifyReceipts());

  // THE PIN: sig is excluded from id/canonical. An unsigned re-run of the same
  // payload (same author dids, ts, parents) yields byte-identical ids and therefore
  // a byte-identical revision — revisions stay value-pure.
  const u1 = makeDiff({ sheet: "s", cell: "cell", op: "set", value: "v1", prev: null, author: kp1.did, ts: 1000, parents: ["GENESIS"] });
  const u2 = makeDiff({ sheet: "s", cell: "cell2", op: "set", value: "v2", prev: null, author: kp2.did, ts: 2000, parents: ["GENESIS"] });
  assert.equal(u1.id, d1.id, "identical payload -> identical id with or without sig");
  assert.equal(u2.id, d2.id, "identical payload -> identical id with or without sig");
  const uw = new Replica("uw", "s"); // UNSIGNED
  assert.equal(uw.receive(u1).accepted, true);
  assert.equal(uw.receive(u2).accepted, true);
  assert.equal(uw.revision(), w.revision(), "signed and unsigned DAGs of the same values share one revision");
  assert.equal(canonicalize(uw.state()), canonicalize(w.state()));
  // and the signed diffs themselves (sig attached) are receivable by unsigned
  // replicas — the overlay does not break identity for v0.3.0 unsigned sheets
  const uw2 = new Replica("uw2", "s");
  assert.equal(uw2.receive(d1).accepted, true);
  assert.equal(uw2.receive(d2).accepted, true);
  assert.equal(uw2.revision(), w.revision());
});

// S2 — forgery is rejected with receipts in a signed sheet.
test("S2: flipped value and cross-key signature are rejected with receipts in a signed sheet", () => {
  const victim = generateKeypair();
  const attacker = generateKeypair();
  const author = new Replica("victim", "s", { schema: { signed: true } });
  const d = author.set("cell", "honest", { privateKey: victim.privateKey, ts: 1000 });
  const guard = new Replica("guard", "s", { schema: { signed: true } });

  // A: value flipped after signing — the stale sig no longer matters, the id breaks
  //    first: receipt kind "reject" (identity broken), the v0.2.0 NC1 taxonomy.
  const flipped = { ...d, value: "tampered" };
  const rA = guard.receive(flipped);
  assert.equal(rA.accepted, false, "value-flipped diff must be rejected");
  assert.match(rA.reason, /id mismatch/);
  assert.equal(guard.receipts.at(-1).kind, "reject");
  assert.equal(guard.diffCount(), 0);

  // B: intact payload (id valid) but the signature is made by a DIFFERENT key while
  //    the author still claims the victim's did — the id gate passes, the signature
  //    gate fails: receipt kind "reject-sig" (identity intact, authorship broken).
  const crossKey = { ...d, sig: edSign(null, Buffer.from(d.id, "hex"), attacker.privateKey).toString("base64") };
  assert.equal(crossKey.id, d.id, "precondition: payload and id untouched");
  const rB = guard.receive(crossKey);
  assert.equal(rB.accepted, false, "cross-key signature must be rejected");
  assert.equal(guard.receipts.at(-1).kind, "reject-sig");
  assert.match(rB.reason, /does not verify/);
  assert.equal(guard.diffCount(), 0);
  // the honest diff still lands, and the chain holds across all rejections
  assert.equal(guard.receive(d).accepted, true);
  assert.equal(guard.state().cell, "honest");
  assert.ok(guard.verifyReceipts());
});

// NC5 — the downgrade asymmetry, receipted honestly instead of hidden.
test("NC5 (documented downgrade): an unsigned sheet accepts the very diffs a signed sheet rejects", () => {
  const victim = generateKeypair();
  const attacker = generateKeypair();
  const signedGuard = new Replica("signed", "s", { schema: { signed: { authors: [victim.did] } } });
  const authorRep = new Replica("victim", "s", { schema: { signed: true } });
  const d = authorRep.set("cell", "honest", { privateKey: victim.privateKey, ts: 1000 });

  // (i) same object, both sheets: cross-key signature -> signed rejects, unsigned accepts.
  const crossKey = { ...d, sig: edSign(null, Buffer.from(d.id, "hex"), attacker.privateKey).toString("base64") };
  assert.equal(signedGuard.receive(crossKey).accepted, false, "signed sheet rejects the forgery");
  const unsigned = new Replica("unsigned", "s"); // v0.2.0 behavior
  assert.equal(unsigned.receive(crossKey).accepted, true,
    "unsigned sheet ACCEPTS the same forgery — it never examines sig (v0.2.0 behavior kept exactly)");
  assert.equal(unsigned.state().cell, "honest", "the forged-but-well-formed diff is IN the unsigned DAG");

  // (ii) attacker authors the diff THEMSELVES and signs it honestly — a valid
  //      signature, but an author the allowlist never admitted.
  const own = makeDiff({ sheet: "s", cell: "injected", op: "set", value: "mine", prev: null, author: attacker.did, ts: 2000, parents: ["GENESIS"] });
  const ownSigned = signDiff(own, attacker.privateKey);
  assert.equal(verifyDiff(ownSigned), true, "precondition: attacker's signature is genuinely valid");
  const r = signedGuard.receive(ownSigned);
  assert.equal(r.accepted, false, "allowlisted signed sheet rejects the validly-signed stranger");
  assert.equal(signedGuard.receipts.at(-1).kind, "reject-sig");
  assert.match(r.reason, /allowlist/);
  const unsigned2 = new Replica("unsigned2", "s");
  assert.equal(unsigned2.receive(ownSigned).accepted, true, "unsigned sheet accepts it — no proof to check, no policy to apply");
  // (iii) and stripped of its sig entirely: an unsigned sheet cannot even tell.
  const stripped = { ...ownSigned };
  delete stripped.sig;
  const unsigned3 = new Replica("unsigned3", "s");
  assert.equal(unsigned3.receive(stripped).accepted, true, "sig-stripped diff is invisible to an unsigned sheet");
  // This asymmetry is the documented downgrade risk (README limitations): signatures
  // protect the sheets that enforce them; v0.2.0 sheets accept anything well-formed.
});

// S3 — the author allowlist.
test("S3: an unknown did is rejected in an allowlisted signed sheet, accepted without allowlist", () => {
  const known = generateKeypair();
  const stranger = generateKeypair();
  const guard = new Replica("guard", "s", { schema: { signed: { authors: [known.did] } } });
  const open = new Replica("open", "s", { schema: { signed: true } });
  const kAuth = new Replica("k", "s", { schema: { signed: true } });
  const sAuth = new Replica("x", "s", { schema: { signed: true } });
  const kDiff = kAuth.set("cell", "known", { privateKey: known.privateKey, ts: 1000 });
  const sDiff = sAuth.set("cell", "stranger", { privateKey: stranger.privateKey, ts: 2000 });
  assert.equal(verifyDiff(sDiff), true, "precondition: the stranger's diff is validly signed");
  // allowlisted sheet: known author accepted, validly-signed stranger rejected
  assert.equal(guard.receive(kDiff).accepted, true);
  const r = guard.receive(sDiff);
  assert.equal(r.accepted, false, "valid signature from an unknown did must be rejected under an allowlist");
  assert.equal(guard.receipts.at(-1).kind, "reject-sig");
  assert.match(r.reason, /allowlist/);
  assert.equal(guard.diffCount(), 1);
  assert.equal(guard.state().cell, "known");
  // same stranger diff, sheet WITHOUT allowlist: accepted — a valid signature proves
  // the stranger's OWN authorship; the allowlist is the policy layer above the proof
  assert.equal(open.receive(sDiff).accepted, true);
  assert.equal(open.state().cell, "stranger");
  // an UNSIGNED diff in an allowlisted sheet is rejected too (sig missing) — a fresh
  // diff (guard must not know it, or the idempotent "known" no-op fires first)
  const kDiff2 = kAuth.set("cell2", "known-two", { privateKey: known.privateKey, ts: 3000 });
  const bare = { ...kDiff2 };
  delete bare.sig;
  const r2 = guard.receive(bare);
  assert.equal(r2.accepted, false);
  assert.match(r2.reason, /missing sig/);
  assert.equal(guard.receipts.at(-1).kind, "reject-sig");
});

// S4 — the signature covers the id: any field tamper fails verification.
test("S4: tampering ANY field after signing fails verification and is rejected", () => {
  const kp = generateKeypair();
  const author = new Replica("a", "s", { schema: { signed: true } });
  const d = author.set("cell", "v", { privateKey: kp.privateKey, ts: 1000, parents: undefined });
  const guard = new Replica("g", "s", { schema: { signed: true } });
  const strangers = [generateKeypair(), generateKeypair()]; // stable tamper targets
  const tampers = {
    value: (x) => ({ ...x, value: "evil" }),
    author: (x) => ({ ...x, author: strangers[0].did }),
    ts: (x) => ({ ...x, ts: 999999 }),
    prev: (x) => ({ ...x, prev: "fabricated-prev" }),
    parents: (x) => ({ ...x, parents: [strangers[1].did] }),
  };
  for (const [field, mutate] of Object.entries(tampers)) {
    const t = mutate(d);
    assert.equal(verifyDiff(t), false, `tampered ${field} must fail verifyDiff`);
    assert.equal(verifySignedDiff(t).ok, false, `tampered ${field} must fail verifySignedDiff`);
    const res = guard.receive(t);
    assert.equal(res.accepted, false, `tampered ${field} must be rejected on receive`);
    assert.equal(guard.diffCount(), 0, `tampered ${field} must not enter the DAG`);
    assert.equal(guard.receipts.at(-1).kind, "reject", `tampered ${field}: id gate receipts as "reject"`);
  }
  // THE LOAD-BEARING CASE: tamper + recompute the id (self-consistent forgery) but
  // keep the stale signature. The id gate alone would ACCEPT this; the signature is
  // what rejects it — this is authorship-as-proof, not just a content hash.
  const reIDed = makeDiff({ sheet: d.sheet, cell: d.cell, op: d.op, value: "evil", prev: d.prev, author: d.author, ts: d.ts, parents: d.parents });
  const stale = { ...reIDed, sig: d.sig };
  assert.equal(stale.id !== d.id, true, "precondition: the forged id is self-consistent with the forged payload");
  assert.equal(verifyDiff(stale), false);
  const res = guard.receive(stale);
  assert.equal(res.accepted, false, "self-consistent forgery with a stale sig must be rejected by the signature");
  assert.equal(guard.receipts.at(-1).kind, "reject-sig");
  assert.match(res.reason, /does not verify/);
  // honest diff still lands; chain intact across every rejection
  assert.equal(guard.receive(d).accepted, true);
  assert.equal(guard.state().cell, "v");
  assert.ok(guard.verifyReceipts());
});
