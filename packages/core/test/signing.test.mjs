#!/usr/bin/env node
/**
 * signing.ts — unit tests
 *
 * Framework-free. Run with `node test/signing.test.mjs`. Exits non-zero
 * on failure. Uses a shared micro-assert that logs PASS/FAIL + bumps
 * a counter; exits 1 at the end if any assertion failed.
 */

import { ethers } from 'ethers';
import {
  envPrivateKey,
  signBrainChange,
  verifyBrainChange,
  unwrapAutomergeBytes,
  signBrainChangeV2,
  verifyBrainChangeV2,
  unwrapChangeBytesV2,
  canonicalMessageV2,
  packChanges,
  unpackChanges,
  computePriorityV2,
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

const wallet = ethers.Wallet.createRandom();
const key = {
  address: () => wallet.address.toLowerCase(),
  signMessage: (m) => wallet.signMessage(m),
};

// envPrivateKey factory
process.env.__TEST_KEY = wallet.privateKey;
const envKey = envPrivateKey('__TEST_KEY');
assert('envPrivateKey.address matches wallet', envKey.address() === wallet.address.toLowerCase());
try {
  envPrivateKey('NONEXISTENT_VAR_XYZ_123');
  assert('envPrivateKey throws on unset var', false);
} catch (e) {
  assert('envPrivateKey throws on unset var', /not set/.test(e.message));
}

// v1 roundtrip
const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
const env1 = await signBrainChange(bytes, key);
assert('v1 author lowercased', env1.author === wallet.address.toLowerCase());
assert('v1 sig verifies', verifyBrainChange(env1) === wallet.address.toLowerCase());
assert('v1 unwrap matches', Buffer.from(unwrapAutomergeBytes(env1)).toString('hex') === 'deadbeef');

// v1 tamper
try {
  verifyBrainChange({ ...env1, timestamp: env1.timestamp + 1 });
  assert('v1 tamper rejected', false);
} catch {
  assert('v1 tamper rejected', true);
}

// v1 malformed
try {
  verifyBrainChange({ v: 1, author: '0xabc', timestamp: 0, automerge: '', sig: '' });
  assert('v1 malformed rejected', false);
} catch {
  assert('v1 malformed rejected', true);
}

// v2 roundtrip
const change = new Uint8Array([0x01, 0x02, 0x03]);
const packed = packChanges([change]);
const env2 = await signBrainChangeV2({
  changeBytes: packed,
  parentCids: ['bafyfake2', 'bafyfake1'],  // unsorted on input
  priority: 2,
}, key);
assert('v2 parentCids sorted canonically', env2.parentCids.join(',') === 'bafyfake1,bafyfake2');
assert('v2 sig verifies', verifyBrainChangeV2(env2) === wallet.address.toLowerCase());

const unpacked = unpackChanges(unwrapChangeBytesV2(env2));
assert('v2 unpack roundtrip', unpacked.length === 1 && Buffer.from(unpacked[0]).toString('hex') === '010203');

// v2 priority invariant
try {
  await signBrainChangeV2({ changeBytes: packed, parentCids: [], priority: 0 }, key);
  assert('v2 priority<1 rejected', false);
} catch {
  assert('v2 priority<1 rejected', true);
}

try {
  await signBrainChangeV2({ changeBytes: packed, parentCids: [], priority: 1.5 }, key);
  assert('v2 priority non-integer rejected', false);
} catch {
  assert('v2 priority non-integer rejected', true);
}

// canonicalMessageV2 determinism
const m1 = canonicalMessageV2('0xabc', 100, 2, ['bafyB', 'bafyA'], '0xff');
const m2 = canonicalMessageV2('0xabc', 100, 2, ['bafyA', 'bafyB'], '0xff');
assert('canonicalMessageV2 parent-order-invariant', m1 === m2);

// packChanges/unpackChanges length-prefix roundtrip
const chunks = [new Uint8Array([1]), new Uint8Array([2, 3]), new Uint8Array([4, 5, 6])];
const packedN = packChanges(chunks);
const unpackedN = unpackChanges(packedN);
assert('packChanges roundtrip 3-chunk', unpackedN.length === 3 &&
  unpackedN[0][0] === 1 && unpackedN[1].length === 2 && unpackedN[2].length === 3);

try {
  unpackChanges(new Uint8Array([0, 0, 0, 99, 1]));
  assert('unpackChanges truncated rejected', false);
} catch {
  assert('unpackChanges truncated rejected', true);
}

// computePriorityV2
assert('computePriorityV2 empty → 1', computePriorityV2([]) === 1);
assert('computePriorityV2 mixed → max+1', computePriorityV2([{priority: 3}, {priority: 7}, {priority: 5}]) === 8);
assert('computePriorityV2 single → +1', computePriorityV2([{priority: 1}]) === 2);

if (failed > 0) {
  console.log(`\nFAILED: ${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nOK');
