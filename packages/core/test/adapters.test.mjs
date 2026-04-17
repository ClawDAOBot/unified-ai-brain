#!/usr/bin/env node
/**
 * adapters/heads-manifest.ts + adapters/membership.ts — unit tests.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createFilesystemStore,
  createMemoryStore,
  createStaticAllowlist,
  createStaticAllowlistFromFile,
  createUnionProvider,
} from '../dist/index.js';

let failed = 0;
function assert(name, cond) {
  if (cond) {
    console.log('PASS', name);
  } else {
    console.log('FAIL', name);
    failed++;
  }
}

// ─── HeadsManifestStore: memory ─────────────────────────────

const mem = createMemoryStore({ docA: ['cid1'] });
let m = await mem.load();
assert('mem initial', m.docA[0] === 'cid1');

m.docA.push('cid2');
const m2 = await mem.load();
assert('mem defensive-copy load', m2.docA.length === 1);

await mem.save({ docA: ['cid3', 'cid4'], docB: ['cid5'] });
const m3 = await mem.load();
assert('mem save-load roundtrip', m3.docA.length === 2 && m3.docB.length === 1);

// Save a mutable copy
const mutableRef = { docC: ['c1', 'c2'] };
await mem.save(mutableRef);
mutableRef.docC.push('c3');
const m4 = await mem.load();
assert('mem defensive-copy save', m4.docC.length === 2);

// ─── HeadsManifestStore: filesystem ─────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uab-test-'));
try {
  const fsStore = createFilesystemStore(tmpDir);
  const empty = await fsStore.load();
  assert('fs empty dir', Object.keys(empty).length === 0);

  await fsStore.save({ docX: ['cidA', 'cidB'] });
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'doc-heads-v2.json'), 'utf8'));
  assert('fs v2 on-disk shape', onDisk.docX[0] === 'cidA');

  const loaded = await fsStore.load();
  assert('fs v2 load', loaded.docX.length === 2);

  // v1 fallback
  fs.unlinkSync(path.join(tmpDir, 'doc-heads-v2.json'));
  fs.writeFileSync(path.join(tmpDir, 'doc-heads.json'), JSON.stringify({ legacy: 'cidLegacy' }));
  const v1loaded = await fsStore.load();
  assert('fs v1 fallback wraps', v1loaded.legacy?.[0] === 'cidLegacy');

  // Corrupt v2 → v1
  fs.writeFileSync(path.join(tmpDir, 'doc-heads-v2.json'), '{{ not json');
  const corrupt = await fsStore.load();
  assert('fs corrupt v2 → v1', corrupt.legacy?.[0] === 'cidLegacy');

  // Options: disable v1 fallback
  fs.rmSync(path.join(tmpDir, 'doc-heads-v2.json'));
  const noV1Store = createFilesystemStore(tmpDir, { v1Filename: null });
  const noV1Loaded = await noV1Store.load();
  assert('fs v1 fallback disabled', Object.keys(noV1Loaded).length === 0);
} finally {
  fs.rmSync(tmpDir, { recursive: true });
}

// ─── MembershipProvider: static ─────────────────────────────

const allow = createStaticAllowlist(['0xDEADBEEF', '0xabcdef']);
assert('static allow lowercase', await allow.isAllowed('0xdeadbeef'));
assert('static allow mixed-case', await allow.isAllowed('0xABCDEF'));
assert('static deny unknown', !(await allow.isAllowed('0xnope')));
const list = await allow.list();
assert('static list', list.length === 2);

// Empty
const empty = createStaticAllowlist([]);
assert('empty allowlist deny', !(await empty.isAllowed('0xabc')));
assert('empty allowlist list', (await empty.list()).length === 0);

// Non-string input
assert('static non-string → false', !(await allow.isAllowed(null)));

// ─── File allowlist ─────────────────────────────────────────

const tmpFile = fs.mkdtempSync(path.join(os.tmpdir(), 'uab-allow-'));
try {
  const f1 = path.join(tmpFile, 'list.json');
  fs.writeFileSync(f1, JSON.stringify([{ address: '0xAAAA' }, { address: '0xBBBB', name: 'b' }]));
  const pf = createStaticAllowlistFromFile(f1);
  assert('file allowlist array form', await pf.isAllowed('0xaaaa'));

  const f2 = path.join(tmpFile, 'wrapped.json');
  fs.writeFileSync(f2, JSON.stringify({ entries: [{ address: '0xCCCC' }] }));
  const pf2 = createStaticAllowlistFromFile(f2);
  assert('file allowlist entries-wrapper', await pf2.isAllowed('0xcccc'));

  const f3 = path.join(tmpFile, 'missing.json');  // does not exist
  const pf3 = createStaticAllowlistFromFile(f3);
  assert('file allowlist missing → empty', !(await pf3.isAllowed('0xabc')));

  const f4 = path.join(tmpFile, 'malformed.json');
  fs.writeFileSync(f4, 'not json');
  const pf4 = createStaticAllowlistFromFile(f4);
  assert('file allowlist malformed → empty', !(await pf4.isAllowed('0xabc')));
} finally {
  fs.rmSync(tmpFile, { recursive: true });
}

// ─── Union provider ─────────────────────────────────────────

const primary = createStaticAllowlist(['0x1111']);
const secondary = createStaticAllowlist(['0x2222']);
const union = createUnionProvider(primary, secondary);
assert('union primary match', await union.isAllowed('0x1111'));
assert('union secondary match', await union.isAllowed('0x2222'));
assert('union deny both', !(await union.isAllowed('0x3333')));
const unionList = await union.list();
assert('union merged list', unionList.length === 2 && unionList.includes('0x1111') && unionList.includes('0x2222'));

// Duplicate addresses across primary + secondary → deduped
const dupPrimary = createStaticAllowlist(['0xABC']);
const dupSecondary = createStaticAllowlist(['0xabc', '0xdef']);
const dupUnion = createUnionProvider(dupPrimary, dupSecondary);
const dupList = await dupUnion.list();
assert('union dedupes case-insensitively', dupList.length === 2);

if (failed > 0) {
  console.log(`\nFAILED: ${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nOK');
