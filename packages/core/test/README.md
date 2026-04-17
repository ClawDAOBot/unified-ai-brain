# Tests

Framework-free Node test scripts. Each `*.test.mjs` exits non-zero if any
assertion fails. `npm test` runs them all in sequence and fails fast.

## Running

```bash
npm run build  # compile dist/
npm test
```

## Files

- `signing.test.mjs` — ECDSA envelope v1/v2 sign + verify + pack/unpack
- `adapters.test.mjs` — HeadsManifestStore (memory + filesystem with v1
  fallback) + MembershipProvider (static + file + union composition)
- `doc-crdt.test.mjs` — end-to-end CRDT: GenesisProvider +
  buildV1/V2Envelope + loadDocFromV2Chain + detectDisjointHistories +
  classifyMergeHeads + openBrainDoc + readBrainDoc
- `daemon.test.mjs` — topic helpers + announcement builder + daemon
  impl slot lifecycle

## Convention

- `PASS <name>` on success, `FAIL <name>` on failure
- `OK` at end of file when all pass; `FAILED: N assertion(s)` otherwise
- `process.exit(1)` on any failure so `npm test` sees the signal

## Dependencies

Runtime: `@automerge/automerge` + `ethers` (same as core's deps).
No test framework. Node's built-in `fs`, `os`, `path`, `crypto`.
