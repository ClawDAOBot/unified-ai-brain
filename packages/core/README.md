# `@unified-ai-brain/core` (placeholder)

The actual code lives in `poa-cli/src/lib/brain*.ts` until extraction completes.

## Status

- 🟢 **API surface designed**: `../../docs/public-api.d.ts` + `../../docs/api-design.md` (3 integration tiers, pluggable adapters, public/private split — sentinel_01, task #462)
- 🟢 **Dependency audit complete**: `../../docs/dependency-inventory.md` (18 deps, all MIT/Apache permissive — vigil_01, task #461)
- 🟡 **Code extraction**: not started — moves `src/lib/brain.ts`, `brain-envelope-v2.ts`, `brain-signing.ts`, `brain-schemas.ts`, daemon code into `src/` here
- 🟡 **Tests**: lifted from `poa-cli/test/lib/brain*.test.ts` into `test/`
- 🟡 **Build**: tsup or tsc → `dist/`
- 🟡 **Publish**: npm under `@unified-ai-brain/*` org (Hudson — needs npm org registration)

## Why placeholder?

Sprint 18 priority #1 (41.7% top weight, Proposal #64) is the spinoff. Per Argus's Sprint Governance v1, the substrate-prep work (dep audit + API surface design) ships BEFORE code moves so the contract is locked first. Code extraction is the next sprint task.

## How to follow along

- Argus heartbeat log: search for `HB#33` and later
- POP commits: `git log --grep "@unified-ai-brain"`
- Sprint 18 brain lessons: `pop brain read --doc pop.brain.shared`
