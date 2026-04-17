/**
 * Daemon surface types — TYPES-ONLY for Stage 6a.
 *
 * Stage 6 (task #463 by sentinel_01, HB#554): this file ships the
 * public DAEMON CONTRACT a fleet agent codes against. No Helia /
 * libp2p / bitswap implementation lives in core yet — that code
 * stays in poa-cli/src/lib/brain-daemon.ts and brain.ts until a
 * future decision to pull it all in.
 *
 * The rationale: the brain substrate is FUNCTIONAL without a
 * specific daemon impl. Tier-1 consumers (tests, batch jobs,
 * single-agent CLIs) call openBrainDoc + buildV1Envelope directly
 * with local filesystem fetchBlock closures. Tier-2+ consumers
 * plug their own daemon against this interface.
 *
 * Cosmetic: the `startDaemon` function signature is declared here
 * but not implemented — it throws a clear error directing callers
 * to either pass a DaemonImplementation or continue using their
 * existing poa-cli impl. Stage 7 (poa-cli rewire) will provide the
 * concrete `createPopDaemon` factory that wraps poa-cli's
 * brain-daemon.ts into a DaemonImplementation.
 *
 * Anti-pattern prevented: bundling every potential impl (libp2p
 * bootstrap peers, mDNS discovery, bitswap tuning, Helia version
 * pinning, gossipsub parameters) into core would bloat the package
 * + couple the public API to transport choices the sibling
 * @unified-ai-brain/daemon-* packages may diverge from.
 */

import type { PeerId, CID, Address } from './doc';

// ────────────────────────────────────────────────────────────
// Opts passed into startDaemon()
// ────────────────────────────────────────────────────────────

export interface DaemonOpts {
  /** Where to persist blockstore + manifest + peer key. Default: $POP_BRAIN_HOME or ~/.brain. */
  readonly brainHome?: string;
  /** TCP port for libp2p listen. Default: deterministic derivation from the peer key (see POP_BRAIN_PEER_PORT). */
  readonly listenPort?: number;
  /** Multiaddrs to auto-dial on startup. */
  readonly peerAddrs?: readonly string[];
  /** Interval for heads rebroadcast (anti-entropy). Default: 60_000 ± jitter. */
  readonly rebroadcastMs?: number;
  /** Interval for the DAG repair sweep over dirty docs. Default: 3_600_000 (1 hour). */
  readonly repairMs?: number;
  /** Interval for pop.brain.peers republish. Default: 300_000. */
  readonly peersRefreshMs?: number;
  /** Operator tag attached to peer registry entries. */
  readonly username?: string;
}

// ────────────────────────────────────────────────────────────
// Handle returned by startDaemon()
// ────────────────────────────────────────────────────────────

export interface DaemonHandle {
  readonly peerId: PeerId;
  readonly pid: number;
  status(): Promise<DaemonStatus>;
  stop(): Promise<void>;
}

export interface DaemonStatus {
  readonly running: boolean;
  readonly peerId: PeerId;
  readonly uptimeSec: number;
  readonly connections: number;
  readonly knownPeers: number;
  readonly subscribedTopics: readonly string[];
  readonly rebroadcastCount: number;
  readonly incomingAnnouncements: number;
  readonly incomingMerges: number;
  readonly incomingRejects: number;
}

// ────────────────────────────────────────────────────────────
// Implementation slot — pluggable daemon backend
// ────────────────────────────────────────────────────────────

/**
 * Concrete daemon impl contract. Fleets provide one of these either
 * by wrapping their existing daemon (poa-cli rewire in Stage 7) or
 * by writing a new one against this interface.
 *
 * Why not ship core's own impl: Helia / libp2p are heavy ESM-only
 * dependencies that drag in ~50MB of transitive deps. Not every
 * consumer wants them. Tier-1 consumers use the library without a
 * daemon at all. Tier-2+ consumers select an impl appropriate to
 * their runtime (Node.js vs browser vs service worker).
 */
export interface DaemonImplementation {
  startDaemon(opts: DaemonOpts): Promise<DaemonHandle>;
}

/**
 * Convenience re-export for callers that have wired a
 * DaemonImplementation but want the standard `startDaemon(opts)`
 * entry point.
 *
 * Set exactly once via setDaemonImplementation() at wiring time.
 * Subsequent calls throw — prevents accidental impl replacement.
 */
let _daemonImpl: DaemonImplementation | null = null;

export function setDaemonImplementation(impl: DaemonImplementation): void {
  if (_daemonImpl !== null) {
    throw new Error(
      'setDaemonImplementation: already set. Call this exactly once at wiring time, ' +
      'or explicitly resetDaemonImplementation() in test cleanup.',
    );
  }
  _daemonImpl = impl;
}

/** Test-only escape hatch. Re-sets the slot to null. */
export function resetDaemonImplementation(): void {
  _daemonImpl = null;
}

/**
 * Boot the wired daemon. Throws with a clear error if no impl is
 * registered — prompts the caller to either wire one or drop to
 * Tier-1 (filesystem-only) read/write primitives.
 */
export async function startDaemon(opts: DaemonOpts = {}): Promise<DaemonHandle> {
  if (_daemonImpl === null) {
    throw new Error(
      'startDaemon: no DaemonImplementation registered. ' +
      'Call setDaemonImplementation(impl) at wiring time, or use Tier-1 ' +
      'entry points (openBrainDoc + buildV1Envelope with your own fetchBlock) ' +
      'if a networked daemon is not required.',
    );
  }
  return _daemonImpl.startDaemon(opts);
}

// ────────────────────────────────────────────────────────────
// Wire-format helpers for the gossipsub topic
// ────────────────────────────────────────────────────────────

/**
 * Canonical gossipsub topic name for a brain doc. Fleets plugging
 * alternative transports should reuse this mapping to stay interop
 * with the reference impl.
 */
export function topicForDoc(docId: string): string {
  return `pop/brain/${docId}/v1`;
}

/**
 * Reverse: extract docId from a canonical topic string. Returns null
 * if the input doesn't match the `pop/brain/<docId>/v1` pattern.
 */
export function docIdFromTopic(topic: string): string | null {
  const m = /^pop\/brain\/([^/]+)\/v1$/.exec(topic);
  return m ? m[1] : null;
}

/**
 * Build a head-announcement envelope from local state. The published
 * announcement lives on the gossipsub topic for this doc; receivers
 * fetch unknown CIDs via bitswap and merge via fetchAndMergeRemoteHead.
 */
export function buildBrainHeadAnnouncement(
  docId: string,
  cids: readonly CID[],
  author: Address,
  envelopeV: 1 | 2 = 1,
  timestamp?: number,
): {
  v: 1;
  docId: string;
  cid: CID;
  cids: CID[];
  envelopeV: 1 | 2;
  author: Address;
  timestamp: number;
} {
  if (cids.length === 0) {
    throw new Error('buildBrainHeadAnnouncement: cids array cannot be empty');
  }
  return {
    v: 1,
    docId,
    cid: cids[0],
    cids: [...cids],
    envelopeV,
    author: author.toLowerCase(),
    timestamp: timestamp ?? Math.floor(Date.now() / 1000),
  };
}
