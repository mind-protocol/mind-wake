import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as offers from '../src/referrals/offers.ts';

function render(mode) {
  const calls = { share: [], copy: [], links: [], notice: null };
  const react = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), useState: value => [value, next => { calls.notice = next; }] };
  const modules = {
    react,
    'react-native': { Pressable: 'Pressable', Text: 'Text', View: 'View', Share: { dismissedAction: 'dismissed', share: async payload => { calls.share.push(payload); return { action: 'dismissed' }; } } },
    'expo-router': { useRouter: () => ({ canGoBack: () => false, replace() {} }), useLocalSearchParams: () => ({ username: 'alice' }) },
    'expo-linking': { createURL: path => { calls.links.push(path); return `mindlumina://${path}`; } },
    'expo-clipboard': { setStringAsync: async value => { calls.copy.push(value); } },
    '../../state/AppState': { useMind: () => ({ mode, snapshot: { creators: [{ username: 'alice', name: 'Alice' }] } }) },
    '../../referrals/offers.ts': offers,
    '../../ui/Primitives': Object.fromEntries(['Avatar', 'Button', 'Card', 'EmptyState', 'Screen'].map(key => [key, key])),
    '../../ui/theme': { colors: {}, styles: {} },
  };
  const source = ts.transpileModule(readFileSync(new URL('../src/app/invite/[username].tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, require: name => { assert.ok(Object.hasOwn(modules, name)); return modules[name]; } });
  function nodes(value) { return Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'children' in value ? [value, ...nodes(value.children)] : []; }
  const tree = exports.default();
  return { calls, buttons: nodes(tree).filter(node => node.type === 'Button') };
}

test('invitation is prepared without sending, and cancellation creates no confirmation', async () => {
  const { calls, buttons } = render('demo');
  assert.equal(calls.share.length, 0);
  assert.equal(calls.copy.length, 0);
  assert.equal(calls.links[0], 'invite/alice?demo=1');
  await buttons.find(button => button.props.title === 'Préparer le partage').props.onPress();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.share.length, 1);
  assert.match(calls.share[0].message, /aucun gain ni paiement réel/);
  assert.match(calls.notice, /Partage annulé/);
  await buttons.find(button => button.props.title === 'Copier le lien d’invitation').props.onPress();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.copy[0], 'mindlumina://invite/alice?demo=1');
  assert.match(calls.notice, /n’est pas envoyé/);
});

test('live invitation cannot manufacture a reward or share a demo attribution', async () => {
  const { calls, buttons } = render('live');
  assert.equal(calls.links.length, 0);
  for (const button of buttons) {
    assert.equal(button.props.disabled, true);
    await button.props.onPress();
  }
  assert.equal(calls.share.length, 0);
  assert.equal(calls.copy.length, 0);
});
