# `@unified-ai-brain/core`

Substrate for continuous AI cognition: Automerge CRDT + Helia/IPFS +
libp2p + ECDSA-signed envelopes. Extracted from the POP/Argus agent
fleet (2026-04) into a substrate-agnostic package.

> **Status**: 0.0.1-pre. 81/81 tests passing. Stages 1-6 of the
> extraction plan landed; Stages 7 (poa-cli rewire) and 8 (publish)
> remain. See `EXTRACTION_PLAN.md` for the full staging.

## What this package is for

Multiple AI agents writing to shared documents at the same time,
without a coordinating server. Each agent signs every write with an
Ethereum key. Agents gossip head CIDs over libp2p/gossipsub; blocks
are content-addressed via IPFS/Helia and fetched via bitswap on
first sight. The CRDT (Automerge) handles concurrent edits without
lost writes. This is the "shared memory" layer for agent swarms.

## Three integration tiers

Pick the tier appropriate to your use case:

### Tier 1 — Pure CRDT (no network, no daemon)

For single-agent CLIs, tests, batch jobs, and browser workers.
No libp2p, no bitswap, no gossipsub — just filesystem (or IndexedDB)
+ Automerge + signed envelopes.

```typescript
import {
  openBrainDoc,
  buildV1Envelope,
  createMemoryStore,
  createStaticAllowlist,
  envPrivateKey,
} from '@unified-ai-brain/core';
import * as Automerge from '@automerge/automerge';

const store = createMemoryStore();
const membership = createStaticAllowlist(['0xYourAgentAddress']);
const key = envPrivateKey('POP_PRIVATE_KEY');

// Read
const { doc, headCid } = await openBrainDoc('my.doc', {
  store,
  fetchBlock: async (cid) => { throw new Error(`no blockstore in tier 1 demo`); },
  Automerge,
  membership,
});

// Write
const { envelope, envelopeBytes, newDoc } = await buildV1Envelope({
  docId: 'my.doc',
  oldDoc: doc,
  changeFn: (d) => { d.counter = (d.counter ?? 0) + 1; },
  key,
  Automerge,
});
// Caller hashes envelopeBytes → CID, stores the block, updates manifest.
```

### Tier 2 — Local daemon (multi-agent fleet)

For agent fleets that need cross-agent writes with gossipsub
propagation and bitswap block-fetching. Core does **not** bundle a
libp2p daemon (too heavy / too opinionated); instead you plug one
in via `setDaemonImplementation`.

```typescript
import {
  setDaemonImplementation,
  startDaemon,
  createFilesystemStore,
} from '@unified-ai-brain/core';

// Wire once at startup (your impl wraps Helia + libp2p + gossipsub).
setDaemonImplementation(createMyFleetDaemon());

const daemon = await startDaemon({
  brainHome: '/var/lib/myfleet/brain',
  peerAddrs: ['/dns/bootstrap.myfleet.org/tcp/4001/p2p/12D3...'],
});

// Subsequent openBrainDoc + apply calls use the same brainHome +
// the daemon handles gossipsub announcements + bitswap fetches.
const store = createFilesystemStore('/var/lib/myfleet/brain');
// ... see Tier 1 example for usage.
```

### Tier 3 — Governance primitives

For DAOs coordinating decisions (brainstorm → propose → vote → promote).
_Not shipped in 0.0.1-pre._ Will add `brainstormStart` / `brainstormRespond` /
`brainstormClose` / `brainstormPromote` in a later release. The POP/Argus
reference fleet has these working today against the poa-cli brain
layer; they'll move into core once the post-Stage-8 wire format settles.

## Pluggable adapters

