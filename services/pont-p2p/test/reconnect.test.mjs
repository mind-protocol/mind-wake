import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { P2PNode } from '../p2p-node.mjs';

test('offline discovery retries independently, coalesces requests and stops with the node', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-discovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 0, joins = 0, refreshes = 0, release;
  const node = new P2PNode({ name: '⬡test', stateDir: dir, now: () => now });
  node.carnet['⬡remote'] = { publicKey: 'test-public-key', source: 'manuel' };
  node.swarm = {
    join: () => { joins++; return { refresh: () => { refreshes++; return new Promise(r => { release = r; }); } }; },
    destroy: async () => {},
  };
  node.discoverOffline();
  assert.equal(joins, 1);
  now = 29_999;
  node.seek('⬡remote');
  await Promise.resolve();
  assert.equal(refreshes, 0);
  now = 30_000;
  node.discoverOffline();
  node.seek('⬡remote');
  await Promise.resolve();
  assert.equal(refreshes, 1);
  now = 90_000;
  node.discoverOffline();
  await Promise.resolve();
  assert.equal(refreshes, 1); // No overlapping discovery.
  release();
  await new Promise(r => setImmediate(r));
  node.peers.set('⬡remote', {});
  node.discoverOffline();
  await Promise.resolve();
  assert.equal(refreshes, 1); // No refresh of connected peers.
  node.peers.clear();
  node.discoverOffline();
  await Promise.resolve();
  assert.equal(refreshes, 2);
  release();
  await new Promise(r => setImmediate(r));
  await node.stop();
  now += 30_000;
  node.discoverOffline();
  node.seek('⬡remote');
  await Promise.resolve();
  assert.equal(refreshes, 2);
  assert.deepEqual(node.outbox, []);
});
