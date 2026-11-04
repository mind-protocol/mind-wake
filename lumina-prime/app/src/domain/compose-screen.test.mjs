import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as logic from '../data/logic.ts';
import * as commands from './payment-command.ts';
import * as links from '../intake/links.ts';

// Exercise the screen's handlers and derived preview without native services.
function screenHarness(params = { username: 'alice' }, share = async () => ({ action: 'sharedAction' })) {
  const state = []; let cursor = 0; let copied = null; const shared = [];
  const person = { username: 'alice', name: 'Alice', title: 'Mon jardin' };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useMemo: callback => callback(),
    useState: initial => { const index = cursor++; if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
      return [state[index], value => { state[index] = value; }]; },
  };
  const modules = {
    react,
    'react-native': { Linking: { openURL: async () => {} }, Share: { share: async content => { shared.push(content); return share(content); } }, Pressable: 'Pressable', Text: 'Text', TextInput: 'TextInput', View: 'View' },
    'expo-linking': { createURL: (path, options = {}) => `mindlumina://${path}${Object.keys(options.queryParams ?? {}).length ? `?${new URLSearchParams(options.queryParams)}` : ''}` },
    '../../intake/links.ts': links,
    'expo-router': { useLocalSearchParams: () => params, useRouter: () => ({}) },
    'expo-clipboard': { setStringAsync: async text => { copied = text; } },
    '@expo/vector-icons': { Ionicons: 'Ionicons' },
    '../../state/AppState': { useMind: () => ({ snapshot: { creators: [person] }, keepDraft: () => {}, mode: 'demo' }) },
    '../../data/logic.ts': logic,
    '../../domain/payment-command.ts': commands,
    '../../ui/Primitives': { Avatar: 'Avatar', Button: 'Button', Card: 'Card', EmptyState: 'EmptyState', Screen: 'Screen' },
    '../../ui/theme': { colors: {}, styles: {} },
  };
  const source = readFileSync(new URL('../app/compose/[username].tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { exports: module.exports, require: name => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`); return modules[name];
  } });
  const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value && typeof value === 'object'
    ? [value, ...flatten(value.children)] : [];
  let nodes;
  const render = () => { cursor = 0; nodes = flatten(module.exports.default()); };
  render();
  return {
    render,
    input: label => nodes.find(node => node.props.accessibilityLabel === label),
    button: title => nodes.find(node => node.props.title === title),
    text: () => JSON.stringify(nodes),
    copied: () => copied,
    shared: () => shared,
  };
}

test('canonical preview identifies a Don before sharing; copy preserves authored words', async () => {
  const h = screenHarness();
  const authored = 'Voici pourquoi je le recommande.\n◈ 10,00 @alice';
  h.input('Texte du post à personnaliser').props.onChangeText(authored); h.render();
  assert.match(h.text(), /Nature : don/);
  assert.match(h.text(), /◈ 10 @alice/);
  assert.equal(h.button('Copier le post').props.disabled, false);
  await h.button('Copier le post').props.onPress();
  assert.equal(h.copied(), authored);
});

test('changing the amount preserves edited text and blocks mismatched sharing', () => {
  const h = screenHarness(); const authored = 'Mes mots.\n+10 MIND @alice';
  h.input('Texte du post à personnaliser').props.onChangeText(authored); h.render();
  h.input('Montant du soutien').props.onChangeText('20'); h.render();
  assert.equal(h.input('Texte du post à personnaliser').props.value, authored);
  for (const title of ['Copier le post', 'Ouvrir le brouillon dans X', 'Garder dans mes brouillons']) {
    assert.equal(h.button(title).props.disabled, true);
  }
  assert.match(h.text(), /montant du texte doit correspondre/);
});

test('wrong recipient and multiple command aliases cannot be shared', () => {
  for (const text of ['Ma découverte.\n+10 MIND @bob', 'Ma découverte.\n+10 MIND @alice\n$MIND 10 @alice']) {
    const h = screenHarness(); h.input('Texte du post à personnaliser').props.onChangeText(text); h.render();
    assert.equal(h.button('Copier le post').props.disabled, true);
    assert.equal(h.button('Ouvrir le brouillon dans X').props.disabled, true);
  }
});

test('a received link pre-fills amount and note, and says it is not an authorization', () => {
  const h = screenHarness({ username: 'alice', amount: '20', note: 'Bravo pour le jardin' });
  assert.equal(h.input('Montant du soutien').props.value, '20');
  const draft = h.input('Texte du post à personnaliser').props.value;
  assert.ok(draft.startsWith('Bravo pour le jardin\n'), draft);
  assert.ok(draft.endsWith('\n+20 MIND @alice'), draft);
  assert.match(h.text(), /Pré-rempli depuis un lien reçu/);
  assert.match(h.text(), /pas une autorisation/);
  assert.ok(h.text().includes('"Commande reconnue : ","◈ 20 @alice"'));
  assert.equal(h.copied(), null);
  assert.deepEqual(h.shared(), []);
});

test('invalid link parameters are ignored, listed, and the default draft stays', () => {
  const h = screenHarness({ username: 'alice', amount: '-5', note: '+1000 MIND @bob', pay: 'now' });
  assert.equal(h.input('Montant du soutien').props.value, '10');
  assert.doesNotMatch(h.input('Texte du post à personnaliser').props.value, /bob/);
  assert.ok(h.text().includes('Paramètres ignorés : amount (montant invalide'));
  assert.ok(h.text().includes('note (une note ne peut pas contenir de commande'));
  assert.ok(h.text().includes('pay (paramètre inconnu)'));
  assert.doesNotMatch(h.text(), /Pré-rempli depuis/);
});

test('a capture pre-fill is labelled as such', () => {
  const h = screenHarness({ username: 'alice', amount: '2,5', via: 'capture' });
  assert.equal(h.input('Montant du soutien').props.value, '2.5');
  assert.match(h.text(), /Pré-rempli depuis une capture/);
});

test('share sends a compose link with the current amount, and falls back to copying it', async () => {
  const h = screenHarness();
  await h.button('Partager le lien').props.onPress();
  assert.equal(h.shared().length, 1);
  assert.ok(h.shared()[0].message.includes('mindlumina://compose/alice?amount=10'));
  assert.match(h.shared()[0].message, /aucun paiement/);
  const failing = screenHarness({ username: 'alice' }, async () => { throw Error('Share is not supported'); });
  await failing.button('Partager le lien').props.onPress();
  assert.equal(failing.copied(), 'mindlumina://compose/alice?amount=10');
});
