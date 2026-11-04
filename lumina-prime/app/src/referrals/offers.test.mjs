import assert from 'node:assert/strict';
import test from 'node:test';
import { referralOffer, demoInvitePath, demoInvitationText } from './offers.ts';

test('referral rewards are explicit examples, never inferred in live mode', () => {
  for (const username of ['alice', 'noe', 'sora', 'mae']) {
    const example = referralOffer(username, 'demo');
    assert.equal(example.status, 'example');
    assert.ok(BigInt(example.potentialTokens) > 0n);
    assert.match(example.source, /démonstration/);
    const real = referralOffer(username, 'live');
    assert.equal(real.potentialTokens, null);
    assert.equal(real.observedAt, null);
    assert.equal(real.status, 'unconfigured');
  }
  assert.equal(referralOffer('unknown', 'demo').potentialTokens, null);
});

test('invitation path carries neither a donation nor a configurable reward', () => {
  const path = demoInvitePath('alice');
  assert.equal(path, 'invite/alice?demo=1');
  assert.doesNotMatch(path, /compose|amount|reward|payment|by=/);
  assert.throws(() => demoInvitePath('alice?amount=999'));
  assert.throws(() => demoInvitePath('../alice'));
  assert.throws(() => demoInvitePath('_alice'));
  assert.match(demoInvitationText('Alice', `mindlumina://${path}`), /aucun gain ni paiement réel/);
});
