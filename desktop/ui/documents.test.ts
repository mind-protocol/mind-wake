import { expect, it } from "vitest";
import { markdownHtml, initialDocument } from "./documents.js";
import { documentImageReference, loadDocumentImages } from './document-images.js';

it("reprend le dernier document ou ouvre l’accueil sans afficher les instructions de l’agent par défaut", () => {
  const entries = [
    { name: 'artifacts', relative: 'artifacts', directory: true },
    { name: 'AGENTS.md', relative: 'AGENTS.md', directory: false },
    { name: 'objectifs.html', relative: 'objectifs.html', directory: false },
  ];
  expect(initialDocument(entries, 'artifacts/carnet.md')).toBe('artifacts/carnet.md');
  expect(initialDocument(entries)).toBe('objectifs.html');
  expect(initialDocument(entries.slice(0, 2))).toBeUndefined();
  expect(initialDocument([])).toBeUndefined();
});

it('renders Markdown images with escaped attributes and leaves code literal', () => {
  const html = markdownHtml('![Carte "locale"](./images/carte.png "Titre")\n`![exemple](secret.png)`\n![](a.png)');
  expect(html).toContain('<img src="./images/carte.png" alt="Carte &quot;locale&quot;">');
  expect(html).toContain('<code>![exemple](secret.png)</code>');
  expect(html).toContain('<img src="a.png" alt="">');
  expect(markdownHtml('![x](a.png"onerror="alert)')).not.toContain('src="a.png"onerror=');
});

it('resolves only local raster references relative to the document folder', () => {
  expect(documentImageReference('./images/carte%20locale.png', 'artifacts/notes/page.md')).toBe('artifacts/notes/images/carte locale.png');
  expect(documentImageReference('images\\carte.webp', 'README.md')).toBe('images/carte.webp');
  for (const path of ['../x.png', '%2e%2e/x.png', 'images/../x.png', '/x.png', '//host/x.png', '\\\\host\\x.png', 'C:/x.png', 'https://host/x.png', 'data:image/png;base64,AAAA', 'javascript:x.png', 'x.svg', 'x.html', 'x.png:stream', 'x.png?url=a', 'x%00.png', 'x%2.png']) {
    expect(documentImageReference(path, 'artifacts/page.html'), path).toBeNull();
  }
  expect(documentImageReference('x.png', '../page.md')).toBeNull();
});

it('does not inject a late response after navigation, and rejects active payloads', async () => {
  // Minimal frame boundary: the real DOM sanitizer/hydration also runs in the browser smoke test.
  let active = true, source = '', replacement = '';
  const image = {isConnected: true, get ownerDocument() {return doc;},
    removeAttribute: () => {source = '';}, replaceWith: (node: {textContent: string}) => {replacement = node.textContent;},
    addEventListener: () => {}, set src(value: string) {source = value;}, alt: '', title: ''};
  const doc = {querySelectorAll: () => [image], createElement: () => ({textContent: ''})} as unknown as Document;
  let finish!: (value: unknown) => void;
  const pending = loadDocumentImages([{reference: 'artifacts/x.png', label: 'Carte'}], doc, 'project', async (command, args) => {
    expect(command).toBe('conversation_image'); expect(args).toEqual({reference: 'artifacts/x.png', scope: 'project'});
    return new Promise(resolve => {finish = resolve;});
  }, () => active);
  active = false; finish({dataUrl: 'data:image/png;base64,AAAA'}); await pending;
  expect(source).toBe(''); expect(replacement).toBe('');
  active = true;
  for (const dataUrl of ['https://host/x.png', 'data:image/svg+xml;base64,AAAA', 'data:text/html;base64,AAAA', 'data:image/png;base64,AAAA" onerror="x']) {
    replacement = '';
    await loadDocumentImages([{reference: 'x.png', label: 'Carte'}], doc, 'agent', async () => ({dataUrl}), () => active);
    expect(source).toBe(''); expect(replacement).toBe('Image indisponible · Carte');
  }
});

it("rend titres, liens relatifs, code et tableaux sans interpréter le HTML source", () => {
  const html = markdownHtml('# Notes\n\n[Suite](docs/suite.md)\n\n<script>alert(1)</script>\n\n```js\n<a href="x">\n```\n\n| Nom | État |\n| --- | --- |\n| Wake | actif |');
  expect(html).toContain('<h1 id="notes">Notes</h1>');
  expect(html).toContain('<a href="docs/suite.md">Suite</a>');
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).toContain('<pre><code>&lt;a href=&quot;x&quot;&gt;</code></pre>');
  expect(html).toContain('<td>Wake</td><td>actif</td>');
});
