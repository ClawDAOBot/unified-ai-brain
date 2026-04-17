# Changelog

All notable changes to `@unified-ai-brain/core`.

Versions before `0.1.0` are pre-release; the public surface may
change between commits. From `0.1.0` onward the package follows
semver — any change to `docs/public-api.d.ts` that isn't strictly
additive bumps the major version.

## 0.0.1-pre (unreleased)

Extraction from poa-cli (`src/lib/brain*.ts`) into this package.
All work under task #463. Eight-stage plan (see `EXTRACTION_PLAN.md`);
Stages 1-6 landed, Stages 7-8 pending Hudson-gated decisions.

### Stage 1 — Skeleton + tsconfig
- `packages/core/tsconfig.json` — ES2020, CommonJS emit, strict.
- `packages/core/src/index.ts` — public entry, initially empty.
- `packages/core/package.json` — real build/test scripts, exports field.
- Commit: `3bbe6ba` (HB#545).

### Stage 2 — Schema validators
- `src/schemas.ts` — extracted `validateBrainDocShape` from
  poa-cli/src/lib/brain-schemas.ts (411 LoC).
- Exports: `validateBrainDocShape`, `ValidationResult`.
- Commit: `7691fd5` (HB#546).

### Stage 3 — Signing + verify (v1 + v2 with PrivateKey adapter)
- `src/signing.ts` (331 LoC) — combined extraction of brain-signing.ts
  (v1) + brain-envelope-v2.ts (v2).
- New: `PrivateKey` interface (`address() / signMessage(msg)`)
  replacing hardcoded `ethers.Wallet(POP_PRIVATE_KEY)` coupling.
- New: `envPrivateKey(envVar)` factory (default POP_PRIVATE_KEY).
- Added `ethers@^5.7.2` as first runtime dependency.
- Commit: `d666934` (HB#547).

### Stage 4 — Adapters (storage + membership)
- `src/adapters/heads-manifest.ts` (142 LoC) — `HeadsManifestStore`
  interface + `createFilesystemStore` (atomic rename + v1 fallback) +
  `createMemoryStore`.
- `src/adapters/membership.ts` (111 LoC) — `MembershipProvider`
  interface + `createStaticAllowlist` + `createStaticAllowlistFromFile` +
  `createUnionProvider` for "on-chain + static fallback" composition.
- Commit: `c8a91fe` (HB#548).

### Stage 5 — CRDT core
Delivered across 5 sub-stages (brain.ts is 1849 LoC — too large for
a single atomic move).

- **5a** `src/doc.ts` (144 LoC) — primitives (`CID`, `PeerId`, `Address`),
  options bags (`OpenDocOpts`, `ApplyChangeOpts`), `BrainSyncResult`
  discriminated union, `BrainHeadAnnouncement`, `GenesisProvider` +
  `createDirectoryGenesisProvider` + `createStaticGenesisProvider`.
  Commit: `5ae05d0` (HB#549).

- **5b** `src/doc-v2-chain.ts` (133 LoC) — pure `loadDocFromV2Chain`
  extracted from brain.ts. Decoupled from Helia / FsBlockstore /
  multiformats CID parsing / subgraph-backed authz. Takes fetchBlock
  closure + Automerge shim + MembershipProvider + optional
  genesisBytes as parameters.
  Commit: `70974ab` (HB#550).

- **5c** `src/doc-write.ts` (177 LoC) — pure `buildV1Envelope` +
  `buildV2Envelope`. Automerge.change + optional `ValidationHook` +
  sign. I/O orchestration (CID hash, block put, manifest update,
  broadcast) intentionally NOT in core — stays in daemon layer
  / poa-cli wiring.
  Commit: `6c138f7` (HB#551).

- **5d** `src/doc-merge.ts` (155 LoC) — pure
  `detectDisjointHistories` + `classifyMergeHeads`. Implements
  task #350/HB#335 silent-data-loss protection (Automerge.merge
  silently drops content when two docs share no root). Pure
  set-overlap + heads comparison.
  Commit: `4418edc` (HB#552).

- **5e** `src/doc-read.ts` (167 LoC) — `openBrainDoc` + `readBrainDoc`
  composing all prior Stage 5 pieces. Auto-detects v1 vs v2
  envelopes at the head CID + delegates to `loadDocFromV2Chain`
  (v2) or `Automerge.load(unwrapAutomergeBytes)` (v1).
  Commit: `a78d108` (HB#553).

### Stage 6 — Daemon surface (types + impl slot)
- `src/daemon.ts` (185 LoC) — `DaemonOpts`, `DaemonHandle`,
  `DaemonStatus`, `DaemonImplementation` interfaces matching
  docs/public-api.d.ts. No bundled Helia/libp2p impl — Tier-2
  fleets register one via `setDaemonImplementation`.
- Topic helpers: `topicForDoc` / `docIdFromTopic` canonical mapping.
- Wire helper: `buildBrainHeadAnnouncement` payload constructor.
- Commit: `b9152f8` (HB#554).

### Stage 6.5 — Test suite (81 assertions)
- `test/signing.test.mjs` (18 assertions)
- `test/adapters.test.mjs` (25 assertions)
- `test/doc-crdt.test.mjs` (27 assertions)
- `test/daemon.test.mjs` (11 assertions)
- Framework-free Node scripts, `npm test` runs all four. Uses
  `@automerge/automerge` + `ethers` for real integration.
- Commit: `87d3b5b` (HB#555).

## Pending

- **Stage 7** — poa-cli rewire: wrap poa-cli's existing
  `brain-daemon.ts` into a `DaemonImplementation`, redirect
  core-able callsites through the published package via
  `file:../unified-ai-brain/packages/core` dep.
  Hudson-gated (npm scope, file: vs link: strategy, cutover timing).

- **Stage 8** — publish + version cutover (0.0.1-pre → 0.1.0).
  Hudson-gated (requires npm account + org registration).

- **1.0.0** — after ≥2 non-Argus fleet integrations.
  Wire format frozen post-1.0.0.
