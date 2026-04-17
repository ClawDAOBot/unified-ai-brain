/**
 * openBrainDoc + readBrainDoc — the main read entry points.
 *
 * Stage 5e (task #463 by sentinel_01, HB#553): thin wrappers that
 * compose the pieces shipped in earlier sub-stages:
 *   - HeadsManifestStore (Stage 4) → head CID lookup
 *   - GenesisProvider (Stage 5a) → shared-root bootstrap for empty docs
 *   - fetchBlock closure → blockstore I/O (caller supplies)
 *   - verifyBrainChange + MembershipProvider → v1 auth
 *   - loadDocFromV2Chain (Stage 5b) → v2 DAG replay (includes its own
 *     per-envelope auth)
 *   - unwrapAutomergeBytes + Automerge.load → v1 snapshot reconstruction
 *
 * The function auto-detects v1 vs v2 envelopes by reading the `v` field
 * of the envelope JSON at the head CID. A caller wiring a Tier 2 daemon
 * supplies a fetchBlock that prefers local blockstore then falls back
 * to bitswap; a Tier 1 local-only consumer supplies a filesystem-only
 * fetchBlock.
 *
 * NO module-level state. Every call passes the full context. This is
 * deliberate: core must be safe to use from multiple concurrent
 * consumers (test harnesses, doctor tools, migration scripts) without
 * one polluting the other's state.
 */

import {
  verifyBrainChange,
  unwrapAutomergeBytes,
  type BrainChangeEnvelope,
  type BrainChangeEnvelopeV2,
} from './signing';
import type { HeadsManifestStore } from './adapters/heads-manifest';
import type { MembershipProvider } from './adapters/membership';
import type { AutomergeDocLoader } from './doc-v2-chain';
import { loadDocFromV2Chain } from './doc-v2-chain';
import type { CID, GenesisProvider } from './doc';

// ────────────────────────────────────────────────────────────
// Context — everything openBrainDoc depends on
// ────────────────────────────────────────────────────────────

export interface OpenBrainDocContext {
  /** Where to look up the current head CID(s). */
  store: HeadsManifestStore;

  /**
   * Fetch the raw envelope bytes for a CID. Caller's wiring chooses
   * local-only, bitswap-enabled, HTTP gateway, etc.
   */
  fetchBlock(cidStr: CID): Promise<Uint8Array>;

  /** Automerge module — load + applyChanges + init + getAllChanges + decodeChange. */
  Automerge: AutomergeDocLoader;

  /** Authorization — used by both v1 path (this file) + v2 path (loadDocFromV2Chain). */
  membership: MembershipProvider;

  /**
   * Optional shared-root genesis bytes source. Without it, empty-doc
   * opens return Automerge.init() which risks disjoint-history at
   * first cross-agent merge.
   */
  genesis?: GenesisProvider;
}

export interface OpenBrainDocResult<T = any> {
  doc: T;
  headCid: CID | null;
}

/**
 * Open a brain doc from local state.
 *
 * Decision tree:
 *   1. Look up head frontier from store.load()[docId]. First element
 *      of frontier is "canonical head" — the one we load.
 *   2. No head → try genesis bytes; if found, Automerge.load them;
 *      else Automerge.init(). Returns headCid = null.
 *   3. Head present → fetchBlock(head) + parse envelope.
 *      - v=2: delegate to loadDocFromV2Chain (handles DAG walk + auth).
 *      - v=1: verify sig + check membership + Automerge.load(unwrap).
 *
 * Throws:
 *   - Envelope parse failure
 *   - v=1 sig verify failure
 *   - v=1 author not authorized
 *   - v=2 chain any-envelope auth / verify / fetch failure (from
 *     loadDocFromV2Chain)
 *
 * Filesystem/network agnostic — everything is injected via context.
 */
export async function openBrainDoc<T = any>(
  docId: string,
  ctx: OpenBrainDocContext,
): Promise<OpenBrainDocResult<T>> {
  const { store, fetchBlock, Automerge, membership, genesis } = ctx;

  const manifest = await store.load();
  const frontier = manifest[docId] ?? [];
  const headCid = frontier.length > 0 ? frontier[0] : null;

  if (headCid === null) {
    // No head: empty doc. Prefer genesis bytes if fleet supplied them.
    let doc: any;
    if (genesis) {
      const bytes = await genesis(docId);
      if (bytes) {
        try {
          doc = Automerge.load(bytes);
          return { doc: doc as T, headCid: null };
        } catch {
          // Genesis bytes unreadable — fall through.
        }
      }
    }
    doc = Automerge.init();
    return { doc: doc as T, headCid: null };
  }

  const envelopeBytes = await fetchBlock(headCid);
  const envelope = JSON.parse(
    new TextDecoder().decode(envelopeBytes),
  ) as BrainChangeEnvelope | BrainChangeEnvelopeV2;

  if (envelope.v === 2) {
    const genesisBytes = genesis ? (await genesis(docId)) ?? null : null;
    const doc = await loadDocFromV2Chain(headCid, {
      fetchBlock,
      Automerge,
      membership,
      genesisBytes,
    });
    return { doc: doc as T, headCid };
  }

  // v1 path — sig verify + membership + full snapshot load.
  const v1 = envelope as BrainChangeEnvelope;
  const author = verifyBrainChange(v1);
  const allowed = await membership.isAllowed(author);
  if (!allowed) {
    throw new Error(
      `Brain doc "${docId}" head is signed by ${author}, not authorized by membership provider.`,
    );
  }
  const automergeBytes = unwrapAutomergeBytes(v1);
  const doc = Automerge.load(automergeBytes);
  return { doc: doc as T, headCid };
}

// ────────────────────────────────────────────────────────────
// readBrainDoc — JS-snapshot variant
// ────────────────────────────────────────────────────────────

export interface ReadBrainDocContext extends OpenBrainDocContext {
  /** Only added dep over openBrainDoc: the toJS serializer. */
  Automerge: AutomergeDocLoader & { toJS(doc: any): any };
}

/**
 * Open a brain doc and return a plain-JS snapshot of its current state.
 * Projection layer wrapper over openBrainDoc — same error behavior,
 * same context requirements plus Automerge.toJS.
 */
export async function readBrainDoc<T = any>(
  docId: string,
  ctx: ReadBrainDocContext,
): Promise<OpenBrainDocResult<T>> {
  const { doc, headCid } = await openBrainDoc<any>(docId, ctx);
  const plain = ctx.Automerge.toJS(doc);
  return { doc: plain as T, headCid };
}
