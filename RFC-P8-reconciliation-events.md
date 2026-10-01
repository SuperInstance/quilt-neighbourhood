# RFC P8 — Reconciliation events in the CellDiff DAG

**Status:** draft (wave-72) · **Seed implementation:** `scripts/w71_dag_replay.mjs` (wave-71, all three corpora converged == git HEAD) · **Guards:** TH1–TH6 (tombstone-head invariant), T1–T10 (P1–P5 unchanged)

---

## 1. Motivation

A merge commit's tree can differ from **both** of its parents. The resolver (a human, or git's merge machinery, or a future quilt merge tool) produced content that exists in **no** single parent and in **no** single commit on either branch. That content is a fact about the history — replayed HEAD must contain it — but it is **not derivable from the diff streams**: every raw diff record in the two branch histories describes one parent's side; nothing in them names the resolved third value, and no fold policy (P1–P5 operate per *cell*, and a file is one cell) is licensed to synthesize one.

Wave-71 hit this from the failure side, five iterations deep, replaying three git histories through a CellDiff DAG fold (`scripts/w71_dag_replay.mjs`). Two of the honest failures:

- **Iteration 4** — merge commits emit no raw diff records by default, so a fold of per-commit diff streams silently keeps branch-side content the merge had *dropped*: dropped files stayed live forever.
- **The general form** — when both branches touched the same cell, the resolver's choice is a *third value*. Folding the two streams in either order yields one branch's value or the other's — never the merge tree.

The fix of record in wave-71: **git merges are reconciliation events** — the merge tree is *asserted* against each parent, and the assertions enter the DAG as first-class diffs. With that (plus the tombstone-head invariant, TH1–TH6), the replays reconstructed all three histories exactly: papermill 248 == 248 (zero merges — the control), synesis 506 == 506 (one commit), animal-ai 1,017 == 1,017 (45 merges → 13,062 rec-diffs).

P8 promotes that fix from a replay-script trick to a specified event class.

## 2. The event

A **reconciliation event** R is emitted when a resolver has produced an agreed tree `T` from two (or more) branch heads `H1, H2`. Canonical schema:

```
Reconciliation {
  type:          "reconciliation",
  parents:       [H1, H2],        // BOTH branch heads being reconciled — never one
  asserted_tree: { cell -> value | ABSENT, ... },   // the resolver's tree (complete or delta)
  author, ts, id                    // as in CellDiff; id = sha256(canonical(...))
}
```

**CellDiff mapping.** A CellDiff names one cell, so a reconciliation over k differing cells is materialized as **one event marker + k rec-diffs**:

