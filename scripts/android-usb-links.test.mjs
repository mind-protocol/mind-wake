import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureAndroidUsbLinks } from './android-usb-links.mjs';
const config = { adb: 'adb-fixture', serial: 'Samsung-fixture', ports: [8081, 8789, 8792] };
function fixture(rows = []) {
  const calls = []; const mappings = [...rows];
  const run = (_exe, args) => {
    calls.push(args.slice(2)); const command = args.slice(2);
    if (command[0] === 'get-state') return 'device\n';
    if (command[1] === '--list') return mappings.join('\n');
    mappings.push(`UsbFfs ${command[1]} ${command[2]}`); return '';
  };
  return { calls, mappings, run };
}
test('USB reconnect restores missing mappings, preserves other links and is idempotent', () => {
  const f = fixture(['UsbFfs tcp:9999 tcp:9999']);
  assert.deepEqual(ensureAndroidUsbLinks(config, f.run), { status: 'connected', repaired: [8081, 8789, 8792] });
  assert.deepEqual(ensureAndroidUsbLinks(config, f.run), { status: 'connected', repaired: [] });
  assert.equal(f.calls.filter(c => c[0] === 'reverse' && c[1] !== '--list').length, 3);
  assert.ok(f.mappings.includes('UsbFfs tcp:9999 tcp:9999'));
});
test('conflicting mapping is refused before changing any link', () => {
  const f = fixture(['UsbFfs tcp:8792 tcp:6666']);
  assert.throws(() => ensureAndroidUsbLinks(config, f.run), /usb_link_conflict/);
  assert.equal(f.calls.some(c => c[0] === 'reverse' && c[1] !== '--list'), false);
});
test('disconnected phone waits, unauthorized access is not bypassed', () => {
  assert.equal(ensureAndroidUsbLinks(config, () => { throw { stderr: 'device not found' }; }).status, 'waiting_phone');
  assert.throws(() => ensureAndroidUsbLinks(config, () => { throw Error('unauthorized'); }), /unauthorized/);
});
test('failed ADB success without the mapping is rejected', () => {
  assert.throws(() => ensureAndroidUsbLinks(config, (_exe,args) => args[2] === 'get-state' ? 'device' : ''), /not_confirmed/);
});
