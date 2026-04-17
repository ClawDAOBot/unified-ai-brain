/**
 * Public types + lightweight building blocks for the CRDT core.
 *
 * Stage 5a (task #463 by sentinel_01, HB#549): types + genesis provider.
 * Stage 5b-d will add the runtime openBrainDoc / applyBrainChange /
 * fetchAndMergeRemoteHead implementations — those require Helia + libp2p
 * + Automerge as runtime deps and are deferred to the daemon stage.
 *
 * This file establishes the PUBLIC SURFACE a fleet agent compiles
 * against. Every caller-facing type flows from here.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { HeadsManifestStore } from './adapters/heads-manifest';

// ────────────────────────────────────────────────────────────
// Primitive aliases — semantic names for string types
// ────────────────────────────────────────────────────────────

/** CID string — IPFS-style content address (e.g. `bafy...`). */
export type CID = string;

/** Base58 libp2p peer ID (`12D3KooW...`). */
export type PeerId = string;

/** EVM-style EOA address — 0x-prefixed, 20 bytes hex, case-insensitive at the API boundary. */
export type Address = string;

// ────────────────────────────────────────────────────────────
// Option bags passed into read/write entrypoints
// ────────────────────────────────────────────────────────────

export interface OpenDocOpts {
  /** If true, skip schema validation on load. Use only for doctor / repair tools. */
  readonly allowInvalidShape?: boolean;
  /** Override the heads manifest store (default: fleet-provided filesystem store). */
  readonly store?: HeadsManifestStore;
  /** Override the genesis provider (default: directory-based). */
  readonly genesis?: GenesisProvider;
}

export interface ApplyChangeOpts {
  /** If true, skip schema validation on write. Use only for doctor / repair tools. */
  readonly allowInvalidShape?: boolean;
  /**
   * Envelope version to sign. Defaults to the fleet-configured ceiling
   * (see POP_BRAIN_MAX_ENVELOPE_V for the reference impl).
   */
  readonly envelopeVersion?: 1 | 2;
  /** Override the heads manifest store. */
  readonly store?: HeadsManifestStore;
}

// ────────────────────────────────────────────────────────────
// Sync result — outcome of fetchAndMergeRemoteHead
// ────────────────────────────────────────────────────────────

export type BrainSyncResult =
  | { action: 'adopt' | 'merge'; headCid: CID; reason: string }
  | { action: 'skip' | 'reject'; reason: string };

// ────────────────────────────────────────────────────────────
// Head announcement wire format — gossipsub payload
// ────────────────────────────────────────────────────────────

/**
 * Broadcast when an agent updates a doc's head. v2-aware receivers read
 * `cids[]` (full frontier); pre-v2 receivers read `cid` (== `cids[0]` by
 * invariant). Receivers fetch unknown CIDs via bitswap, verify, and
 * merge.
 *
 * `envelopeV` declares the wire-format version the sender supports —
 * enables mixed-version fleets during a v1→v2 cutover.
 */
export interface BrainHeadAnnouncement {
  readonly v: 1;
  readonly docId: string;
  /** Back-compat: always equal to `cids[0]` when both are present. */
  readonly cid: CID;
  /** Full frontier. When present + longer than 1, receiver should merge all. */
  readonly cids?: CID[];
  /** Max envelope version the sender understands. Defaults to 1 if absent. */
  readonly envelopeV?: 1 | 2;
  /** Informational — DO NOT trust without re-verifying the envelope sig. */
  readonly author: Address;
  readonly timestamp: number;
}

// ────────────────────────────────────────────────────────────
// GenesisProvider — shared-root bootstrap for canonical docs
// ────────────────────────────────────────────────────────────

/**
 * Task #352 / brain-crdt-disjoint-history pattern: every agent MUST
 * load from the same genesis bytes before their first write to a
 * canonical doc, otherwise `Automerge.merge` silently drops content
 * when two independently-initialized docs combine.
 *
 * A GenesisProvider answers "what are the genesis bytes for this doc?"
 * Fleets can source genesis from:
 *   - a directory of pinned `.genesis.bin` files (default)
 *   - an IPFS pin mapped by docId
 *   - a static embedded blob
 *   - nothing at all (returns null for non-canonical docs)
 *
 * Returning null is valid — callers fall back to `Automerge.init()`.
 */
export interface GenesisProvider {
  (docId: string): Uint8Array | null | Promise<Uint8Array | null>;
}

/**
 * Default directory-based GenesisProvider. Looks up
 * `<dir>/<docId>.genesis.bin` on every call. Missing or unreadable
 * files resolve to null.
 *
 * No caching — files are ~150 bytes and reads are infrequent (once
 * per doc open with an empty manifest). If a fleet needs caching,
 * wrap this with their own in-memory layer.
 */
export function createDirectoryGenesisProvider(directory: string): GenesisProvider {
  return (docId: string): Uint8Array | null => {
    const p = join(directory, `${docId}.genesis.bin`);
    if (!existsSync(p)) return null;
    try {
      const bytes = readFileSync(p);
      return Uint8Array.from(bytes);
    } catch {
      return null;
    }
  };
}

/**
 * Static in-memory GenesisProvider. Seed with a preloaded map of
 * docId → bytes (e.g. for WASM / browser builds that cannot hit
 * the filesystem).
 */
export function createStaticGenesisProvider(
  seeds: Record<string, Uint8Array>,
): GenesisProvider {
  return (docId: string): Uint8Array | null => seeds[docId] ?? null;
}
