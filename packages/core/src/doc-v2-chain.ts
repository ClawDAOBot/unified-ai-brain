/**
 * loadDocFromV2Chain — replay a v2 envelope DAG into an Automerge document.
 *
 * v2 wire format stores delta-per-write envelopes linked by parent CIDs.
 * To reconstruct the current doc state from a head CID, the reader walks
 * the DAG back to the deepest ancestor available locally (or to genesis),
 * verifies every envelope, sorts by priority (= height), and replays
 * changes via Automerge.applyChanges.
 *
 * Pure function — takes `fetchBlock`, `Automerge`, `membership`, and
 * `genesisBytes` as parameters. NO coupling to Helia, libp2p, multiformats
 * CID parsing, or the local filesystem. This lets the function be unit-
 * tested with mock impls and called from any runtime (daemon, CLI, test).
 *
 * Fetching strategy is the caller's concern: for a daemon, fetchBlock
 * tries local blockstore first, then bitswap. For a test, fetchBlock
 * returns hand-crafted envelope bytes from an in-memory Map.
 *
 * Extracted from poa-cli/src/lib/brain.ts (task #463 Stage 5b by
 * sentinel_01, HB#550).
 */

import {
  verifyBrainChangeV2,
  unpackChanges,
  type BrainChangeEnvelopeV2,
} from './signing';
import type { MembershipProvider } from './adapters/membership';
import type { CID } from './doc';

/**
 * Minimal Automerge surface this function depends on. Matches the shape
 * exposed by @automerge/automerge v2+. Pass the installed module
 * directly — the type is intentionally loose so future Automerge
 * versions don't break core's type compile.
 */
export interface AutomergeDocLoader {
  init(): any;
  load(bytes: Uint8Array): any;
  applyChanges(doc: any, changes: Uint8Array[]): [any, ...any[]];
}

export interface LoadDocFromV2ChainContext {
  /** Fetch the raw envelope bytes for a CID. Throws if unavailable. */
  fetchBlock(cidStr: CID): Promise<Uint8Array>;
  /** Automerge module. */
  Automerge: AutomergeDocLoader;
  /** Authorization check — rejects envelopes signed by non-members. */
  membership: MembershipProvider;
  /**
   * Shared-root genesis bytes for this doc's Automerge.load seed.
   * Null falls back to Automerge.init() (non-canonical docs).
   */
  genesisBytes: Uint8Array | null;
}

/**
 * Replay a v2 envelope DAG starting at `headCid` into an Automerge doc.
 *
 * Guarantees:
 * - Every envelope in the collected DAG is sig-verified + authorized.
 * - Envelopes are replayed in priority order (topological safe — DAG
 *   walk ensures all dependencies come first).
 * - Any fetch / verify / auth failure aborts the load (partial chains
 *   never produce state). Caller's manifest MUST stay at the prior
 *   head on throw.
 *
 * @throws if any envelope is non-v2, sig mismatch, unauthorized, or
 *   the underlying fetchBlock throws.
 */
export async function loadDocFromV2Chain(
  headCid: CID,
  ctx: LoadDocFromV2ChainContext,
): Promise<any> {
  const { fetchBlock, Automerge, membership, genesisBytes } = ctx;

  // BFS walk: head → parents → ... → deepest local ancestor / genesis.
  const queue: CID[] = [headCid];
  const collected = new Map<CID, BrainChangeEnvelopeV2>();

  while (queue.length > 0) {
    const cidStr = queue.shift()!;
    if (collected.has(cidStr)) continue;

    const envelopeBytes = await fetchBlock(cidStr);
    const envelope = JSON.parse(
      new TextDecoder().decode(envelopeBytes),
    ) as BrainChangeEnvelopeV2;

    if (envelope.v !== 2) {
      throw new Error(
        `loadDocFromV2Chain: walked into non-v2 envelope at ${cidStr.slice(0, 16)}... — ` +
        `mixed v1/v2 chains require a v1-base + v2-tail bootstrap (not supported here).`,
      );
    }

    // Authenticate first (sig → recovered author).
    const author = verifyBrainChangeV2(envelope);

    // Then authorize (recovered author in allowlist).
    const allowed = await membership.isAllowed(author);
    if (!allowed) {
      throw new Error(
        `loadDocFromV2Chain: envelope at ${cidStr.slice(0, 16)}... signed by ` +
        `${author}, not authorized by membership provider.`,
      );
    }

    collected.set(cidStr, envelope);
    for (const parentCid of envelope.parentCids) {
      if (!collected.has(parentCid)) queue.push(parentCid);
    }
  }

  // Priority sort — lowest priority (== oldest / genesis-adjacent) first.
  // Same-priority ties produce the same deterministic result because
  // Automerge.applyChanges is commutative + idempotent.
  const sorted = [...collected.values()].sort((a, b) => a.priority - b.priority);

  // Bootstrap doc state from shared genesis if available, else init().
  let doc: any;
  if (genesisBytes) {
    try {
      doc = Automerge.load(genesisBytes);
    } catch {
      doc = Automerge.init();
    }
  } else {
    doc = Automerge.init();
  }

  // Replay all changes in priority order.
  for (const env of sorted) {
    const packed = hexToBytes(env.changes);
    const changes = unpackChanges(packed);
    if (changes.length === 0) continue;
    const [next] = Automerge.applyChanges(doc, changes);
    doc = next;
  }

  return doc;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return Uint8Array.from(Buffer.from(clean, 'hex'));
}
