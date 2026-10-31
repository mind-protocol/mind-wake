import {expect, it} from 'vitest';
import {externalUrl, messageLinks, inlineCodeRanges} from './message-links.js';

it('recognizes bare and Markdown source links with balanced parentheses', () => {
  const text = 'Voir [Source](https://example.org/wiki/A_(B)?x=1&y=2 "Titre"), puis https://example.org/a. Et <http://localhost:3000/test>.';
  expect(messageLinks(text).map(link => [link.label, link.href])).toEqual([
    ['Source', 'https://example.org/wiki/A_(B)?x=1&y=2'],
    ['https://example.org/a', 'https://example.org/a'],
    ['http://localhost:3000/test', 'http://localhost:3000/test'],
  ]);
  for (const link of messageLinks(text)) expect(text.slice(link.start, link.end)).toContain(link.label);
});

it('keeps code, images, file links and unsafe destinations as text', () => {
  const text = '`https://example.org/code`\n```\nhttps://example.org/fenced\n```\n![image](https://example.org/image.png) [fiche](artifacts/fiche.md) [bad](javascript:alert(https://example.org/hidden))';
  expect(messageLinks(text)).toEqual([]);
  for (const url of ['javascript:alert(1)', 'file:///C:/x', '//host/x', 'mailto:a@b.org', 'https://user:pass@host/x', 'https://host/\nattack', 'https://host/\\x', 'https://', 'https://host/x y']) expect(externalUrl(url), url).toBeNull();
});

it('does not swallow sentence punctuation or activate embedded scheme text', () => {
  expect(messageLinks('(https://example.org/wiki/A_(B)).')[0]?.href).toBe('https://example.org/wiki/A_(B)');
  expect(messageLinks('javascript:https://example.org/path file:https://example.org/path')).toEqual([]);
  expect(messageLinks('[<script>alert(1)</script>](https://example.org)')[0]?.label).toBe('<script>alert(1)</script>');
});

it('colors inline backticks without losing markers or interpreting HTML, excluding fenced and multiline code',()=>{
 const text='before `artifacts/alpha.md` and `<img src=x>`, then ``a ` b``.\n```ts\n`leave alone`\n```\n`across\nlines`';
 expect(inlineCodeRanges(text).map(r=>text.slice(r.start,r.end))).toEqual(['`artifacts/alpha.md`','`<img src=x>`','``a ` b``']);
 expect(inlineCodeRanges('~~~code\n`leave alone`\n~~~\n`yes`').map(r=>r.start)).toHaveLength(1);
 expect(inlineCodeRanges('```same-line block```')).toEqual([]);
 expect(inlineCodeRanges('```ts\n`unclosed fence`')).toEqual([]);
});
