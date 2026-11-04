import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import ts from 'typescript';

const require = createRequire(import.meta.url);
let state;
let authState;
let route;
const passthrough = ({ children }) => React.createElement('view', null, children);
function loadScreen(name) {
  const source = readFileSync(new URL(`../src/app/(tabs)/${name}.tsx`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  const mocks = {
    'react-native': { Text: 'text', View: 'view' },
    '@expo/vector-icons': { Ionicons: () => null },
    'expo-router': { useRouter: () => ({ push: value => { route = value; } }) },
    '../../auth/useAuth.ts': { useAuth: () => authState },
    '../../auth/providers.ts': { PROVIDER_LABELS: { x: 'X', telegram: 'Telegram', whatsapp: 'WhatsApp' } },
    '../../state/AppState': { useMind: () => state },
    '../../data/logic.ts': { formatMind: value => value ?? '—' },
    '../../ui/theme': { colors: {}, styles: {} },
    '../../ui/Primitives': {
      Screen: passthrough, Card: passthrough,
      SectionHeading: ({ title }) => React.createElement('text', null, title),
      EmptyState: ({ title, message }) => React.createElement('text', null, title, message),
      Button: props => React.createElement('button', props, props.title),
    },
  };
  new Function('require', 'module', 'exports', compiled)(id => mocks[id] ?? require(id), module, module.exports);
  return module.exports.default;
}
const Account = loadScreen('account');
const Activity = loadScreen('activity');
function render(Screen) {
  const elements = [];
  function visit(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (Array.isArray(node)) return node.map(visit).join(' ');
    if (!React.isValidElement(node)) return String(node);
    if (typeof node.type === 'function') return visit(node.type(node.props));
    elements.push(node);
    return visit(node.props.children);
  }
  return { text: visit(Screen()).replace(/\s+/g, ' ').trim(), elements };
}
function reset(overrides = {}, snapshot = {}) {
  authState = { session: { status: 'signed_out' } };
  route = undefined;
  state = {
    mode: 'live', status: 'ready', error: null, drafts: [], reload() {}, setMode() {},
    ...overrides,
    snapshot: { mode: 'live', balance: null, username: 'vous', observedAt: '2026-11-04T12:00:00Z', receipts: [], ...snapshot },
  };
}

test('account connection and capture links follow their real feature states', () => {
  reset();
  const initial = render(Account);
  initial.elements.find(element => element.type === 'button' && element.props.title === 'Se connecter').props.onPress();
  assert.equal(route, '/login');
  initial.elements.find(element => element.type === 'button' && element.props.title === 'Lire une capture').props.onPress();
  assert.equal(route, '/scan');
  authState = { session: { status: 'signed_in', session: { identity: { provider: 'x', handle: 'alice' } } } };
  const { text } = render(Account);
  assert.match(text, /X · @alice/);
  assert.doesNotMatch(text, /Aucun compte lié|À venir : partager une capture/);
  assert.match(text, /Aucun mandat de paiement actif/);
});
test('connected null balance stays unknown, including a successful read', () => {
  reset();
  const { text } = render(Account);
  assert.match(text, /SOLDE INCONNU/);
  assert.doesNotMatch(text, /SOLDE VÉRIFIÉ|SOLDE LU/);
});
test('loading and unavailable never expose a stale balance', () => {
  for (const status of ['loading', 'unavailable']) {
    reset({ status }, { balance: '98765' });
    const { text } = render(Account);
    assert.match(text, status === 'loading' ? /LECTURE EN COURS/ : /SOLDE INCONNU/);
    assert.doesNotMatch(text, /98765|SOLDE LU|SOLDE VÉRIFIÉ/);
  }
});
test('effective devnet read shows a zero balance and its observation', () => {
  reset({}, { balance: '0' });
  const { text } = render(Account);
  assert.match(text, /SOLDE LU · DEVNET/);
  assert.match(text, /◈ 0/);
  assert.match(text, /Observé le/);
});
test('demo funds and receipts stay explicitly fictitious', () => {
  reset({ mode: 'demo' }, { mode: 'demo', balance: '120', receipts: [{ id: 'demo-1', title: 'Test', detail: '', amount: '-10', at: '', status: 'confirmed' }] });
  assert.match(render(Account).text, /SOLDE D’EXEMPLE/);
  assert.match(render(Account).text, /Montant fictif/);
  assert.match(render(Activity).text, /Exemple · Confirmé/);
  assert.match(render(Activity).text, /Référence fictive/);
  const button = render(Account).elements.find(element => element.type === 'button' && element.props.title === 'Lire mon compte');
  let selected;
  state.setMode = value => { selected = value; };
  render(Account).elements.find(element => element.props.title === button.props.title).props.onPress();
  assert.equal(selected, 'live');
});
test('live mode cannot present a demo snapshot as account data', () => {
  reset({}, { mode: 'demo', balance: '98765', receipts: [{ id: 'mock', title: 'Mock receipt', status: 'confirmed' }] });
  assert.doesNotMatch(render(Account).text, /98765|SOLDE LU/);
  assert.doesNotMatch(render(Activity).text, /Mock receipt/);
});
test('pending and confirmed receipts identify service declarations, not network proof', () => {
  reset({}, { receipts: [
    { id: 'receipt-pending', title: 'A', detail: '', amount: '-10', at: '2026-11-04T12:00:00Z', status: 'pending' },
    { id: 'receipt-confirmed', title: 'B', detail: '', amount: '+5', at: '', status: 'confirmed' },
  ] });
  const { text } = render(Activity);
  assert.match(text, /En attente/);
  assert.match(text, /Confirmé/);
  assert.match(text, /Référence du service : receipt-pending/);
  assert.match(text, /observation du/);
  assert.match(text, /Aucune preuve de transaction réseau/);
  assert.doesNotMatch(text, /Invalid Date/);
});
test('loading or failed receipt reads do not claim an empty history', () => {
  reset({ status: 'loading' });
  assert.match(render(Activity).text, /Lecture des reçus/);
  reset({ status: 'unavailable' });
  assert.match(render(Activity).text, /Reçus non disponibles/);
  assert.doesNotMatch(render(Activity).text, /Aucun reçu dans cette lecture/);
  reset();
  assert.match(render(Activity).text, /Aucun reçu dans cette lecture/);
});

