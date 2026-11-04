import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGiftDraft, fetchLiveSnapshot, filterCreators, formatMind, parseAmount, validateDraftCommand, validateLiveSnapshot, xDraftUrl } from './logic.ts';
import { demoSnapshot, disconnectedSnapshot } from './demo.ts';

test('les montants restent exacts et refusent les formats ambigus', () => {
  assert.equal(parseAmount('0,000000001').raw, '1');
  assert.equal(parseAmount('9007199254.740993').raw, '9007199254740993000');
  for (const value of ['0', '-1', '1e3', '1.0000000001', '12 MIND', '18446744074']) assert.throws(() => parseAmount(value));
  assert.equal(formatMind(null), '—');
  assert.equal(formatMind('0'), '0');
});
test('préparer un post ne publie rien et encode le brouillon dans un intent', () => {
  const draft = buildGiftDraft(demoSnapshot.creators[0], '10');
  assert.match(draft, /\+10 MIND @alice$/);
  assert.equal(new URL(xDraftUrl(draft)).searchParams.get('text'), draft);
  assert.throws(() => buildGiftDraft({ username: 'bad user', name: '', title: '' }, '10'));
  assert.equal(validateDraftCommand(draft, 'alice', '10'), null);
  assert.match(validateDraftCommand(draft.replaceAll('@alice', '@bob'), 'alice', '10') ?? '', /destinataire/);
  assert.match(validateDraftCommand(draft, 'alice', '20') ?? '', /montant/);
  assert.match(validateDraftCommand(draft + '\n+20 MIND @bob', 'alice', '10') ?? '', /seule commande/);
});
test('recherche et catégorie se combinent', () => {
  assert.equal(filterCreators(demoSnapshot.creators, 'Tout', 'recherche')[0].username, 'sora');
  assert.equal(filterCreators(demoSnapshot.creators, 'Bâtisseurs', 'Alice').length, 0);
});
test('le mode réel ne réemploie jamais des fixtures ou un faux zéro', async () => {
  assert.throws(() => validateLiveSnapshot(demoSnapshot));
  await assert.rejects(fetchLiveSnapshot(undefined), /pas encore relié/);
  await assert.rejects(fetchLiveSnapshot('https://example.test', { fetchImpl: async () => ({ ok: false }) as Response }), /inconnu/);
  const live = validateLiveSnapshot(disconnectedSnapshot);
  assert.equal(live.balance, null);
});
test('aucun credential n’est accepté dans l’URL de données', async () => {
  await assert.rejects(fetchLiveSnapshot('https://secret:token@example.test/'), /sécurisé/);
});
