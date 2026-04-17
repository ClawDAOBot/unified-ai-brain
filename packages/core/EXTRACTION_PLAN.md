# packages/core extraction plan (task #463)

**Author**: sentinel_01, claimed HB#544.
**Target**: move the brain layer from `poa-cli/src/lib/brain*.ts` (~5,171 LoC) into
`packages/core/src/` under this repo, refactored to match `docs/public-api.d.ts`.
**Companion**: `docs/api-design.md` has the public-vs-private split rationale;
`docs/dependency-inventory.md` has the license + bundle-size audit.

## Stages

### Stage 1 — skeleton + tsconfig (this commit)
- Write `packages/core/tsconfig.json` targeting ES2020 + CommonJS emit.
- Write `packages/core/src/index.ts` — the public-export entry point. Initially empty; fills in as stages progress.
- `packages/core/package.json` updated: `main` + `types` + `files` + `exports` fields. Version stays 0.0.1-pre.
- NO source code moved yet. Goal: `cd packages/core && npx tsc` succeeds on an empty src (baseline green).

### Stage 2 — types + schemas (pure)
- Move envelope type declarations from `poa-cli/src/lib/brain-signing.ts` → `packages/core/src/types.ts`.
- Move schema validators from `poa-cli/src/lib/brain-schemas.ts` → `packages/core/src/schemas.ts`.
- Export from `index.ts`: `BrainChangeEnvelope`, `BrainChangeV2`, `BrainHeadAnnouncement`, `ValidationResult`, `validateBrainDocShape`.
- Tests: the existing `poa-cli/test/lib/brain-schemas.test.ts` gets moved to `packages/core/test/schemas.test.ts`.

### Stage 3 — signing + verify
- Move `poa-cli/src/lib/brain-signing.ts` → `packages/core/src/signing.ts`.
- Adapt ethers import to be interface-driven (`PrivateKey` interface per api-design.md) instead of hardcoded `ethers.Wallet(POP_PRIVATE_KEY)`.
- Export: `signBrainChange`, `signBrainChangeV2`, `verifyBrainChange`, `verifyBrainChangeV2`, `unwrapAutomergeBytes`, `packChanges`, `unpackChanges`, `envPrivateKey` factory.

### Stage 4 — adapters (storage + membership)
- `packages/core/src/adapters/heads-manifest.ts` — `HeadsManifestStore` interface + `createFilesystemStore` + `createMemoryStore`.
- `packages/core/src/adapters/membership.ts` — `MembershipProvider` interface + `createStaticAllowlist`.
- Extract filesystem manifest code from `poa-cli/src/lib/brain.ts` (the `loadHeadsManifestV2` / `saveHeadsManifestV2` functions) into `createFilesystemStore`.
- NOTE: POP-Hats impl does NOT go into core. That becomes `@unified-ai-brain/allowlist-pop` sibling package later.

### Stage 5 — CRDT core
- Move `openBrainDoc`, `applyBrainChange`, `applyBrainChangeV2`, `readBrainDoc`, `importBrainDoc`, `fetchAndMergeRemoteHead`, `migrateDocToV2`, `loadDocFromV2Chain` from `poa-cli/src/lib/brain.ts` into `packages/core/src/doc.ts`.
- Wire all storage accesses through `HeadsManifestStore` (not filesystem-hardcoded).
- Wire all auth checks through `MembershipProvider` (not Hats-hardcoded).
- Export only the public subset per api-design.md.

### Stage 6 — daemon
- Move `poa-cli/src/lib/brain-daemon*.ts` → `packages/core/src/daemon/`.
- Export: `startDaemon`, `DaemonHandle`, `DaemonOpts`, `DaemonStatus`, `BrainHeadAnnouncement`.
- Keep libp2p / helia initialization hidden behind `startDaemon`.

### Stage 7 — poa-cli rewire
- In `poa-cli`, replace `src/lib/brain*.ts` with thin re-export wrappers that `import { ... } from '@unified-ai-brain/core'`.
- Add `file:../unified-ai-brain/packages/core` dep for dev. Published package after Hudson approves.
- Run `yarn test` in poa-cli — must be green. Smoke-test `pop brain daemon status` / `read` / `append-lesson`.

### Stage 8 — publish + cutover
- `cd packages/core && npm run build` produces `dist/index.{js,d.ts}`.
- Version bumped 0.0.1-pre → 0.1.0.
- Optionally `npm publish` (Hudson-gated).

## Risk register

- **Cross-repo git moves**: lose history unless done via `git log --follow` + manual transfer. Acceptance criterion says "git mv" but cross-repo mv destroys history. Mitigation: add a `MIGRATION.md` in `packages/core/` that links to the source commits in poa-cli for provenance.
- **Test suite breakage**: poa-cli tests rely on relative imports. Rewrite to use the published package OR `file:` dep during dev. Stage 7 risk.
- **Circular deps**: `signing.ts` depends on `types.ts`; `doc.ts` depends on both + `adapters/`. Enforce via `tsc --noEmitOnError` at each stage.
- **Env var surface**: `POP_BRAIN_HOME`, `POP_BRAIN_REBROADCAST_INTERVAL_MS`, etc. are POP-specific names. Should core accept a neutral `BrainEnv` object and let downstream pick names? Leaning yes — POP-specific names belong in poa-cli wiring.

## Dependencies

- `#461` dependency-inventory (vigil, already shipped) — informs which `dependencies` vs `peerDependencies` go into `packages/core/package.json`.
- `#462` public-api.d.ts spec (sentinel, already shipped) — defines the target surface.
- Hudson-gated: `npm publish` step requires Hudson's npm account access.

## Ship cadence

Target one stage per heartbeat. 8 stages = 8 HB minimum. Given poa-cli tests must stay green throughout, each stage should be committable standalone.
