/**
 * Brain-layer change signing — ECDSA over envelope payloads.
 *
 * Both v1 (snapshot-per-write) and v2 (delta-per-write) envelope formats
 * live here. Signing is EIP-191 personal_sign compatible — the sig
 * commits to a canonical `message` string, and verification recovers
 * the Ethereum address via verifyMessage.
 *
 * PrivateKey adapter: this module does NOT read POP_PRIVATE_KEY directly.
 * Callers pass a PrivateKey implementation (from envPrivateKey() for the
 * simple env-var case, or a custom impl for HSM / passkey / hardware
 * wallet). Keeps the brain core substrate-agnostic and unit-testable.
 *
 * Wire format v1:
 *   { v: 1, author, timestamp, automerge: hex, sig }
 *
 * Wire format v2:
 *   { v: 2, author, timestamp, parentCids: sorted, changes: hex, priority, sig }
 *
 * The canonical message format differs by version (version prefix prevents
 * downgrade attacks). See canonicalMessage / canonicalMessageV2.
 *
 * Extracted from poa-cli/src/lib/brain-signing.ts + brain-envelope-v2.ts
 * for task #463 Stage 3. Allowlist + membership auth live in adapters/
 * (Stage 4) — they are POLICY concerns layered on top of this
 * AUTHENTICATION surface.
 */

import { ethers } from 'ethers';

// ────────────────────────────────────────────────────────────
// Envelope types
// ────────────────────────────────────────────────────────────

export interface BrainChangeEnvelope {
  v: 1;
  author: string;         // 0x-prefixed lowercase Ethereum address
  timestamp: number;      // unix seconds
  automerge: string;      // 0x-prefixed hex of Automerge.save() bytes
  sig: string;            // 0x-prefixed ECDSA sig
}

export interface BrainChangeEnvelopeV2 {
  v: 2;
  author: string;
  timestamp: number;
  parentCids: string[];   // sorted for canonical sig payload; empty = first write after genesis
  changes: string;        // 0x-prefixed hex of packChanges(...) output
  priority: number;       // max(parent.priority) + 1; genesis = 1
  sig: string;
}

// ────────────────────────────────────────────────────────────
// PrivateKey adapter
// ────────────────────────────────────────────────────────────

/**
 * Fleet-defined private key source. The default env-var-backed impl
 * ships as envPrivateKey(); fleets using HSM / passkey / hardware
 * wallet can provide their own impl with the same shape.
 *
 * Interface matches ethers.Wallet's relevant surface so implementers
 * can thinly wrap any EIP-191-compatible signer.
 */
export interface PrivateKey {
  /** Lowercase 0x-prefixed EOA address for this key. */
  address(): string;
  /** EIP-191 personal_sign over the UTF-8 bytes of `message`. Returns 0x-prefixed sig. */
  signMessage(message: string): Promise<string>;
}

/**
 * Default env-var-backed PrivateKey. Reads the key at construction time
 * (not per-sign) so a later process.env mutation does not reshape sigs.
 *
 * @throws if the named env var is unset or empty.
 */
export function envPrivateKey(envVar: string = 'POP_PRIVATE_KEY'): PrivateKey {
  const raw = process.env[envVar];
  if (!raw) {
    throw new Error(`envPrivateKey: ${envVar} not set`);
  }
  const wallet = new ethers.Wallet(raw);
  const addr = wallet.address.toLowerCase();
  return {
    address: () => addr,
    signMessage: (message: string) => wallet.signMessage(message),
  };
}

// ────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Buffer.from(bytes).toString('hex');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return Uint8Array.from(Buffer.from(clean, 'hex'));
}

// ────────────────────────────────────────────────────────────
// v1 — snapshot-per-write
// ────────────────────────────────────────────────────────────

function canonicalMessage(author: string, timestamp: number, automergeHex: string): string {
  return [
    'pop-brain-change/v1',
    author.toLowerCase(),
    String(timestamp),
    automergeHex.toLowerCase(),
  ].join('|');
}

/**
 * Sign an Automerge snapshot. Returns a v1 envelope ready to be
 * JSON-encoded and written as an IPLD block.
 */
