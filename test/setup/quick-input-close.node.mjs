import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script = fs.readFileSync(new URL('../../desktop/ui/quick-input-close.js', import.meta.url), 'utf8');
function menu(invoke) {
  const clicks = new Map(), keys = new Map(), status = {textContent: ''};
  const button = {addEventListener: (name, fn) => clicks.set(name, fn)};
  vm.runInNewContext(script, {
    document: {getElementById: id => id === 'cancel' ? button : status, addEventListener: (name, fn) => keys.set(name, fn)},
    window: {__TAURI__: {core: {invoke}}},
  });
  return {click: () => clicks.get('click')({preventDefault() {}, stopPropagation() {}}),
    key: key => keys.get('keydown')({key, preventDefault() {}}), status};
}
test('close works without loading the message module or its dependencies', async () => {
  const calls = [], ui = menu(async name => calls.push(name));
  ui.click();
  await Promise.resolve();
  assert.deepEqual(calls, ['quick_input_close']);
});
test('Escape closes; typing does not', () => {
  const calls = [], ui = menu(async name => calls.push(name));
  ui.key('a'); ui.key('Enter'); ui.key('Escape');
  assert.deepEqual(calls, ['quick_input_close']);
});
test('native dismissal failure is visible instead of an unhandled rejection', async () => {
  const ui = menu(async () => { throw new Error('unavailable'); });
  ui.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(ui.status.textContent, /Fermeture impossible.*unavailable/);
});
