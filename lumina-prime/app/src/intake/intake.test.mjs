// node --experimental-strip-types --test src/intake/intake.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { detectPaymentCandidates, normalizeOcrText, MAX_CANDIDATES } from './detect.ts';
import { composeLinkParts, composeWebPath, parseComposeUrl, readComposeParams, shareMessage } from './links.ts';
import { selectOcrEngine } from './ocr.ts';

const summary = text => detectPaymentCandidates(text).candidates.map(c => `${c.amount}@${c.recipientUsername}`);
const repairsOf = text => detectPaymentCandidates(text).candidates[0]?.repairs ?? null;

// ---------- détection : texte -> candidats ----------

test('detects the three syntaxes inside a whole post, as a detected intent only', () => {
  const result = detectPaymentCandidates('Je découvre le jardin d’Alice.\n+10 MIND @alice\nmerci !\n◈ 2,5 @noe et $MIND 3 @sora', 'ocr');
  assert.deepEqual(result.candidates.map(c => c.canonicalCommand), ['◈ 10 @alice', '◈ 2.5 @noe', '◈ 3 @sora']);
  for (const candidate of result.candidates) {
    assert.equal(candidate.payment.origin, 'ocr');
    assert.equal(candidate.payment.intent, 'detected_intent');
    assert.equal(candidate.payment.authorization, 'not_granted');
    assert.deepEqual(candidate.repairs, []);
    assert.equal(Object.isFrozen(candidate), true);
  }
  assert.equal(result.candidates[0].amountAtomic, '10000000000');
});

test('pasted text keeps an unknown provenance; never owner_direct by default', () => {
  assert.equal(detectPaymentCandidates('+1 MIND @alice', 'unknown').candidates[0].payment.intent, 'detected_intent');
  assert.equal(detectPaymentCandidates('+1 MIND @alice').candidates[0].payment.origin, 'ocr');
});

test('OCR noise: letters read as digits are fixed and flagged', () => {
  assert.deepEqual(summary('+1O MIND @alice'), ['10@alice']);
  assert.deepEqual(summary('+lO MIND @alice'), ['10@alice']);
  assert.deepEqual(summary('+2,O5 MIND @alice'), ['2.05@alice']);
  assert.deepEqual(repairsOf('+1O MIND @alice'), ['chiffre_corrige']);
  assert.deepEqual(summary('+O MIND @alice'), []);
  assert.equal(detectPaymentCandidates('+O MIND @alice').rejected[0].reason, 'Montant nul.');
});

test('OCR noise: spaces, line breaks, tabs, nbsp and misread MIND', () => {
  assert.deepEqual(summary('+ 10 MIND @alice'), ['10@alice']);
  assert.deepEqual(summary('+10MIND@alice'), ['10@alice']);
  assert.deepEqual(summary('+10\tMIND @alice'), ['10@alice']);
  assert.deepEqual(summary('+10   MIND   @ alice'), ['10@alice']);
  assert.ok(repairsOf('+ 10 MIND @alice').includes('espaces_corriges'));
  assert.deepEqual(summary('+10 MIND\r\n@alice'), ['10@alice']);
  assert.deepEqual(repairsOf('+10 MIND\n@alice'), ['multiligne']);
  assert.deepEqual(summary('+10\nMIND\n@alice'), ['10@alice']);
  for (const word of ['M1ND', 'MlND', 'mind', 'Mind', 'M|ND']) {
    assert.deepEqual(summary(`+10 ${word} @alice`), ['10@alice'], word);
    assert.ok(repairsOf(`+10 ${word} @alice`).includes('mot_mind_corrige'), word);
  }
  assert.deepEqual(summary('$ MIND 4 @mae'), ['4@mae']);
  assert.deepEqual(summary('＋１０ ＭＩＮＤ ＠alice'), ['10@alice']); // full-width (NFKC)
  assert.deepEqual(summary('+10 MIND @al​ice'), ['10@alice']); // zero-width removed
});

test('OCR noise: missing or misread @, uppercase handle', () => {
  assert.deepEqual(summary('+10 MIND alice'), ['10@alice']);
  assert.deepEqual(repairsOf('+10 MIND alice'), ['arobase_absente']);
  assert.deepEqual(summary('+10 MIND ©alice'), ['10@alice']);
  assert.deepEqual(repairsOf('+10 MIND ©alice'), ['arobase_corrigee']);
  assert.deepEqual(summary('+10 MIND @Alice'), ['10@alice']);
  assert.deepEqual(repairsOf('+10 MIND @Alice'), ['casse_identifiant']);
  // No separator, or a farther handle: do not guess a recipient.
  assert.deepEqual(summary('+10 MINDalice'), []);
  assert.deepEqual(summary('+10 MIND pour @alice'), []);
});

