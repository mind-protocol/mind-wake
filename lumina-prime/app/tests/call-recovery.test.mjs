import test from 'node:test';
import assert from 'node:assert/strict';
import { callRecovery, CALL_RECOVERY_KEY, CALL_RECOVERY_MAX_AGE_MS } from '../src/chat/call-recovery.ts';
const value = { handles: ['mind', 'vox'], muted: true, inviteHumans: false, callId: '382582c4-90f8-4dfb-910d-6c976ad77247' };
function storage() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, v) => map.set(key, v), removeItem: key => map.delete(key) };
}
test('a fresh instance recovers participants and muted state after a crash', () => {
  const store = storage();
  callRecovery(store, () => 1000).save(value);
  assert.deepEqual(callRecovery(store, () => 2000).load(), { ...value, at: 1000 });
});
test('explicit hangup prevents recovery', () => {
  const store = storage(), recovery = callRecovery(store);
  recovery.save(value); recovery.clear();
  assert.equal(callRecovery(store).load(), null);
});
test('heartbeat keeps an ongoing call recoverable but old calls do not redial', () => {
  const store = storage(); let now = 1000;
  const recovery = callRecovery(store, () => now);
  recovery.save(value); now += CALL_RECOVERY_MAX_AGE_MS - 1;
  recovery.save({ ...value, handles: ['vox'], muted: false });
  now += 5000; assert.deepEqual(recovery.load().handles, ['vox']);
  now += CALL_RECOVERY_MAX_AGE_MS;
  assert.equal(recovery.load(), null); assert.equal(store.getItem(CALL_RECOVERY_KEY), null);
});
test('malformed or future recovery records are discarded', () => {
  const store = storage(), recovery = callRecovery(store, () => 1000);
  for (const raw of ['invalid', JSON.stringify({ ...value, at: 2000 }), JSON.stringify({ ...value, at: 500, handles: ['invalid handle'] })]) {
    store.setItem(CALL_RECOVERY_KEY, raw); assert.equal(recovery.load(), null);
  }
});
