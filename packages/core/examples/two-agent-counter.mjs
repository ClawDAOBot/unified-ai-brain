#!/usr/bin/env node
/**
 * Two-agent shared counter — Tier 1 integration example.
 *
 * Simulates two AI agents (Alice + Bob) each with their own filesystem
 * "brain home", writing to the same logical doc without a daemon.
 * They exchange envelope blocks directly (no libp2p / gossipsub /
 * bitswap) to demonstrate the CRDT substrate works end-to-end on pure
 * signing + Automerge + heads manifests.
 *
 * Flow:
 *   1. Alice + Bob each init a brain home + key
 *   2. Alice writes v2 envelope: counter=1
 *   3. Bob copies Alice's block into his blockstore + updates his manifest
 *   4. Bob writes v2 envelope: counter=2 (child of Alice's)
 *   5. Alice copies Bob's block + re-opens the doc → sees counter=2
 *
 * Real-world deployment replaces step 3+5's "copy the block" with
 * libp2p bitswap, but the CRDT semantics are identical.
 *
 * Run:
 *   cd packages/core
 *   npm run build
 *   node examples/two-agent-counter.mjs
 *
 * Requires: @automerge/automerge + ethers (same deps as core's tests).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import * as Automerge from '@automerge/automerge';
import { ethers } from 'ethers';
import {
  buildV2Envelope,
  loadDocFromV2Chain,
  openBrainDoc,
  createFilesystemStore,
  createStaticAllowlist,
  createUnionProvider,
  createStaticGenesisProvider,
} from '../dist/index.js';

const DOC_ID = 'demo.counter';

function log(tag, ...args) {
  console.log(`[${tag}]`, ...args);
}

/** Deterministic CID stand-in for demo purposes. Real Helia uses multiformats CIDv1. */
function fakeCid(bytes) {
  return 'bafyfake' + createHash('sha256').update(bytes).digest('hex').slice(0, 40);
}

// ────────────────────────────────────────────────────────────
// Setup: two agents with independent filesystem brain homes
// ────────────────────────────────────────────────────────────

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'uab-demo-'));
const aliceHome = path.join(tmpBase, 'alice');
const bobHome = path.join(tmpBase, 'bob');
fs.mkdirSync(aliceHome);
fs.mkdirSync(bobHome);

const aliceKey = makeKey(ethers.Wallet.createRandom());
const bobKey = makeKey(ethers.Wallet.createRandom());
log('setup', `alice=${aliceKey.address().slice(0, 10)}... bob=${bobKey.address().slice(0, 10)}...`);

// Shared membership: both agents know each other are authorized.
const membership = createStaticAllowlist([aliceKey.address(), bobKey.address()]);

// Shared genesis — identical bytes for both agents (task #352 pattern).
// This seed is what every agent loads BEFORE their first write so
// the resulting Automerge history shares a root.
const seedDoc = Automerge.change(Automerge.init(), (d) => { d.counter = 0; });
const genesisBytes = Automerge.save(seedDoc);
const genesis = createStaticGenesisProvider({ [DOC_ID]: genesisBytes });

// Per-agent stores + blockstores (each agent's "local view").
const aliceStore = createFilesystemStore(aliceHome);
const bobStore = createFilesystemStore(bobHome);
const aliceBlocks = new Map();
const bobBlocks = new Map();

// ────────────────────────────────────────────────────────────
// Step 1: Alice writes counter=1 as v2 genesis envelope
// ────────────────────────────────────────────────────────────

log('alice', 'opening doc...');
const aliceOpen1 = await openBrainDoc(DOC_ID, {
  store: aliceStore,
  fetchBlock: makeFetcher(aliceBlocks),
  Automerge,
  membership,
  genesis,
});
log('alice', `initial state: ${JSON.stringify(Automerge.toJS(aliceOpen1.doc))} head=${aliceOpen1.headCid}`);