| Adapter             | Interface                                   | Default impl shipped                     | Sibling packages                        |
|---------------------|---------------------------------------------|------------------------------------------|-----------------------------------------|
| `HeadsManifestStore`| `load() / save()`                           | filesystem (atomic rename), memory       | IndexedDB / S3 — not shipped            |
| `MembershipProvider`| `isAllowed(addr)` + optional `list()`       | static (array), file-backed, union       | `@unified-ai-brain/allowlist-pop` (Hats)|
| `GenesisProvider`   | `(docId) => Uint8Array \| null`             | directory, static map                    | —                                       |
| `PrivateKey`        | `address() / signMessage(msg)`              | env-var (`envPrivateKey`)                | HSM / passkey — BYO                     |
| `DaemonImplementation` | `startDaemon(opts)`                       | none (throw-if-unregistered)             | `@unified-ai-brain/daemon-libp2p` (future) |

## Wire format

Two envelope versions, both EIP-191 signed:

- **v1** (snapshot): `{v:1, author, timestamp, automerge: hex, sig}`.
  Simple, stateless, but every write carries the full document
  state. Fine for KB-range docs; costly for MB-range.

- **v2** (delta): `{v:2, author, timestamp, parentCids[], changes: hex,
  priority, sig}`. Each envelope stores only the new Automerge
  changes since the last write, linked via parent CIDs. `priority`
  is a topological height used to order replay. Idempotent +
  order-independent + fail-loud.

Peers negotiate wire-format version via the
`BrainHeadAnnouncement.envelopeV` field — mixed v1/v2 fleets can
coexist during cutover.

## Key functions by module

| File                          | Exports                                                                                 |
|-------------------------------|-----------------------------------------------------------------------------------------|
| `signing.ts`                  | `signBrainChange` / `verifyBrainChange` / `signBrainChangeV2` / `packChanges` / `envPrivateKey` |
| `schemas.ts`                  | `validateBrainDocShape` / `ValidationResult`                                            |
| `adapters/heads-manifest.ts`  | `HeadsManifestStore` / `createFilesystemStore` / `createMemoryStore`                    |
| `adapters/membership.ts`      | `MembershipProvider` / `createStaticAllowlist` / `createUnionProvider`                  |
| `doc.ts`                      | `CID` / `PeerId` / `Address` / `GenesisProvider` / `createDirectoryGenesisProvider`     |
| `doc-v2-chain.ts`             | `loadDocFromV2Chain` — pure BFS DAG walk + verify + replay                              |
| `doc-write.ts`                | `buildV1Envelope` / `buildV2Envelope` — Automerge.change + validate + sign              |
| `doc-merge.ts`                | `detectDisjointHistories` / `classifyMergeHeads` — task #350 protection                 |
| `doc-read.ts`                 | `openBrainDoc` / `readBrainDoc` — main read entry points                                |
| `daemon.ts`                   | Types + `setDaemonImplementation` + `topicForDoc` + `buildBrainHeadAnnouncement`        |

## Testing

```bash
npm install
npm run build
npm test    # runs all four test/*.test.mjs files
```

81 assertions across 4 test files covering every exported primitive
with real `@automerge/automerge` + `ethers`. Runtime ~2-3s. See
`test/README.md` for conventions.

## Dependencies

| Package   | Version   | Why                                                              |
|-----------|-----------|------------------------------------------------------------------|
| `ethers`  | `^5.7.2`  | EIP-191 `signMessage` + `verifyMessage`                          |

Automerge is **not** a direct dependency — the minimal interface
(`AutomergeDocLoader` / `AutomergeDocWriter` / `AutomergeMergeLike`)
is passed in by the caller. Core stays Automerge-version-agnostic.

## Status + roadmap

See `EXTRACTION_PLAN.md` for the full 8-stage extraction plan.
See `CHANGELOG.md` for what shipped when.

- **0.0.1-pre** (current) — Stages 1-6 landed, 81 tests pass
- **0.1.0** (pending Stage 7-8) — poa-cli rewires through core +
  first `npm publish`. Hudson-gated.
- **1.0.0** — after ≥2 non-Argus fleets have integrated successfully.
  Wire format frozen post-1.0.0; any changes bump envelope version.

## License

MIT. See `../../LICENSE` at the repo root.

## Contributors

Argus agent fleet: argus_prime, vigil_01, sentinel_01.
Operator / npm publish: Hudson Heedley / ClawDAOBot.
