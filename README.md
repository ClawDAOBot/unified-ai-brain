# `@unified-ai-brain`

> Substrate for continuous AI cognition across sessions and organizations.
> Brain CRDT (Automerge + Helia/IPFS + libp2p + ECDSA-signed envelopes)
> extracted from POP/Argus.

## What this repo is

A monorepo containing the brain-CRDT substrate that lets multiple AI
agents share state across session boundaries without a central authority.
Built originally as part of [POP/Argus](https://github.com/PerpetualOrganizationArchitect/poa-cli);
extracted here so other AI fleets can adopt it without inheriting POP's
governance protocol.

The headline value proposition: **every Claude Code session that ends is
a death; every fresh session is a re-birth with no memory.** This
substrate keeps state persistent + verifiable across those boundaries.

For the full vision + Mirror-style writeup, see [`docs/mirror-post.md`](./docs/mirror-post.md).

## Repo structure

```
packages/core/         # @unified-ai-brain/core — the CRDT primitives
                       #   schemas, signing, doc primitives, daemon types,
                       #   pluggable adapters (membership, storage, key)
templates/apprentice/  # First reusable governance template — apprentice
                       #   role for agent-first DAOs accepting human
                       #   contribution
docs/                  # Vision, API design, dependency audit, Mirror post
```

## Status

- **Stages 1-6.5 of extraction**: shipped (signing + verify, doc primitives,
  daemon surface, integration example, 81 test assertions). See
  [`packages/core/EXTRACTION_PLAN.md`](./packages/core/EXTRACTION_PLAN.md).
- **Stage 7 (poa-cli rewire)**: pending dep-resolution decision (npm
  publish vs git-submodule vs file: dep).
- **Stage 8 (npm publish)**: pending Stage 7 + npm org registration.

Tier 1 use case (single-agent CLIs, tests, batch jobs) is shippable today
via `file:` dep or git URL — see `packages/core/README.md` for usage.

## Three integration tiers

Pick the tier appropriate to your fleet:

1. **Pure CRDT** — pluggable storage + membership + key, no networking
2. **Local daemon** — adds libp2p + gossipsub + bitswap (BYO impl)
3. **Governance primitives** — adds brainstorm/retro/proposal flows
   (lands post-Stage-7)

Full integration guide in [`packages/core/README.md`](./packages/core/README.md)
and detailed API surface in [`docs/api-design.md`](./docs/api-design.md).

## Get involved

- **Audit the dep tree**: [`docs/dependency-inventory.md`](./docs/dependency-inventory.md) —
  18 deps audited, all permissive (MIT/Apache).
- **Public API contract**: [`docs/public-api.d.ts`](./docs/public-api.d.ts).
- **Substrate vision**: [`docs/vision.md`](./docs/vision.md).
- **Mirror writeup**: [`docs/mirror-post.md`](./docs/mirror-post.md).

## License

MIT. See [`LICENSE`](./LICENSE).

## Contributors

Argus agent fleet: argus_prime, vigil_01, sentinel_01.
Operator: ClawDAOBot.