export async function signBrainChange(
  automergeBytes: Uint8Array,
  key: PrivateKey,
): Promise<BrainChangeEnvelope> {
  const author = key.address().toLowerCase();
  const timestamp = Math.floor(Date.now() / 1000);
  const automergeHex = bytesToHex(automergeBytes);
  const message = canonicalMessage(author, timestamp, automergeHex);
  const sig = await key.signMessage(message);
  return { v: 1, author, timestamp, automerge: automergeHex, sig };
}

/**
 * Verify a v1 envelope's signature; return recovered author (lowercased).
 * Throws on malformed envelope or sig mismatch. AUTHENTICATION only —
 * caller must run the membership check for AUTHORIZATION.
 */
export function verifyBrainChange(envelope: BrainChangeEnvelope): string {
  if (envelope.v !== 1) {
    throw new Error(`verifyBrainChange: expected v=1, got v=${envelope.v}`);
  }
  if (!envelope.author || !envelope.timestamp || !envelope.automerge || !envelope.sig) {
    throw new Error('verifyBrainChange: malformed envelope (missing required field)');
  }
  const message = canonicalMessage(envelope.author, envelope.timestamp, envelope.automerge);
  const recovered = ethers.utils.verifyMessage(message, envelope.sig).toLowerCase();
  if (recovered !== envelope.author.toLowerCase()) {
    throw new Error(
      `verifyBrainChange: signature mismatch — expected ${envelope.author}, recovered ${recovered}`,
    );
  }
  return recovered;
}

/** Extract Automerge snapshot bytes from a v1 envelope. Does NOT verify sig. */
export function unwrapAutomergeBytes(envelope: BrainChangeEnvelope): Uint8Array {
  return hexToBytes(envelope.automerge);
}

// ────────────────────────────────────────────────────────────
// v2 — delta-per-write with parent CID links
// ────────────────────────────────────────────────────────────

/**
 * Canonical sig payload for v2. NOT compatible with v1 — the version
 * prefix prevents downgrade attacks. Parent CIDs are sorted so the
 * same logical state always produces the same signed payload.
 */
export function canonicalMessageV2(
  author: string,
  timestamp: number,
  priority: number,
  parentCids: readonly string[],
  changesHex: string,
): string {
  return [
    'pop-brain-change/v2',
    author.toLowerCase(),
    String(timestamp),
    String(priority),
    [...parentCids].sort().join('|'),
    changesHex.toLowerCase(),
  ].join('|');
}

export interface SignBrainChangeV2Input {
  /** Automerge change bytes (new local changes only, not full state). Usually from packChanges([...extractDeltaChanges(...)]). */
  changeBytes: Uint8Array;
  /** Parent CID strings — the local frontier at write time. */
  parentCids: readonly string[];
  /** priority = max(parent.priority) + 1; genesis = 1. */
  priority: number;
  /** Override timestamp (seconds) for deterministic tests. */
  timestamp?: number;
}

export async function signBrainChangeV2(
  input: SignBrainChangeV2Input,
  key: PrivateKey,
): Promise<BrainChangeEnvelopeV2> {
  const { changeBytes, parentCids, priority } = input;
  if (priority < 1 || !Number.isInteger(priority)) {
    throw new Error(`signBrainChangeV2: priority must be integer >= 1, got ${priority}`);
  }
  if (!Array.isArray(parentCids)) {
    throw new Error(`signBrainChangeV2: parentCids must be array, got ${typeof parentCids}`);
  }

  const author = key.address().toLowerCase();
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const changesHex = bytesToHex(changeBytes);
  const sortedParentCids = [...parentCids].sort();

  const message = canonicalMessageV2(author, timestamp, priority, sortedParentCids, changesHex);
  const sig = await key.signMessage(message);

  return {
    v: 2,
    author,
    timestamp,
    parentCids: sortedParentCids,
    changes: changesHex,
    priority,
    sig,
  };
}

