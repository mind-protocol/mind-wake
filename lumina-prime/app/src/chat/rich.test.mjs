import test from 'node:test'; import assert from 'node:assert/strict';
import { parseInline, parseMarkdownDoc, parseRich, resolveDocLink, tintOf, TINTS } from './client.ts';

test('inline markdown: bold, italic, code, links', () => {
  assert.deepEqual(parseInline('a **b** *c* `d` [e](https://x.io) https://y.io/z.'), [
    { kind: 'text', text: 'a ' }, { kind: 'bold', text: 'b' }, { kind: 'text', text: ' ' }, { kind: 'italic', text: 'c' },
    { kind: 'text', text: ' ' }, { kind: 'code', text: 'd' }, { kind: 'text', text: ' ' }, { kind: 'link', text: 'e', url: 'https://x.io' },
    { kind: 'text', text: ' ' }, { kind: 'link', text: 'https://y.io/z', url: 'https://y.io/z' }, { kind: 'text', text: '.' }]);
  assert.deepEqual(parseInline('2 * 3 * 4 et snake_case_name'), [{ kind: 'text', text: '2 * 3 * 4 et snake_case_name' }]);
});

test('images: markdown syntax and bare image URLs become image blocks; line breaks kept', () => {
  const blocks = parseRich('Voici\nla carte ![plan](https://a.io/p.png)\npuis https://b.io/c.JPG?x=1 fin');
  assert.deepEqual(blocks.map(b => b.kind), ['text', 'image', 'text', 'image', 'text']);
  assert.equal(blocks[0].inlines[0].text, 'Voici\nla carte ');
  assert.deepEqual(blocks[1], { kind: 'image', url: 'https://a.io/p.png', alt: 'plan' });
  assert.equal(blocks[3].url, 'https://b.io/c.JPG?x=1');
  assert.deepEqual(parseRich('page https://a.io/doc.html'), [{ kind: 'text', inlines: [{ kind: 'text', text: 'page ' }, { kind: 'link', text: 'https://a.io/doc.html', url: 'https://a.io/doc.html' }] }]);
});

test('bubble tint is stable per sender and drawn from the palette', () => {
  assert.equal(tintOf('Marco'), tintOf(' marco '));
  assert.ok(TINTS.includes(tintOf('Gardien de VOX')));
  assert.ok(new Set(['Marco', 'VOX', 'Crypto', 'Viz', 'Zénith', 'Room 1'].map(tintOf)).size >= 3);
});

test('shared files: [fichier: …] and bare Windows .md/.pdf paths become file blocks', () => {
  const cv = 'C:\\Users\\reyno\\AppData\\Local\\mind-wake-essai\\workspace\\artifacts\\projets\\emploi-remote\\agents\\se-vendre\\CV-BASE-VERIFIEE-TRAVAIL.md';
  const blocks = parseRich(`Voici le CV :\n[fichier: ${cv}]\nDis-moi.`);
  assert.deepEqual(blocks.map(b => b.kind), ['text', 'file', 'text']);
  assert.deepEqual(blocks[1], { kind: 'file', path: cv, name: 'CV-BASE-VERIFIEE-TRAVAIL.md', type: 'md' });
  assert.equal(blocks[0].inlines[0].text, 'Voici le CV :');
  // Chemin nu, éventuellement entre backticks ou suivi d'une ponctuation ; PDF ; barres obliques.
  const bare = parseRich('Lis `C:\\w\\a b\\x.md` puis C:\\w\\rapport.PDF. Et C:/w/n.md');
  assert.deepEqual(bare.filter(b => b.kind === 'file').map(b => [b.path, b.type]),
    [['C:\\w\\a b\\x.md', 'md'], ['C:\\w\\rapport.PDF', 'pdf'], ['C:/w/n.md', 'md']]);
  assert.deepEqual(parseRich('ouvre C:\\w\\plan.pdf').at(-1), { kind: 'file', path: 'C:\\w\\plan.pdf', name: 'plan.pdf', type: 'pdf' });
  assert.deepEqual(parseRich('`C:\\w\\x.md`'), [{ kind: 'file', path: 'C:\\w\\x.md', name: 'x.md', type: 'md' }]);
  // [fichier:] garde les espaces et tout type (aperçu indisponible) ; un texte non absolu reste du texte.
  assert.deepEqual(parseRich('[fichier: C:\\w\\Mon dossier\\note finale.md]')[0], { kind: 'file', path: 'C:\\w\\Mon dossier\\note finale.md', name: 'note finale.md', type: 'md' });
  assert.equal(parseRich('[fichier: C:\\w\\data.json]')[0].type, 'other');
  assert.deepEqual(parseRich('[fichier: rien]').map(b => b.kind), ['text']);
  // Les URLs web ne deviennent pas des fichiers ; un chemin relatif à un dossier, si (résolu par la passerelle).
  assert.deepEqual(parseRich('https://a.io/C:/doc.md et https://a.io/docs/README.md').map(b => b.kind), ['text']);
  assert.deepEqual(parseRich('README.md seul reste du texte').map(b => b.kind), ['text']);
  assert.deepEqual(parseRich('img https://a.io/p.png et C:\\w\\a.md').map(b => b.kind), ['text', 'image', 'text', 'file']);
});

