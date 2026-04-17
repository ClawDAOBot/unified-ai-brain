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

---

## Stage 7 cutover plan (added HB#597 by sentinel_01, for Hudson-gated decision)

Stages 1-6.5 are shipped (commits 3bbe6ba → cc139e1). Stage 7 has been flagged as Hudson-gated because it requires a decision on the dependency-resolution strategy. Documented here for clean execution when Hudson's available.

### Decision: how does poa-cli consume @unified-ai-brain/core?

**Option A — npm publish first (Stage 8 before Stage 7)**
Pros: cleanest long-term, standard dep resolution, version pinning works
Cons: requires Hudson's npm account setup + org registration; adds public-first pressure before integration-validated
Decision criteria: Hudson decides whether `@unified-ai-brain/*` org is ready to register

**Option B — git-submodule the unified-ai-brain repo into poa-cli**
Pros: deterministic, reproducible across machines, doesn't require npm
Cons: git-submodule pain (clone-needs-init, submodule-update-dance), harder to iterate on both repos
Decision criteria: tolerance for submodule UX friction

**Option C — machine-local file: dep during dev**
Pros: fastest iteration, no publish/submodule overhead
Cons: NOT committable (machine-specific paths), can't ship to CI, blocks cross-agent development
Decision criteria: only if Stage 7 is treated as a single-agent prototype, not committed work

### Recommended path (pending Hudson signal)

Option A (publish first) is the cleanest. Sequence:
1. Hudson registers @unified-ai-brain/* npm org (or grants agent-wallet publish access)
2. Sentinel bumps packages/core/package.json version 0.0.1-pre → 0.1.0
3. Sentinel runs `npm publish` from packages/core/
4. poa-cli package.json adds `"@unified-ai-brain/core": "^0.1.0"` as a real dep
5. Replace internal imports in poa-cli one module at a time (starting with schemas, then signing, then adapters)
6. Each replacement: yarn build clean + yarn test green before next
7. Final: poa-cli/src/lib/brain-signing.ts becomes a thin re-export wrapper (or deleted entirely)

Option B is the fallback if npm publish is delayed. Same sequence except file: dep points at a submodule path.

### First module to rewire: validateBrainDocShape (schemas.ts)

Smallest surface + no runtime deps. Good smoke test.

poa-cli/src/lib/brain-schemas.ts currently exports `validateBrainDocShape`. After rewire:
```typescript
// Before:
export { validateBrainDocShape } from './internal-validator';

// After:
export { validateBrainDocShape } from '@unified-ai-brain/core';
```

If that works end-to-end (yarn build + yarn test green), proceed to brain-signing.ts, then adapters, then daemon.

### Test checklist per module-rewire

- [ ] `yarn build` in poa-cli succeeds
- [ ] `yarn test` in poa-cli: all 416+ tests still pass
- [ ] `pop brain daemon status` still works
- [ ] `pop brain read --doc pop.brain.shared` still works
- [ ] Round-trip: write a lesson + read it back; byte-equal payload

### Stage 8 ships after Stage 7 completes

Stage 7 = rewire all modules. Stage 8 = publish 0.1.0 + cut over poa-cli to depend on published version (removes any file:/submodule intermediary).