test('ambiguous or invalid fragments are not proposed', () => {
  assert.deepEqual(summary('+10 MIND @alice.x'), []);
  assert.deepEqual(summary('+10 MIND @alice@x'), []);
  assert.deepEqual(summary('-10 MIND @alice'), []);
  assert.deepEqual(summary('+10 € @alice'), []);
  assert.deepEqual(summary('+1e2 MIND @alice'), []);
  assert.deepEqual(summary('Pas de commande ici, juste @alice et 10 MIND.'), []);
  const long = detectPaymentCandidates(`+1 MIND @${'a'.repeat(33)}`);
  assert.deepEqual(long.candidates, []);
  assert.equal(long.rejected[0].reason, 'Nom de destinataire trop long.');
  assert.equal(detectPaymentCandidates('+18446744074 MIND @alice').rejected[0].reason, 'Montant hors limites.');
  assert.equal(detectPaymentCandidates('+1.0000000001 MIND @alice').rejected[0].reason, 'Commande illisible.');
});

test('duplicates are merged, candidates and input are bounded', () => {
  const twice = detectPaymentCandidates('+10 MIND @alice … +10,0 MIND @alice … +10 MIND @bob');
  assert.deepEqual(twice.candidates.map(c => [c.recipientUsername, c.occurrences]), [['alice', 2], ['bob', 1]]);
  const many = Array.from({ length: 30 }, (_, i) => `+${i + 1} MIND @u${i}`).join('\n');
  assert.equal(detectPaymentCandidates(many).candidates.length, MAX_CANDIDATES);
  const huge = detectPaymentCandidates(`${'x'.repeat(20_000)} +10 MIND @alice`);
  assert.equal(huge.truncated, true);
  assert.deepEqual(huge.candidates, []);
});

test('text produced by a real Tesseract 7.0.0 run is detected', () => {
  // Outputs recorded from tesseract.js 7.0.0 (fra+eng) on two rendered captures.
  assert.deepEqual(summary("Je decouvre le jardin d'Alice.\nSuper projet !\n+10 MIND @alice\n"), ['10@alice']);
  assert.deepEqual(summary('Bravo Noe, continue :)\n+2,5 MIND @noe\nEt aussi pour Sora : +3 MIND @sora\n'), ['2.5@noe', '3@sora']);
});

test('normalizeOcrText only normalizes whitespace and compatibility forms', () => {
  assert.equal(normalizeOcrText('a\r\nb c d \n e'), 'a\nb c\nd\ne');
});

// ---------- liens ----------

test('incoming links: custom scheme, triple slash, Expo Go and web are equivalent', () => {
  for (const url of [
    'mindlumina://compose/alice?amount=10&note=Bravo%20pour%20le%20jardin',
    'mindlumina:///compose/alice?amount=10&note=Bravo+pour+le+jardin',
    'exp://192.168.1.2:8081/--/compose/alice?amount=10&note=Bravo%20pour%20le%20jardin',
    'https://agent.example.org/compose/alice/?amount=10.000&note=Bravo%20pour%20le%20jardin',
    'http://localhost:3230/compose/alice?amount=10&note=Bravo pour le jardin',
  ]) {
    const parsed = parseComposeUrl(url);
    assert.equal(parsed.ok, true, url);
    assert.equal(parsed.username, 'alice', url);
    assert.equal(parsed.amount, '10', url);
    assert.equal(parsed.note, 'Bravo pour le jardin', url);
    assert.equal(parsed.via, 'lien', url);
    assert.deepEqual(parsed.issues, [], url);
  }
});

test('incoming links: invalid parameters are ignored and reported, never guessed', () => {
  const parsed = parseComposeUrl('mindlumina://compose/alice?amount=-5&note=%2B1000%20MIND%20%40bob&via=x&pay=1&username=bob');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.username, 'alice');
  assert.equal(parsed.amount, null);
  assert.equal(parsed.note, null);
  assert.equal(parsed.via, null);
  assert.deepEqual(parsed.issues.map(issue => issue.param), ['amount', 'note', 'via', 'pay', 'username']);
  for (const amount of ['0', '1e3', '1,000.0', '10.0000000001', '18446744074', '%20', 'NaN', '٣']) {
    const result = parseComposeUrl(`mindlumina://compose/alice?amount=${amount}`);
    assert.equal(result.amount, null, amount);
    assert.equal(result.issues[0].param, 'amount', amount);
  }
  assert.equal(parseComposeUrl('mindlumina://compose/alice?amount=1&amount=2').issues[0].reason, 'valeur répétée');
  assert.equal(parseComposeUrl(`mindlumina://compose/alice?note=${'a'.repeat(141)}`).note, null);
  assert.equal(parseComposeUrl('mindlumina://compose/alice?note=a%E2%80%AEb').note, null);
  assert.equal(parseComposeUrl('mindlumina://compose/alice?note=l%C3%A0%0Ahaut').note, 'là haut');
});