test('markdown document: headings, lists, quotes, code, tables, paragraphs', () => {
  const doc = parseMarkdownDoc('# Titre\n\nUn **paragraphe**\nsur deux lignes.\n\n- un\n  suite\n  - deux\n1. trois\n> cité\n\n```\ncode\n```\n---\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.deepEqual(doc, [
    { kind: 'heading', level: 1, text: 'Titre' }, { kind: 'paragraph', text: 'Un **paragraphe**\nsur deux lignes.' },
    { kind: 'bullet', text: 'un suite', marker: '•', depth: 0 }, { kind: 'bullet', text: 'deux', marker: '•', depth: 1 },
    { kind: 'bullet', text: 'trois', marker: '1.', depth: 0 }, { kind: 'quote', text: 'cité' }, { kind: 'code', text: 'code' },
    { kind: 'rule' }, { kind: 'table', header: ['a', 'b'], rows: [['1', '2']] }]);
  // Tableau sans en-tête, cellule vide et barre échappée.
  assert.deepEqual(parseMarkdownDoc('| x | a \\| b |\n|  | z |'), [{ kind: 'table', header: [], rows: [['x', 'a | b'], ['', 'z']] }]);
});

test('shared files: relative paths, markdown links, file:// URLs and backticked paths with spaces', () => {
  const files = text => parseRich(text).filter(b => b.kind === 'file').map(b => b.path);
  assert.deepEqual(files('Brouillon : artifacts/projets/emploi-remote/commun/candidature-soda.md.'),
    ['artifacts/projets/emploi-remote/commun/candidature-soda.md']);
  assert.deepEqual(files('voir docs\\FORKS.md et ./notes/a.pdf'), ['docs\\FORKS.md', './notes/a.pdf']);
  assert.deepEqual(files('[la lettre](commun/lettre.md) puis [le CV](C:\\w\\cv.pdf)'), ['commun/lettre.md', 'C:\\w\\cv.pdf']);
  assert.deepEqual(files('file:///C:/Users/r/Mon%20dossier/note.md'), ['C:/Users/r/Mon dossier/note.md']);
  assert.deepEqual(files('`artifacts/Mon dossier/note finale.md`'), ['artifacts/Mon dossier/note finale.md']);
  assert.deepEqual(files('[fichier: commun/lettre.md]'), ['commun/lettre.md']);
  assert.deepEqual(files('[le CV](CV.md)'), ['CV.md']);
  // Lien markdown web : reste un lien, pas une carte de fichier ; pas de faux positifs sur les mails ou versions.
  const web = parseRich('[doc](https://a.io/x/doc.md)');
  assert.deepEqual(web.map(b => b.kind), ['text']); assert.equal(web[0].inlines[0].kind, 'link');
  assert.deepEqual(files('écris à a@b.fr/x.md ou v1.2'), []);
  // Le reste du message est conservé autour de la carte.
  assert.deepEqual(parseRich('Lis artifacts/a.md stp').map(b => b.kind), ['text', 'file', 'text']);
});

test('document links resolve against the open file', () => {
  assert.equal(resolveDocLink('C:\\ws\\artifacts\\a\\x.md', '../b/y.md'), 'C:\\ws\\artifacts\\b\\y.md');
  assert.equal(resolveDocLink('C:/ws/a/x.md', './z.pdf#page=2'), 'C:/ws/a/z.pdf');
  assert.equal(resolveDocLink('artifacts/a/x.md', 'y.md'), 'artifacts/a/y.md');
  assert.equal(resolveDocLink('artifacts/x.md', '../../y.md'), null);
  assert.equal(resolveDocLink('C:/ws/x.md', 'C:/autre/y.md'), 'C:/autre/y.md');
  assert.equal(resolveDocLink('C:/ws/x.md', 'https://a.io/y.md'), null);
  assert.equal(resolveDocLink('C:/ws/x.md', 'image.png'), null);
});

test('android PDF download failure keeps the gateway error instead of "Passerelle Wake injoignable"', async () => {
  const { fileDownloadError, fileErrorMessage } = await import('./client.ts');
  const session = { url: 'http://192.168.1.20:8789', token: 'a'.repeat(64), expiresAt: Date.now() + 60_000 };
  const json = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const forbidden = await fileDownloadError(session, 'C:/x/a.pdf', new Error('response has status: 403'), json(403, { error: 'file_forbidden' }));
  assert.equal(forbidden.code, 'file_forbidden'); assert.match(fileErrorMessage(forbidden), /pas partageable/);
  const missing = await fileDownloadError(session, 'a.pdf', new Error('HTTP 404'), async () => { throw new TypeError('offline'); });
  assert.equal(missing.code, 'file_not_found');
  const down = await fileDownloadError(session, 'a.pdf', new Error('failed to connect'), async () => { throw new TypeError('offline'); });
  assert.equal(down.code, 'connection_lost');
});
