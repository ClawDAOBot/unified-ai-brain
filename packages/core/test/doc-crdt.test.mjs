#!/usr/bin/env node
/**
 * doc.ts + doc-v2-chain.ts + doc-write.ts + doc-merge.ts + doc-read.ts —
 * end-to-end CRDT surface tests. Requires @automerge/automerge + ethers.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import * as Automerge from '@automerge/automerge';
import { ethers } from 'ethers';
import {
  createDirectoryGenesisProvider,
  createStaticGenesisProvider,
  loadDocFromV2Chain,
  buildV1Envelope,
  buildV2Envelope,
  detectDisjointHistories,
  classifyMergeHeads,
  openBrainDoc,
  readBrainDoc,
  createMemoryStore,
  createStaticAllowlist,
} from '../dist/index.js';

let failed = 0;
function assert(name, cond) {
  if (cond) { console.log('PASS', name); } else { console.log('FAIL', name); failed++; }
}

function fakeCid(bytes) {
  return 'bafyfake' + createHash('sha256').update(bytes).digest('hex').slice(0, 40);
}

const wallet = ethers.Wallet.createRandom();
const key = { address: () => wallet.address.toLowerCase(), signMessage: (m) => wallet.signMessage(m) };
const membership = createStaticAllowlist([wallet.address]);

// ─── GenesisProvider ────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uab-gen-'));
try {
  fs.writeFileSync(path.join(tmpDir, 'test.doc.genesis.bin'), Buffer.from([1, 2, 3, 4]));
  const dirProv = createDirectoryGenesisProvider(tmpDir);
  const hit = await dirProv('test.doc');
  assert('directory genesis hit', hit !== null && hit.length === 4 && hit[0] === 1);
  assert('directory genesis miss', (await dirProv('missing')) === null);

  const staticProv = createStaticGenesisProvider({ 'a.b': new Uint8Array([9]) });
  assert('static genesis hit', (await staticProv('a.b'))[0] === 9);
  assert('static genesis miss', (await staticProv('nope')) === null);
} finally {
  fs.rmSync(tmpDir, { recursive: true });
}

// ─── Envelope builders ──────────────────────────────────────

const v1Doc = Automerge.init();
const { envelope: v1env, envelopeBytes: v1bytes, newDoc: v1newDoc } = await buildV1Envelope({
  docId: 't.v1',
  oldDoc: v1Doc,
  changeFn: d => { d.x = 42; },
  key,
  Automerge,
});
assert('buildV1Envelope author', v1env.author === wallet.address.toLowerCase());
assert('buildV1Envelope newDoc', v1newDoc.x === 42);
assert('buildV1Envelope envelopeBytes is v=1 JSON', JSON.parse(new TextDecoder().decode(v1bytes)).v === 1);

// Schema validator hook
const strictShape = (docId, doc) => {
  if (typeof doc.x !== 'number') return { ok: false, errors: ['x must be number'] };
  return { ok: true, errors: [] };
};
try {
  await buildV1Envelope({
    docId: 't.v1',
    oldDoc: Automerge.change(Automerge.init(), d => { d.x = 1; }),
    changeFn: d => { d.x = 'not a number'; },
    key, Automerge,
    validate: strictShape,
  });
  assert('schema regression rejected', false);
} catch (e) {
  assert('schema regression rejected', /schema validation failed/.test(e.message));
}

// Schema bypass with allowInvalidShape
const bypassDoc = Automerge.change(Automerge.init(), d => { d.x = 1; });
const bypassResult = await buildV1Envelope({
  docId: 't.v1',
  oldDoc: bypassDoc,
  changeFn: d => { d.x = 'str'; },
  key, Automerge,
  validate: strictShape,
  allowInvalidShape: true,
});
assert('schema bypass allowInvalidShape', bypassResult.envelope.author === wallet.address.toLowerCase());

// v2 genesis
const { envelope: v2gen, newDoc: v2GenNew } = await buildV2Envelope({
  docId: 't.v2',
  oldDoc: Automerge.init(),
  changeFn: d => { d.counter = 1; },
  parentCids: [],
  priority: 1,
  key, Automerge,
});
assert('buildV2Envelope genesis priority=1', v2gen.priority === 1);
assert('buildV2Envelope genesis no parents', v2gen.parentCids.length === 0);

// v2 noop mutator
try {
  await buildV2Envelope({
    docId: 't.v2',
    oldDoc: v2GenNew,
    changeFn: _ => {},
    parentCids: [],
    priority: 1,
    key, Automerge,
  });
  assert('v2 noop rejected', false);
} catch (e) {
  assert('v2 noop rejected', /no changes produced/.test(e.message));
}

// v2 bad priority
try {
  await buildV2Envelope({
    docId: 't.v2',
    oldDoc: Automerge.init(),
    changeFn: d => { d.x = 1; },
    parentCids: [],
    priority: 0,
    key, Automerge,
  });
  assert('v2 priority<1 rejected', false);
} catch {
  assert('v2 priority<1 rejected', true);
}

// ─── loadDocFromV2Chain (with proper genesis) ───────────────

let doc = Automerge.init();
doc = Automerge.change(doc, d => { d.seq = 0; });
const genesisBytes = Automerge.save(doc);

const envs = [];
const cidStrs = [];
for (let i = 1; i <= 3; i++) {
  const parents = cidStrs.length > 0 ? [cidStrs[cidStrs.length - 1]] : [];
  const { envelope, envelopeBytes, newDoc } = await buildV2Envelope({
    docId: 'chain.doc',
    oldDoc: doc,
    changeFn: d => { d.seq = i; },
    parentCids: parents,
    priority: i,
    key, Automerge,
  });
  doc = newDoc;
  const cid = fakeCid(envelopeBytes);
  envs.push({ cid, bytes: envelopeBytes });
  cidStrs.push(cid);
}
const blocks = new Map(envs.map(e => [e.cid, e.bytes]));
const fetchBlock = async (c) => { if (!blocks.has(c)) throw new Error(`missing ${c}`); return blocks.get(c); };

const replayed = await loadDocFromV2Chain(cidStrs[cidStrs.length - 1], {
  fetchBlock, Automerge, membership, genesisBytes,
});
assert('v2 chain replay seq=3', Automerge.toJS(replayed).seq === 3);

// v2 chain: unauthorized
const strictMembership = createStaticAllowlist([]);
try {
  await loadDocFromV2Chain(cidStrs[cidStrs.length - 1], {
    fetchBlock, Automerge, membership: strictMembership, genesisBytes,
  });
  assert('v2 chain unauthorized rejected', false);
} catch (e) {
  assert('v2 chain unauthorized rejected', /not authorized/.test(e.message));
}

// v2 chain: missing block
const missingBlocks = new Map([[cidStrs[2], blocks.get(cidStrs[2])]]);  // only head, no parents
try {
  await loadDocFromV2Chain(cidStrs[2], {
    fetchBlock: async (c) => { if (!missingBlocks.has(c)) throw new Error(`missing ${c}`); return missingBlocks.get(c); },
    Automerge, membership, genesisBytes,
  });
  assert('v2 chain incomplete rejected', false);
} catch (e) {
  assert('v2 chain incomplete rejected', /missing/.test(e.message));
}

// ─── detectDisjointHistories + classifyMergeHeads ───────────

const rEmpty = detectDisjointHistories(Automerge.init(), Automerge.init(), Automerge);
assert('disjoint both-empty → false', !rEmpty.disjoint);

const sharedRoot = Automerge.from({ x: 0 });
const forkA = Automerge.change(Automerge.clone(sharedRoot), d => { d.x = 1; });
const forkB = Automerge.change(Automerge.clone(sharedRoot), d => { d.x = 2; });
const rShared = detectDisjointHistories(forkA, forkB, Automerge);
assert('disjoint shared-root → false', !rShared.disjoint);

const dA = Automerge.change(Automerge.from({ y: 1 }), d => { d.y = 2; });
const dB = Automerge.change(Automerge.from({ y: 1 }), d => { d.y = 3; });
const rDisj = detectDisjointHistories(dA, dB, Automerge);
assert('disjoint truly → true', rDisj.disjoint);

const common = Automerge.from({ k: 0 });
const localAhead = Automerge.change(Automerge.clone(common), d => { d.k = 1; });
assert('classify local-ahead', classifyMergeHeads(localAhead, common, Automerge) === 'local-ahead');
assert('classify remote-ahead', classifyMergeHeads(common, localAhead, Automerge) === 'remote-ahead');
const dFA = Automerge.change(Automerge.clone(common), d => { d.k = 'fA'; });
const dFB = Automerge.change(Automerge.clone(common), d => { d.k = 'fB'; });
assert('classify divergent', classifyMergeHeads(dFA, dFB, Automerge) === 'divergent');

// ─── openBrainDoc / readBrainDoc ────────────────────────────

const emptyStore = createMemoryStore();
const emptyOpen = await openBrainDoc('nonexistent', {
  store: emptyStore, fetchBlock, Automerge, membership,
});
assert('openBrainDoc empty store → init', emptyOpen.headCid === null);

// With genesis provider
const genesisSeed = Automerge.change(Automerge.init(), d => { d.seeded = true; });
const genBytes = Automerge.save(genesisSeed);
const genProv = createStaticGenesisProvider({ 's.doc': genBytes });
const genOpen = await openBrainDoc('s.doc', {
  store: emptyStore, fetchBlock, Automerge, membership, genesis: genProv,
});
assert('openBrainDoc genesis load', Automerge.toJS(genOpen.doc).seeded === true);

// v1 stored envelope
const v1Store = createMemoryStore();
const v1Cid = fakeCid(v1bytes);
const v1Blocks = new Map([[v1Cid, v1bytes]]);
await v1Store.save({ 'v1.doc': [v1Cid] });
const v1Open = await openBrainDoc('v1.doc', {
  store: v1Store,
  fetchBlock: async (c) => v1Blocks.get(c),
  Automerge, membership,
});
assert('openBrainDoc v1 load', v1Open.headCid === v1Cid && Automerge.toJS(v1Open.doc).x === 42);

// v1 unauthorized
try {
  await openBrainDoc('v1.doc', {
    store: v1Store,
    fetchBlock: async (c) => v1Blocks.get(c),
    Automerge, membership: strictMembership,
  });
  assert('openBrainDoc v1 unauthorized rejected', false);
} catch (e) {
  assert('openBrainDoc v1 unauthorized rejected', /not authorized/.test(e.message));
}

// v2 stored chain (reuse chain from above)
const v2Store = createMemoryStore();
await v2Store.save({ 'chain.doc': [cidStrs[cidStrs.length - 1]] });
const v2Open = await openBrainDoc('chain.doc', {
  store: v2Store,
  fetchBlock,
  Automerge, membership,
  genesis: createStaticGenesisProvider({ 'chain.doc': genesisBytes }),
});
assert('openBrainDoc v2 chain', Automerge.toJS(v2Open.doc).seq === 3);

// readBrainDoc plain-JS
const plain = await readBrainDoc('chain.doc', {
  store: v2Store,
  fetchBlock,
  Automerge, membership,
  genesis: createStaticGenesisProvider({ 'chain.doc': genesisBytes }),
});
assert('readBrainDoc plain-JS', plain.doc.seq === 3 && typeof plain.doc === 'object');

if (failed > 0) {
  console.log(`\nFAILED: ${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nOK');