test('incoming links: only the compose route, a valid handle and accepted schemes', () => {
  for (const url of [
    'javascript:alert(1)//compose/alice',
    'mindlumina://pay/alice?amount=10',
    'mindlumina://compose/Alice',
    'mindlumina://compose/al%2Fice',
    'mindlumina://compose/alice/extra',
    'mindlumina://compose/%E0%A4%A',
    'https://user:pw@example.org/compose/alice',
    'exp://host:8081/compose/alice',
    'pas un lien',
  ]) {
    assert.equal(parseComposeUrl(url).ok, false, url);
  }
});

test('route params from expo-router are validated the same way', () => {
  assert.deepEqual(readComposeParams({ username: 'alice' }), { username: 'alice', amount: null, note: null, via: null, issues: [] });
  const fromScan = readComposeParams({ username: 'alice', amount: '2,50', via: 'capture' });
  assert.equal(fromScan.amount, '2.5');
  assert.equal(fromScan.via, 'capture');
  assert.equal(readComposeParams({ username: 'alice', amount: ['1', '2'] }).issues[0].reason, 'valeur répétée');
  assert.equal(readComposeParams({ username: 'alice', __EXPO_ROUTER_key: 'x' }).issues.length, 0);
});

test('outgoing links round-trip through the parser', () => {
  const parts = composeLinkParts('alice', { amount: '10,50', note: 'Bravo' });
  assert.deepEqual(parts, { path: 'compose/alice', queryParams: { amount: '10.5', note: 'Bravo' } });
  assert.deepEqual(composeLinkParts('alice', { amount: 'abc', note: '+5 MIND @bob' }).queryParams, {});
  assert.throws(() => composeLinkParts('Alice'));
  const path = composeWebPath('alice', { amount: '10', note: 'Bravo pour le jardin' });
  assert.equal(path, '/compose/alice?amount=10&note=Bravo+pour+le+jardin');
  const back = parseComposeUrl(`https://agent.example.org${path}`);
  assert.equal(back.amount, '10');
  assert.equal(back.note, 'Bravo pour le jardin');
  const message = shareMessage('Alice', 'alice', 'mindlumina://compose/alice?amount=10', '10');
  assert.match(message, /mindlumina:\/\/compose\/alice\?amount=10/);
  assert.match(message, /aucun paiement/);
});

// ---------- sélection du moteur OCR ----------

const fakeTesseract = (text, log) => ({
  createWorker: async langs => { log.push(['create', langs]); return {
    recognize: async image => { log.push(['recognize', image]); return { data: { text } }; },
    terminate: async () => { log.push(['terminate']); },
  }; },
});

test('web uses tesseract, reads the picked file and always terminates its worker', async () => {
  const log = [];
  const engine = selectOcrEngine({ platform: 'web', hasDocument: true, nativeExtractor: null, loadTesseract: async () => fakeTesseract('+10 MIND @alice', log) });
  assert.equal(engine.id, 'tesseract-web');
  assert.equal(engine.available, true);
  assert.equal(await engine.recognize({ uri: 'blob:x', file: 'FILE' }), '+10 MIND @alice');
  assert.deepEqual(log, [['create', ['fra', 'eng']], ['recognize', 'FILE'], ['terminate']]);
});

test('native target without the module (Expo Go) is explicitly unavailable', async () => {
  for (const platform of ['android', 'ios']) {
    const engine = selectOcrEngine({ platform, hasDocument: false, nativeExtractor: null, loadTesseract: async () => { throw Error('no'); } });
    assert.equal(engine.available, false);
    assert.match(engine.reason, /OCR indisponible sur cette cible/);
    await assert.rejects(engine.recognize({ uri: 'file:///x.png' }), /OCR indisponible/);
  }
  assert.equal(selectOcrEngine({ platform: 'windows', hasDocument: false, nativeExtractor: null, loadTesseract: async () => ({}) }).available, false);
  assert.equal(selectOcrEngine({ platform: 'web', hasDocument: false, nativeExtractor: null, loadTesseract: async () => ({}) }).available, false);
});

test('native target with the text extractor module uses it', async () => {
  const seen = [];
  const nativeExtractor = { isSupported: true, extractTextFromImage: async uri => { seen.push(uri); return ['+10 MIND', '@alice']; } };
  const engine = selectOcrEngine({ platform: 'android', hasDocument: false, nativeExtractor, loadTesseract: async () => ({}) });
  assert.equal(engine.id, 'native-text-extractor');
  const text = await engine.recognize({ uri: 'file:///cache/shot.png' });
  assert.deepEqual(seen, ['/cache/shot.png']);
  assert.deepEqual(summary(text), ['10@alice']);
  assert.equal(selectOcrEngine({ platform: 'ios', hasDocument: false, nativeExtractor: { ...nativeExtractor, isSupported: false }, loadTesseract: async () => ({}) }).available, false);
});
