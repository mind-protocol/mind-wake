import test from 'node:test'; import assert from 'node:assert/strict';
import { parseInline, parseMarkdownDoc, parseRich, tintOf, TINTS } from './client.ts';

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
  assert.deepEqual(bare.filter(b => b.kind === 'file').map(b => [b.name, b.type]), [['rapport.PDF', 'pdf'], ['n.md', 'md']]);
  assert.deepEqual(parseRich('ouvre C:\\w\\plan.pdf').at(-1), { kind: 'file', path: 'C:\\w\\plan.pdf', name: 'plan.pdf', type: 'pdf' });
  assert.deepEqual(parseRich('`C:\\w\\x.md`'), [{ kind: 'file', path: 'C:\\w\\x.md', name: 'x.md', type: 'md' }]);
  // [fichier:] garde les espaces et tout type (aperçu indisponible) ; un texte non absolu reste du texte.
  assert.deepEqual(parseRich('[fichier: C:\\w\\Mon dossier\\note finale.md]')[0], { kind: 'file', path: 'C:\\w\\Mon dossier\\note finale.md', name: 'note finale.md', type: 'md' });
  assert.equal(parseRich('[fichier: C:\\w\\data.json]')[0].type, 'other');
  assert.deepEqual(parseRich('[fichier: rien]').map(b => b.kind), ['text']);
  // URLs et chemins relatifs ne deviennent pas des fichiers.
  assert.deepEqual(parseRich('https://a.io/C:/doc.md et docs/README.md').map(b => b.kind), ['text']);
  assert.deepEqual(parseRich('img https://a.io/p.png et C:\\w\\a.md').map(b => b.kind), ['text', 'image', 'text', 'file']);
});

test('markdown document: headings, lists, quotes, code, tables, paragraphs', () => {
  const doc = parseMarkdownDoc('# Titre\n\nUn **paragraphe**\nsur deux lignes.\n\n- un\n  suite\n  - deux\n1. trois\n> cité\n\n```\ncode\n```\n---\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.deepEqual(doc, [
    { kind: 'heading', level: 1, text: 'Titre' }, { kind: 'paragraph', text: 'Un **paragraphe**\nsur deux lignes.' },
    { kind: 'bullet', text: 'un suite', marker: '•', depth: 0 }, { kind: 'bullet', text: 'deux', marker: '•', depth: 1 },
    { kind: 'bullet', text: 'trois', marker: '1.', depth: 0 }, { kind: 'quote', text: 'cité' }, { kind: 'code', text: 'code' },
    { kind: 'rule' }, { kind: 'code', text: '| a | b |\n| 1 | 2 |' }]);
});
