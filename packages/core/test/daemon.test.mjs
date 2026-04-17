#!/usr/bin/env node
/**
 * daemon.ts — surface tests (types + impl-slot + topic helpers).
 */

import {
  topicForDoc,
  docIdFromTopic,
  buildBrainHeadAnnouncement,
  setDaemonImplementation,
  resetDaemonImplementation,
  startDaemon,
} from '../dist/index.js';

let failed = 0;
function assert(name, cond) {
  if (cond) { console.log('PASS', name); } else { console.log('FAIL', name); failed++; }
}

// Topic mapping
assert('topicForDoc', topicForDoc('pop.brain.shared') === 'pop/brain/pop.brain.shared/v1');
assert('docIdFromTopic match', docIdFromTopic('pop/brain/x.y.z/v1') === 'x.y.z');
assert('docIdFromTopic non-canonical', docIdFromTopic('unrelated/thing') === null);
assert('docIdFromTopic wrong-version', docIdFromTopic('pop/brain/x/v2') === null);

// Announcement builder
const ann = buildBrainHeadAnnouncement('doc.a', ['bafy1', 'bafy2', 'bafy3'], '0xDEADBEEF', 2);
assert('announcement cid = cids[0]', ann.cid === 'bafy1');
assert('announcement cids sorted?', ann.cids.length === 3);
assert('announcement envelopeV', ann.envelopeV === 2);
assert('announcement author lowercased', ann.author === '0xdeadbeef');
assert('announcement default v', ann.v === 1);

// Default envelopeV = 1
const annDefault = buildBrainHeadAnnouncement('doc.b', ['bafy'], '0xabc');
assert('announcement default envelopeV', annDefault.envelopeV === 1);

// Custom timestamp
const annTs = buildBrainHeadAnnouncement('doc.c', ['bafy'], '0xabc', 1, 42);
assert('announcement custom timestamp', annTs.timestamp === 42);

// Empty cids rejected
try {
  buildBrainHeadAnnouncement('doc', [], '0xabc');
  assert('announcement empty cids rejected', false);
} catch (e) {
  assert('announcement empty cids rejected', /cannot be empty/.test(e.message));
}

// ─── Daemon impl slot ───────────────────────────────────────

resetDaemonImplementation();  // defensive

try {
  await startDaemon({});
  assert('startDaemon no-impl throws', false);
} catch (e) {
  assert('startDaemon no-impl throws', /no DaemonImplementation/.test(e.message));
}

const fakeHandle = {
  peerId: '12D3FAKE',
  pid: 99999,
  status: async () => ({
    running: true, peerId: '12D3FAKE', uptimeSec: 0, connections: 0,
    knownPeers: 0, subscribedTopics: [], rebroadcastCount: 0,
    incomingAnnouncements: 0, incomingMerges: 0, incomingRejects: 0,
  }),
  stop: async () => {},
};

let lastOpts = null;
const fakeImpl = {
  startDaemon: async (opts) => { lastOpts = opts; return fakeHandle; },
};

setDaemonImplementation(fakeImpl);
const handle = await startDaemon({ brainHome: '/custom', listenPort: 12345 });
assert('startDaemon returns impl handle', handle.peerId === '12D3FAKE');
assert('startDaemon forwards opts', lastOpts.brainHome === '/custom' && lastOpts.listenPort === 12345);

const status = await handle.status();
assert('handle.status works', status.running === true && status.peerId === '12D3FAKE');

// Duplicate registration
try {
  setDaemonImplementation(fakeImpl);
  assert('duplicate reg rejected', false);
} catch (e) {
  assert('duplicate reg rejected', /already set/.test(e.message));
}

// Reset + re-register
resetDaemonImplementation();
setDaemonImplementation(fakeImpl);
assert('reset allows re-register', true);
resetDaemonImplementation();

if (failed > 0) {
  console.log(`\nFAILED: ${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nOK');
