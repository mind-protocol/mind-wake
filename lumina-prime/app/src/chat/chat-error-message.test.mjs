import test from 'node:test'; import assert from 'node:assert/strict';
import { ChatClientError, chatErrorMessage } from './client.ts';

test('call errors from the gateway are not shown as a network cut', () => {
  for (const code of ['call_expired', 'call_session_unknown', 'call_revision_conflict', 'call_target_unavailable', 'call_target_not_joined', 'wake_timeout'])
    assert.doesNotMatch(chatErrorMessage(new ChatClientError(code, 409)), /Connexion interrompue/, code);
});
test('unknown codes keep the fallback and show the code; untyped errors stay "injoignable"', () => {
  assert.equal(chatErrorMessage(new ChatClientError('brand_new_code', 500)),
    'Connexion interrompue (brand_new_code). Les messages enregistrés seront retrouvés à la reconnexion.');
  assert.equal(chatErrorMessage(new Error('x')), 'Passerelle Wake injoignable.');
});
