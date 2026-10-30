import {afterEach, expect, it, vi} from "vitest";
import {markdownBlocks, renderMarkdown} from "../../desktop/ui/markdown.js";

afterEach(() => vi.unstubAllGlobals());
it("keeps paragraphs, numbered decisions, a table and code separate", () => {
  const text = "## Décisions\n\nUn paragraphe.\nUne autre ligne.\n\n2. **Proposé**\n3. À vérifier\n\n| Fichier | Usage |\n| --- | --- |\n| `etat.json` | A \\| B |\n\n```js\n<script>alert(1)</script>\n```\n\n> Hypothèse";
  expect(markdownBlocks(text)).toEqual([
    {kind:"heading",text:"Décisions"},
    {kind:"paragraph",text:"Un paragraphe.\nUne autre ligne."},
    {kind:"list",ordered:true,start:2,items:["**Proposé**", "À vérifier"]},
    {kind:"table",rows:[["Fichier","Usage"],["`etat.json`","A | B"]]},
    {kind:"code",text:"<script>alert(1)</script>"},
    {kind:"quote",text:"Hypothèse"},
  ]);
});

it("renders untrusted markup as text without HTML, links or remote images", () => {
  type Node = {tag: string; textContent: string; children: (Node|string)[]; append: (...items: (Node|string)[]) => void; setAttribute: () => void};
  const created: Node[] = [];
  vi.stubGlobal("document", {
    createTextNode: (text: string) => text,
    createElement: (tag: string) => {
      const node: Node = {tag, textContent:"", children:[], append(...items) { this.children.push(...items); }, setAttribute() {}};
      created.push(node); return node;
    },
  });
  renderMarkdown('**Titre**\n\n<img src="https://example.test/tracker" onerror="alert(1)"> [clic](javascript:alert(1))\n\n| A | B |\n| --- | --- |\n| <script>x</script> | `code` |');
  expect(created.map(n => n.tag)).toContain("table");
  expect(created.map(n => n.tag)).toContain("strong");
  expect(created.map(n => n.tag)).not.toContain("img");
  expect(created.map(n => n.tag)).not.toContain("script");
  expect(created.map(n => n.tag)).not.toContain("a");
  expect(created.flatMap(n => n.children).filter(c => typeof c === "string").join("")).toContain('<img src="https://example.test/tracker"');
});