- **Event marker** `rep(R)`: a diff whose `parents` are the rep-diffs of *both* branch heads. In the seed implementation it is a `set` on a bookkeeping cell (`_commit/<sha8>` carrying the merge's topology); its two parents are what make everything hanging off it *causally after both heads*.
- **Rec-diff** `R→Hi(c)`: for every cell `c` where `T[c]` differs from `tree(Hi)[c]`, one ordinary CellDiff (`set` with the asserted value, or `remove` asserting absence), `prev` = the value `c` had on the *Hi* side, parents = `[rep(R), last-diff-on-c]`.

`asserted_tree` in the canonical schema corresponds to the *union* of per-parent assertions: `R→H1(c)` and `R→H2(c)` carry the same asserted value for `c` but different `prev` — each side's prior state is recorded against that side. A cell on which `T` agrees with a parent gets **no rec-diff against that parent** (nothing is asserted; the parent already holds it).

**Emission protocol** (the seed's, proven over 13,062 rec-diffs):

```
for each parent Hi of the merge:
    for each (cell c, status, sha) in diff-tree(Hi, R):     # git diff-tree -r --raw --no-renames
        emit rec-diff R→Hi(c):  op = set|remove, value = sha12, parents = [rep(R), lastOnCell(c)]
        lastOnCell(c) = id            # tombstone-head invariant: EVERY event updates the anchor
```

## 3. Fold semantics

**No new conflict policy is needed.** Because `rep(R)` descends from both `H1` and `H2`, every rec-diff is causally after *all* diffs on both branches — including every tombstone. The existing fold already does the right thing:

- **Rec-diff vs branch content:** in topo order the rec-diff arrives after anything on either branch; `ancestors(rec-diff) ⊇ {both heads' histories}` means the "causally after" arm applies the asserted value plainly (the P1 arm of the set/tombstone logic; the plain-set arm of set/value). The resolver's assertion wins over the branch values *because it is causally after them*, not because of a new authority rule.
- **Rec-diff vs tombstones:** the tombstone-head invariant (v0.4.1, `src/replica.mjs` `state()`) requires a set to dominate **all** live tombstone anchors to resurrect. A rec-diff dominating one branch's tombstone while concurrent with another branch's would be buried by P2 — correctly, for concurrent *unreconciled* writes; a reconciliation event is by construction after both heads, so it dominates every tombstone in the reconciled region and resurrects/keeps-deletes exactly as `asserted_tree` says.
- **Writes AFTER the reconciliation:** ordinary diffs that are causally after `rep(R)` are ordinary P1–P5 cases. P8 grants no standing authority — a later honest write beats the reconciliation like it beats any other ancestor.

Determinism is preserved: rec-diffs are content-addressed diffs like any other; two replicas that know the same DAG fold to the same bytes (T2/TH6).

## 4. Relation to P1–P5

P8 is an **emission-layer event class, not a sixth conflict policy**. The boundary is who did the reconciling:

| | P1–P5 (fold policies) | P8 (reconciliation events) |
|---|---|---|
| Who resolves | the fold itself, deterministically, from DAG shape | a resolver **before** emission (human, git, merge tool) |
| Input | concurrent diffs, no agreed tree | an agreed tree `T` the fold could never derive |
| Authority | none — id tiebreaks (P3) are content-addressed luck | the assertion is data; it wins via causality, once |
| Failure if absent | concurrent sets resolve to *one branch's* value; dropped branch-side content stays live | — (wave-71 iteration 4 + the raycastparser case) |

P8 and P2 do not disagree: a set that is *genuinely concurrent* with a tombstone (the emitter never saw the delete) is still buried — TH2 pins that. P8 only covers the case where a resolver has *already* seen both sides and spoken.

## 5. Worked example (real git, animal-ai corpus)

Merge `0ec71be` — *"Merge branch 'ImproveRaycaster.py' of https://github.com/Kinds-of-Intelligence-CFI/animal-ai into ImproveRaycaster.py"* (same branch name on both sides; fork author merging upstream's branch), parents:

```
P1 = 48a3026  (2023-09-08 18:31 UTC+1)
P2 = 64c6971  (2023-09-07 20:01 UTC-7)
```

`git diff-tree` against **each** parent:

- vs **P1**: 10 paths — `D agents/basicBraitenberg.py`, `A agents/goToGoodBraitenberg.py`, 8 × `M` (incl. `animalai/animalai/envs/raycastparser.py`)
- vs **P2**: 1 path — `M animalai/animalai/envs/raycastparser.py`

The criss-cross cell, `raycastparser.py` — three distinct blobs:

```
blob(P1) = dc1306c5f8a8d652bfc7adc6bfe6a9f346d86ac7
blob(P2) = 91320f61a40346965689620c3225ec0cc7886573
blob(M)  = 19d3b98e6ceb544b554278d6edceb24831a0968b
```

What the merge tree holds relative to each parent:

- **vs P1** it adds P2's dict-handling (`if isinstance(raycast, dict): raycast = raycast['rays']` in `parse`/`prettyPrint`);
- **vs P2** it adds P1's `# Test 6: Mix of objects detected and not detected, including PILLARBUTTON` block.

Neither parent's diff stream contains the other's content; the merge tree (P1's Test 6 **and** P2's dict-handling, in one blob) exists in **no commit on either branch**. P3 would elect one parent's blob by id lottery; no P1–P5 rule may combine them. Only an assertion reproduces git's tree.

Under P8 this merge emits **11 rec-diffs** (10 against P1 + 1 against P2; `raycastparser.py` asserted against both, with each side's `prev`). Across animal-ai's 45 merges: **13,062 rec-diffs**, and the replay's P1–P5 fold over the full stream lands byte-exact on HEAD: **1,017 == 1,017** paths. The control: papermill has **0 merges** and needed **0** rec-diffs — pure diff-stream fold, 248 == 248.

## 6. Open questions

1. **Partial knowledge.** May a replica apply `R→H1(c)` before it knows `H2`? The seed folded whole histories; incremental federation needs a rule (rec-diffs reference `rep(R)`, which references both heads — the DAG gates application today).
2. **Signature semantics (P6 interplay).** Who is the `author` of a reconciliation — the resolver's did, the merging committer, or both? Should `reject-sig` treat rec-diffs as a distinct class? Unspecified in the seed (replays ran unsigned).
3. **Tombstone assertions.** `remove` rec-diffs assert absence against one parent while the other side may have never seen the cell. The seed emits the remove against whichever parent's tree contains it; a cleaner per-side `ABSENT` marker in `asserted_tree` is undecided.
4. **Granularity.** Cell = file (whole blob) makes rec-diff counts small but P8 inherits file-level coarseness (the README's "coarser than a full OR-Set" limitation). Cell = hunk multiplies rec-diffs by ~10–100×. No recommendation.
5. **Authority vs freshness.** A reconciliation is a one-time assertion through causality. A malformed or malicious resolver can assert a wrong tree that later writes must then beat through ordinary P1–P5 paths — the same trust git itself places in the committer. Whether quilt needs a receipt kind for "reconciliation overridden by later write" is open.
6. **Chained reconciliations.** Merge-of-merge (R whose parents include an earlier R) worked in the corpus (45 merges, some nested), but a formal statement of composing assertions is future work.

## 7. Receipt

- Seed: `scripts/w71_dag_replay.mjs` — papermill 359 diffs → 248 == 248; synesis 507 → 506 == 506; animal-ai 37,523 diffs (13,062 rec-diffs) → 1,017 == 1,017. Receipt: `scripts/w71_dag_out.json`.
- Fold-side invariant guarding rec-diff application: tombstone-head, `test/tombstone-head.test.mjs` TH1–TH6 (v0.4.1).
