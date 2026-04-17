/**
 * @unified-ai-brain/core — public entry point.
 *
 * This file is the SOLE public export surface. Anything not re-exported
 * here is intentionally private / internal. See docs/public-api.d.ts for
 * the stable surface contract and docs/api-design.md for the rationale.
 *
 * Stage 1 (task #463 by sentinel_01): baseline only — no code moved yet.
 * Stages 2-8 progressively import + re-export the brain layer from POP/Argus.
 *
 * See packages/core/EXTRACTION_PLAN.md for the full staging.
 */

export const PACKAGE_VERSION: string = '0.0.1-pre';

/**
 * Sentinel value — remains until Stage 5 lands. Removed when the
 * full CRDT surface goes live.
 */
export function __packageSentinel(): string {
  return 'unified-ai-brain/core extraction pending — see EXTRACTION_PLAN.md';
}

// ─────────────────────────────────────────────────────────────
// Stage 2 — schema validators (task #463 by sentinel_01, HB#546)
// ─────────────────────────────────────────────────────────────

export { validateBrainDocShape } from './schemas';
export type { ValidationResult } from './schemas';

// ─────────────────────────────────────────────────────────────
// Stage 3 — signing + verify (task #463 by sentinel_01, HB#547)
// ─────────────────────────────────────────────────────────────

export type {
  BrainChangeEnvelope,
  BrainChangeEnvelopeV2,
  PrivateKey,
  SignBrainChangeV2Input,
} from './signing';

export {
  envPrivateKey,
  signBrainChange,
  verifyBrainChange,
  unwrapAutomergeBytes,
  signBrainChangeV2,
  verifyBrainChangeV2,
  unwrapChangeBytesV2,
  canonicalMessageV2,
  packChanges,
  unpackChanges,
  computePriorityV2,
  extractDeltaChanges,
  snapshotChangeHashes,
} from './signing';

// ─────────────────────────────────────────────────────────────
// Stage 4 — adapters (task #463 by sentinel_01, HB#548)
// ─────────────────────────────────────────────────────────────

export type {
  HeadsManifestStore,
  FilesystemStoreOptions,
} from './adapters/heads-manifest';

export {
  createFilesystemStore,
  createMemoryStore,
} from './adapters/heads-manifest';

export type { MembershipProvider } from './adapters/membership';

export {
  createStaticAllowlist,
  createStaticAllowlistFromFile,
  createUnionProvider,
} from './adapters/membership';

// ─────────────────────────────────────────────────────────────
// Stage 5a — doc types + genesis provider (task #463 by sentinel_01, HB#549)
// ─────────────────────────────────────────────────────────────

export type {
  CID,
  PeerId,
  Address,
  OpenDocOpts,
  ApplyChangeOpts,
  BrainSyncResult,
  BrainHeadAnnouncement,
  GenesisProvider,
} from './doc';

export {
  createDirectoryGenesisProvider,
  createStaticGenesisProvider,
} from './doc';

// ─────────────────────────────────────────────────────────────
// Stage 5b — v2 DAG replay (task #463 by sentinel_01, HB#550)
// ─────────────────────────────────────────────────────────────

export type {
  AutomergeDocLoader,
  LoadDocFromV2ChainContext,
} from './doc-v2-chain';

export { loadDocFromV2Chain } from './doc-v2-chain';

// ─────────────────────────────────────────────────────────────
// Stage 5c — pure envelope builders (task #463 by sentinel_01, HB#551)
// ─────────────────────────────────────────────────────────────

export type {
  AutomergeDocWriter,
  ValidationHook,
  BuildV1EnvelopeInput,
  BuildV1EnvelopeResult,
  BuildV2EnvelopeInput,
  BuildV2EnvelopeResult,
} from './doc-write';

export {
  buildV1Envelope,
  buildV2Envelope,
} from './doc-write';

// ─────────────────────────────────────────────────────────────
// Stage 5d — pure merge primitives (task #463 by sentinel_01, HB#552)
// ─────────────────────────────────────────────────────────────

export type {
  AutomergeMergeLike,
  DisjointHistoryResult,
  MergeClassification,
} from './doc-merge';

export {
  detectDisjointHistories,
  classifyMergeHeads,
} from './doc-merge';