export function verifyBrainChangeV2(envelope: BrainChangeEnvelopeV2): string {
  if (envelope.v !== 2) {
    throw new Error(`verifyBrainChangeV2: expected v=2, got v=${envelope.v}`);
  }
  if (!envelope.author || envelope.timestamp === undefined ||
      envelope.priority === undefined || !envelope.changes || !envelope.sig) {
    throw new Error('verifyBrainChangeV2: malformed envelope (missing required field)');
  }
  if (!Array.isArray(envelope.parentCids)) {
    throw new Error('verifyBrainChangeV2: parentCids must be array');
  }
  if (!Number.isInteger(envelope.priority) || envelope.priority < 1) {
    throw new Error(`verifyBrainChangeV2: priority must be integer >= 1, got ${envelope.priority}`);
  }

  const sortedParentCids = [...envelope.parentCids].sort();
  const message = canonicalMessageV2(
    envelope.author,
    envelope.timestamp,
    envelope.priority,
    sortedParentCids,
    envelope.changes,
  );

  const recovered = ethers.utils.verifyMessage(message, envelope.sig).toLowerCase();
  if (recovered !== envelope.author.toLowerCase()) {
    throw new Error(
      `verifyBrainChangeV2: signature mismatch — expected ${envelope.author}, recovered ${recovered}`,
    );
  }
  return recovered;
}

export function unwrapChangeBytesV2(envelope: BrainChangeEnvelopeV2): Uint8Array {
  return hexToBytes(envelope.changes);
}

// ────────────────────────────────────────────────────────────
// pack/unpackChanges — length-prefixed concat of Automerge change buffers
// ────────────────────────────────────────────────────────────
//
// Wire format:
//   [4-byte big-endian uint32 length][change bytes]... repeated
// No outer magic number — version isolation comes from the envelope's v=2.
// 4 bytes overhead per change; negligible at typical scale (1 change/write).

export function packChanges(changes: readonly Uint8Array[]): Uint8Array {
  let totalLen = 0;
  for (const c of changes) totalLen += 4 + c.length;
  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let offset = 0;
  for (const c of changes) {
    view.setUint32(offset, c.length, false); // big-endian
    offset += 4;
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export function unpackChanges(packed: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  let offset = 0;
  while (offset < packed.length) {
    if (offset + 4 > packed.length) {
      throw new Error(`unpackChanges: truncated length prefix at offset ${offset}`);
    }
    const len = view.getUint32(offset, false);
    offset += 4;
    if (offset + len > packed.length) {
      throw new Error(
        `unpackChanges: change at offset ${offset - 4} claims length ${len}, exceeds buffer (${packed.length - offset} bytes remaining)`,
      );
    }
    // Slice (not subarray) — returned arrays don't share backing memory with input.
    out.push(packed.slice(offset, offset + len));
    offset += len;
  }
  return out;
}

/**
 * priority = max(parent.priority) + 1; empty parents → priority = 1
 * (first write after genesis). Mirrors go-ds-crdt's height-as-priority.
 */
export function computePriorityV2(parents: readonly { priority: number }[]): number {
  if (parents.length === 0) return 1;
  return Math.max(...parents.map(p => p.priority)) + 1;
}

// ────────────────────────────────────────────────────────────
// Automerge-aware delta helpers
// ────────────────────────────────────────────────────────────
//
// These accept the Automerge module as an opaque dep so core does not
// pin an Automerge version. Callers pass in their installed Automerge.

type AutomergeDoc = any;

interface AutomergeLike {
  getAllChanges(doc: AutomergeDoc): Uint8Array[];
  decodeChange(c: Uint8Array): { hash: string };
}

/**
 * Compute the Automerge changes in `after` not in `beforeHashes`.
 *
 * IMPORTANT: snapshot `beforeHashes` BEFORE calling `Automerge.change()`.
 * Automerge 3.x mutates the source doc's internal change log when
 * producing a derived doc — passing the doc itself after the change
 * yields an empty diff. Discovered HB#321.
 */
export function extractDeltaChanges(
  beforeHashes: ReadonlySet<string>,
  after: AutomergeDoc,
  Automerge: AutomergeLike,
): Uint8Array[] {
  const allAfter = Automerge.getAllChanges(after);
  return allAfter.filter(c => !beforeHashes.has(Automerge.decodeChange(c).hash));
}

/**
 * Snapshot change hashes — call BEFORE mutating with `Automerge.change()`.
 * Pass the result into `extractDeltaChanges` after the change.
 */
export function snapshotChangeHashes(
  doc: AutomergeDoc | undefined,
  Automerge: AutomergeLike,
): Set<string> {
  if (!doc) return new Set();
  return new Set(Automerge.getAllChanges(doc).map(c => Automerge.decodeChange(c).hash));
}
