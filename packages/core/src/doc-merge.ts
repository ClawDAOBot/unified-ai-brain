/**
 * Pure merge-decision primitives for incoming remote heads.
 *
 * Stage 5d (task #463 by sentinel_01, HB#552): the orchestrator
 * `fetchAndMergeRemoteHead` in poa-cli/src/lib/brain.ts is ~270 LoC
 * mixing bitswap fetch, envelope parse/verify, disjoint-history
 * detection, merge classification, and block/manifest writes. This
 * file extracts ONLY the pure-function pieces (no I/O, no network,
 * no filesystem) so they can be unit-tested in isolation + composed
 * by downstream wiring.
 *
 * Public primitives:
 *   detectDisjointHistories — zero-overlap = silent-data-loss risk
 *   classifyMergeHeads     — local-ahead / remote-ahead / divergent
 *
 * Rationale for split: Automerge.merge() silently drops content when
 * two docs have disjoint histories (no shared root change hash). Task
 * #350 (HB#335) codified this as a fundamental Automerge property —
 * not a bug, but a constraint callers MUST enforce. The detection is
 * pure set-overlap arithmetic and has nothing to do with I/O. Lifting
 * it into core makes it reusable from test harnesses, doctor tools,
 * and future batch migration scripts.
 */

// ────────────────────────────────────────────────────────────
// Automerge interface — minimal surface merge path depends on
// ────────────────────────────────────────────────────────────

export interface AutomergeMergeLike {
  merge(a: any, b: any): any;
  getAllChanges(doc: any): Uint8Array[];
  decodeChange(c: Uint8Array): { hash: string };
  getHeads(doc: any): string[];
}

// ────────────────────────────────────────────────────────────
// Disjoint-history detection
// ────────────────────────────────────────────────────────────

export interface DisjointHistoryResult {
  /** True if the two docs have zero overlap in change hashes AND both have >0 changes. */
  disjoint: boolean;
  localChangeCount: number;
  remoteChangeCount: number;
}

/**
 * Detect whether two Automerge docs share NO common change hashes.
 *
 * Task #350 (HB#335): Automerge.merge and Automerge.applyChanges both
 * silently drop remote content when the two docs do not share a fork
 * ancestor — confirmed empirically in HB#335 dogfood. This is a
 * fundamental Automerge property: docs must share a root initialized
 * via the same from()/init() call for cross-doc operations to work.
 *
 * Returns `disjoint: true` only when BOTH docs have >0 changes AND
 * zero change hashes overlap. An empty local doc or an empty remote
 * doc → `disjoint: false` (the empty side is a no-op to merge).
 *
 * Pure — no I/O. Safe to call without initializing a daemon.
 */
export function detectDisjointHistories(
  localDoc: any,
  remoteDoc: any,
  Automerge: AutomergeMergeLike,
): DisjointHistoryResult {
  const localChanges = Automerge.getAllChanges(localDoc);
  const remoteChanges = Automerge.getAllChanges(remoteDoc);

  if (localChanges.length === 0 || remoteChanges.length === 0) {
    return {
      disjoint: false,
      localChangeCount: localChanges.length,
      remoteChangeCount: remoteChanges.length,
    };
  }

  const localHashes = new Set<string>();
  for (const c of localChanges) {
    localHashes.add(Automerge.decodeChange(c).hash);
  }

  for (const c of remoteChanges) {
    if (localHashes.has(Automerge.decodeChange(c).hash)) {
      return {
        disjoint: false,
        localChangeCount: localChanges.length,
        remoteChangeCount: remoteChanges.length,
      };
    }
  }

  return {
    disjoint: true,
    localChangeCount: localChanges.length,
    remoteChangeCount: remoteChanges.length,
  };
}

// ────────────────────────────────────────────────────────────
// Merge head classification
// ────────────────────────────────────────────────────────────

export type MergeClassification =
  /** Remote adds nothing new — it's an ancestor (or equal). Local manifest unchanged. */
  | 'local-ahead'
  /** Local is an ancestor of remote — fast-forward to remote. */
  | 'remote-ahead'
  /** Both sides had unique changes — a true merge (new envelope required). */
  | 'divergent';

/**
 * Classify the relationship between local and remote docs by comparing
 * their post-merge heads to local-only and remote-only heads.
 *
 * Algorithm:
 *   merged = Automerge.merge(local, remote)
 *   if merged.heads === local.heads → remote was an ancestor     → 'local-ahead'
 *   if merged.heads === remote.heads → local was an ancestor     → 'remote-ahead'
 *   else → both sides had unique changes                          → 'divergent'
 *
 * Head comparison uses sorted-array equality because Automerge.getHeads
 * returns hashes in insertion order which can vary across actors.
 *
 * Pure — no I/O. Callers who want the merged doc itself should call
 * Automerge.merge(local, remote) separately; this function only
 * answers the classification question.
 *
 * PRECONDITION: caller MUST first verify via detectDisjointHistories
 * that the two docs share a common root. Running this function on
 * disjoint-history docs produces incorrect classifications (Automerge
 * silently drops content; heads comparison is meaningless).
 */
export function classifyMergeHeads(
  localDoc: any,
  remoteDoc: any,
  Automerge: AutomergeMergeLike,
): MergeClassification {
  const merged = Automerge.merge(localDoc, remoteDoc);
  const localHeads = Automerge.getHeads(localDoc).slice().sort();
  const remoteHeads = Automerge.getHeads(remoteDoc).slice().sort();
  const mergedHeads = Automerge.getHeads(merged).slice().sort();

  const eq = (a: string[], b: string[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]);

  if (eq(mergedHeads, localHeads)) return 'local-ahead';
  if (eq(mergedHeads, remoteHeads)) return 'remote-ahead';
  return 'divergent';
}
