import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as offers from '../src/referrals/offers.ts';

// Exercise screen event handlers and rendered content without a device or server.
function screen(path, state, username = 'artist', openURL = async () => true) {
  const pushes = [];
  const component = name => name;
  const react = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), useState: value => [value, () => {}] };
  const primitives = new Proxy({}, { get: (_, key) => component(key) });
  const modules = {
    react, 'react-native': { ...Object.fromEntries(['Pressable', 'ScrollView', 'Text', 'TextInput', 'View'].map(name => [name, name])), useWindowDimensions: () => ({ width: 390 }) },
    'expo-router': { useRouter: () => ({ push: route => pushes.push(route), canGoBack: () => false, replace: route => pushes.push(route) }), useLocalSearchParams: () => ({ username }) },
    'expo-linking': { openURL }, '@expo/vector-icons': { Ionicons: 'Icon' }, 'expo-linear-gradient': { LinearGradient: 'Gradient' },
    '../../state/AppState': { useMind: () => state },
    '../../data/logic.ts': { filterCreators: creators => creators },
    '../../referrals/offers.ts': offers,
    '../../ui/Primitives': primitives,
    '../../ui/theme': { colors: {}, styles: {} },
  };
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, require: name => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency ${name}`);
    return modules[name];
  }, URL });
  return { tree: exports.default(), pushes };
}

function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes);
  return value && typeof value === 'object' && 'children' in value ? [value, ...nodes(value.children)] : [];
}
function text(value) {
  if (Array.isArray(value)) return value.map(text).join('');
  return value && typeof value === 'object' ? text(value.children) : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
const person = { username: 'artist', name: 'Artiste', initials: 'A', color: '#fff', role: 'Créatrice', title: 'Un projet', description: 'Un travail à explorer', reasons: [], tags: [], spark: [], signals: [{ label: 'Projet', value: '1', detail: 'Une livraison', source: 'https://example.org/work', observedAt: '2026-11-04T12:00:00Z' }] };
const state = (creators, mode = 'live', status = 'ready') => ({ snapshot: { creators }, mode, status });

test('live radar keeps signal provenance but cannot promise a referral reward', () => {
  const { tree, pushes } = screen('../src/app/(tabs)/index.tsx', state([person]));
  assert.match(text(tree), /Source : https:\/\/example.org\/work/);
  assert.match(text(tree), /04\/11\/2026/);
  nodes(tree).find(node => node.props.title === 'Découvrir Artiste').props.onPress();
  assert.equal(pushes[0].pathname, '/creator/[username]');
  assert.match(text(tree), /Montant non configuré/);
  assert.equal(nodes(tree).find(node => node.props.title === 'Inviter Artiste').props.disabled, true);
  assert.equal(pushes.length, 1);
});

test('demo radar leads with the inviter reward and uses a distinct invitation route', () => {
  const { tree, pushes } = screen('../src/app/(tabs)/index.tsx', state([{ ...person, username: 'alice', name: 'Alice' }], 'demo'));
  assert.match(text(tree), /Ce que tu peux gagner/);
  assert.match(text(tree), /POUR TOI, LE PARRAIN · EXEMPLE/);
  assert.match(text(tree), /\+100 ◈/);
  assert.match(text(tree), /aucun budget réservé/);
  const invite = nodes(tree).find(node => node.props.title === 'Inviter Alice');
  assert.equal(invite.props.disabled, false);
  invite.props.onPress();
  assert.equal(pushes[0].pathname, '/invite/[username]');
  assert.equal(pushes[0].params.username, 'alice');
  assert.notEqual(pushes[0].pathname, '/compose/[username]');
});

test('live radar has an honest empty state without injecting demo profiles', () => {
  const { tree } = screen('../src/app/(tabs)/index.tsx', state([]));
  const empty = nodes(tree).find(node => node.type === 'EmptyState');
  assert.match(empty.props.title, /Aucun profil/);
  assert.match(empty.props.message, /n’a transmis aucun profil/);
  assert.equal(nodes(tree).some(node => node.props.title === 'Découvrir Artiste'), false);
});

test('profile opens only a supplied HTTP(S) source and support only navigates', async () => {
  const opened = [];
  const { tree, pushes } = screen('../src/app/creator/[username].tsx', state([person]), 'artist', async url => { opened.push(url); });
  nodes(tree).find(node => node.props.title === 'Ouvrir la source').props.onPress();
  assert.deepEqual(opened, ['https://example.org/work']);
  nodes(tree).find(node => node.props.title === 'Préparer un soutien à Artiste').props.onPress();
  assert.equal(pushes[0].pathname, '/compose/[username]');
  assert.match(text(tree), /sans publier ni payer/);
  for (const source of ['javascript:alert(1)', 'file:///secret', 'https://user:pass@example.org', 'Texte sans lien']) {
    const unsafe = { ...person, signals: [{ ...person.signals[0], source, observedAt: 'invalid' }] };
    const result = screen('../src/app/creator/[username].tsx', state([unsafe]));
    assert.equal(nodes(result.tree).some(node => node.props.title === 'Ouvrir la source'), false);
    assert.match(text(result.tree), /Date non fournie/);
  }
});

test('demo profile keeps its fictional project explicit, and missing profile has no support action', () => {
  const { tree } = screen('../src/app/creator/[username].tsx', state([person], 'demo'));
  assert.match(text(tree), /profil fictif/);
  const missing = screen('../src/app/creator/[username].tsx', state([]));
  assert.equal(nodes(missing.tree).some(node => node.props.title === 'Préparer un soutien à Artiste'), false);
});
