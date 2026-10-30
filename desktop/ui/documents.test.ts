import { expect, it } from "vitest";
import { markdownHtml, initialDocument } from "./documents.js";

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

it("rend titres, liens relatifs, code et tableaux sans interpréter le HTML source", () => {
  const html = markdownHtml('# Notes\n\n[Suite](docs/suite.md)\n\n<script>alert(1)</script>\n\n```js\n<a href="x">\n```\n\n| Nom | État |\n| --- | --- |\n| Wake | actif |');
  expect(html).toContain('<h1 id="notes">Notes</h1>');
  expect(html).toContain('<a href="docs/suite.md">Suite</a>');
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).toContain('<pre><code>&lt;a href=&quot;x&quot;&gt;</code></pre>');
  expect(html).toContain('<td>Wake</td><td>actif</td>');
});