log('alice', 'writing counter=1...');
const aliceBuild1 = await buildV2Envelope({
  docId: DOC_ID,
  oldDoc: aliceOpen1.doc,
  changeFn: (d) => { d.counter = 1; },
  parentCids: [],       // genesis (Alice writes first)
  priority: 1,
  key: aliceKey,
  Automerge,
});
const aliceCid1 = fakeCid(aliceBuild1.envelopeBytes);
aliceBlocks.set(aliceCid1, aliceBuild1.envelopeBytes);
await aliceStore.save({ [DOC_ID]: [aliceCid1] });
log('alice', `wrote envelope ${aliceCid1.slice(0, 20)}... priority=1`);

// ────────────────────────────────────────────────────────────
// Step 2: Bob receives Alice's block (simulates bitswap fetch)
// ────────────────────────────────────────────────────────────

log('bob', `receiving Alice's block ${aliceCid1.slice(0, 20)}...`);
bobBlocks.set(aliceCid1, aliceBuild1.envelopeBytes);
await bobStore.save({ [DOC_ID]: [aliceCid1] });

const bobOpen1 = await openBrainDoc(DOC_ID, {
  store: bobStore,
  fetchBlock: makeFetcher(bobBlocks),
  Automerge,
  membership,
  genesis,
});
log('bob', `after receiving Alice's write: ${JSON.stringify(Automerge.toJS(bobOpen1.doc))}`);

// ────────────────────────────────────────────────────────────
// Step 3: Bob writes counter=2 (child of Alice's envelope)
// ────────────────────────────────────────────────────────────

log('bob', 'writing counter=2 (child of Alice)...');
const bobBuild1 = await buildV2Envelope({
  docId: DOC_ID,
  oldDoc: bobOpen1.doc,
  changeFn: (d) => { d.counter = 2; },
  parentCids: [aliceCid1],
  priority: 2,
  key: bobKey,
  Automerge,
});
const bobCid1 = fakeCid(bobBuild1.envelopeBytes);
bobBlocks.set(bobCid1, bobBuild1.envelopeBytes);
await bobStore.save({ [DOC_ID]: [bobCid1] });
log('bob', `wrote envelope ${bobCid1.slice(0, 20)}... priority=2`);

// ────────────────────────────────────────────────────────────
// Step 4: Alice receives Bob's block + re-opens the doc
// ────────────────────────────────────────────────────────────

log('alice', `receiving Bob's block ${bobCid1.slice(0, 20)}...`);
aliceBlocks.set(bobCid1, bobBuild1.envelopeBytes);
await aliceStore.save({ [DOC_ID]: [bobCid1] });  // adopt Bob's head

const aliceOpen2 = await openBrainDoc(DOC_ID, {
  store: aliceStore,
  fetchBlock: makeFetcher(aliceBlocks),
  Automerge,
  membership,
  genesis,
});
log('alice', `final state: ${JSON.stringify(Automerge.toJS(aliceOpen2.doc))}`);

// ────────────────────────────────────────────────────────────
// Verify: both agents converged
// ────────────────────────────────────────────────────────────

const aliceFinal = Automerge.toJS(aliceOpen2.doc);
const bobFinal = Automerge.toJS((await openBrainDoc(DOC_ID, {
  store: bobStore, fetchBlock: makeFetcher(bobBlocks), Automerge, membership, genesis,
})).doc);

if (aliceFinal.counter === 2 && bobFinal.counter === 2) {
  log('verify', '✓ converged: both agents see counter=2 after 2 writes across 2 agents');
} else {
  log('verify', `✗ divergence: alice=${aliceFinal.counter} bob=${bobFinal.counter}`);
  process.exit(1);
}

// Cleanup
fs.rmSync(tmpBase, { recursive: true });
log('done', `cleaned up ${tmpBase}`);

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function makeKey(wallet) {
  return {
    address: () => wallet.address.toLowerCase(),
    signMessage: (msg) => wallet.signMessage(msg),
  };
}

function makeFetcher(blocks) {
  return async (cid) => {
    const bytes = blocks.get(cid);
    if (!bytes) throw new Error(`missing block ${cid}`);
    return bytes;
  };
}
