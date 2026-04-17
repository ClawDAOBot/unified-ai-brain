/**
 * Pure envelope-construction primitives for brain writes.
 *
 * Stage 5c (task #463 by sentinel_01, HB#551): extract the pure parts
 * of applyBrainChange / applyBrainChangeV2 from poa-cli/src/lib/brain.ts
 * into testable functions. The I/O orchestration — CID hashing, block
 * put, manifest update, gossipsub broadcast — stays in the daemon
 * layer / poa-cli wiring and composes over these primitives.
 *
 * Why split: the original applyBrainChange is ~80 LoC mixing Automerge
 * mutation, schema validation, envelope signing, CID computation, block
 * persistence, manifest update, and broadcast. Each concern has its
 * own failure mode + adapter. A single signature can't serve them all
 * cleanly. So core ships the Automerge + signing part; everything
 * I/O-shaped ships as Stage 6 (daemon) or in poa-cli glue.
 *
 * Public primitives:
 *   buildV1Envelope  — Automerge.change + validate + sign → v1 envelope
 *   buildV2Envelope  — Automerge.change + validate + extract delta +
 *                      sign → v2 envelope (+ caller supplies parent
 *                      CIDs + max-parent-priority)
 *
 * Both return the new doc + envelope bytes; caller persists + announces.
 */

import {
  signBrainChange,
  signBrainChangeV2,
  extractDeltaChanges,
  snapshotChangeHashes,
  packChanges,
  type BrainChangeEnvelope,
  type BrainChangeEnvelopeV2,
  type PrivateKey,
} from './signing';
import type { CID, Address } from './doc';

// ────────────────────────────────────────────────────────────
// Automerge interface — minimal surface write path depends on
// ────────────────────────────────────────────────────────────

export interface AutomergeDocWriter {
  change<T>(doc: any, changeFn: (d: T) => void): any;
  save(doc: any): Uint8Array;
  getAllChanges(doc: any): Uint8Array[];
  decodeChange(c: Uint8Array): { hash: string };
}

// ────────────────────────────────────────────────────────────
// Schema validator hook — optional, per-write
// ────────────────────────────────────────────────────────────

export interface ValidationHook {
  (docId: string, doc: any): { ok: boolean; errors: string[] };
}

function runValidator(
  docId: string,
  oldDoc: any,
  newDoc: any,
  validate?: ValidationHook,
  allowInvalidShape?: boolean,
): void {
  if (allowInvalidShape || !validate) return;
  const pre = validate(docId, oldDoc);
  const post = validate(docId, newDoc);
  if (pre.ok && !post.ok) {
    throw new Error(
      `Brain write rejected: schema validation failed for ${docId}\n` +
      post.errors.map(e => `  - ${e}`).join('\n') +
      `\n\nPre-change doc was valid; this change introduces invalid shape(s). ` +
      `Pass allowInvalidShape=true to bypass (strongly discouraged).`,
    );
  }
  // pre invalid + post invalid: inherited bad state, allow through silently.
  // pre invalid + post valid: partial fix, allow through.
}

// ────────────────────────────────────────────────────────────
// v1 — snapshot-per-write envelope builder
// ────────────────────────────────────────────────────────────

export interface BuildV1EnvelopeInput<T = any> {
  docId: string;
  oldDoc: any;
  changeFn: (doc: T) => void;
  key: PrivateKey;
  Automerge: AutomergeDocWriter;
  validate?: ValidationHook;
  allowInvalidShape?: boolean;
}

export interface BuildV1EnvelopeResult<T = any> {
  envelope: BrainChangeEnvelope;
  envelopeBytes: Uint8Array;
  newDoc: T;
  author: Address;
}

/**
 * Apply a change to an Automerge doc, run schema validation, sign
 * a v1 envelope. Caller persists the envelope bytes as an IPLD block
 * and updates the heads manifest.
 *
 * Pure modulo the PrivateKey.signMessage call (network-free).
 */
export async function buildV1Envelope<T = any>(
  input: BuildV1EnvelopeInput<T>,
): Promise<BuildV1EnvelopeResult<T>> {
  const { docId, oldDoc, changeFn, key, Automerge, validate, allowInvalidShape } = input;

  const newDoc = Automerge.change<T>(oldDoc, changeFn);
  runValidator(docId, oldDoc, newDoc, validate, allowInvalidShape);

  const automergeBytes = Automerge.save(newDoc);
  const envelope = await signBrainChange(automergeBytes, key);
  const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));

  return {
    envelope,
    envelopeBytes,
    newDoc: newDoc as T,
    author: envelope.author,
  };
}

// ────────────────────────────────────────────────────────────
// v2 — delta-per-write envelope builder
// ────────────────────────────────────────────────────────────

export interface BuildV2EnvelopeInput<T = any> {
  docId: string;
  oldDoc: any;
  changeFn: (doc: T) => void;
  /**
   * CIDs of this peer's current frontier for the doc. Empty = genesis
   * case (first write after seeding from genesis.bin).
   */
  parentCids: readonly CID[];
  /**
   * priority = max(parent.priority) + 1; pass 0 when parentCids is
   * empty (caller-computed so core doesn't have to load parent envelopes).
   * The function asserts priority >= 1.
   */
  priority: number;
  key: PrivateKey;
  Automerge: AutomergeDocWriter;
  validate?: ValidationHook;
  allowInvalidShape?: boolean;
}

export interface BuildV2EnvelopeResult<T = any> {
  envelope: BrainChangeEnvelopeV2;
  envelopeBytes: Uint8Array;
  newDoc: T;
  author: Address;
}

/**
 * Apply a change to an Automerge doc, extract the delta changes,
 * pack them, sign a v2 envelope.
 *
 * IMPORTANT: snapshot change hashes BEFORE mutating — Automerge 3.x
 * mutates the source doc's internal change log when deriving a new
 * doc, which would yield an empty diff if read afterward. Handled
 * internally here.
 *
 * Throws if the mutator produces no net changes (no-op write).
 */
export async function buildV2Envelope<T = any>(
  input: BuildV2EnvelopeInput<T>,
): Promise<BuildV2EnvelopeResult<T>> {
  const {
    docId, oldDoc, changeFn, parentCids, priority,
    key, Automerge, validate, allowInvalidShape,
  } = input;

  if (priority < 1 || !Number.isInteger(priority)) {
    throw new Error(`buildV2Envelope: priority must be integer >= 1, got ${priority}`);
  }

  // Snapshot BEFORE mutation (Automerge 3.x bug — see HB#321 note in signing.ts).
  const beforeHashes = snapshotChangeHashes(oldDoc, Automerge);
  const newDoc = Automerge.change<T>(oldDoc, changeFn);
  runValidator(docId, oldDoc, newDoc, validate, allowInvalidShape);

  const deltaChanges = extractDeltaChanges(beforeHashes, newDoc, Automerge);
  if (deltaChanges.length === 0) {
    throw new Error(
      `buildV2Envelope: no changes produced for ${docId} — mutator was a no-op`,
    );
  }
  const packed = packChanges(deltaChanges);

  const envelope = await signBrainChangeV2({
    changeBytes: packed,
    parentCids: [...parentCids],
    priority,
  }, key);
  const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));

  return {
    envelope,
    envelopeBytes,
    newDoc: newDoc as T,
    author: envelope.author,
  };
}
