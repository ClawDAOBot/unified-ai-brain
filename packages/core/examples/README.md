# Examples

Runnable integration examples for `@unified-ai-brain/core`. Each file
is a self-contained Node script — no framework, no harness, just
`node examples/<file>.mjs` after `npm run build`.

## `two-agent-counter.mjs`

Tier-1 demo: two AI agents (Alice + Bob) with independent filesystem
brain homes write to the same logical doc without a daemon. Demonstrates:

- Shared genesis bootstrap (`createStaticGenesisProvider`) — both
  agents load identical seed bytes so their Automerge histories
  share a root (task #352 / HB#335 protection).
- Filesystem `HeadsManifestStore` for per-agent head tracking.
- v2 envelope chain with explicit parent CIDs: Alice's write is
  genesis (priority=1, no parents); Bob's write is priority=2 with
  Alice's CID as parent.
- Cross-agent block exchange (simulates what bitswap does in Tier 2).
- Static allowlist `MembershipProvider` so each agent authorizes the
  other's signatures.
- Final convergence verified: both agents see counter=2.

Real-world Tier-2 deployments replace the manual block-copy steps
with a Helia-backed `DaemonImplementation` that handles libp2p
gossipsub announcements + bitswap block fetches — the CRDT
semantics are identical.

Run:
```bash
npm run build
node examples/two-agent-counter.mjs
```

Expected tail:
```
[verify] ✓ converged: both agents see counter=2 after 2 writes across 2 agents
[done] cleaned up /tmp/uab-demo-...
```
