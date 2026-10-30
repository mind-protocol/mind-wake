// Run after npm run desktop:ui. Pass an installed Chromium headless executable.
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const executable = process.argv[2];
assert(executable, 'Pass the installed Chromium headless executable');
const temporary = await mkdtemp(join(tmpdir(), 'mind-message-links-'));
const moduleUrl = pathToFileURL(resolve('desktop/ui/build/message-links.js')).href;
const markdownUrl = pathToFileURL(resolve('desktop/ui/build/markdown.js')).href;
const markdownSource = '**Sources**\n\n[Article](https://example.org/article)\n\n' + String.fromCharCode(96) + 'https://example.org/code' + String.fromCharCode(96);
const page = `<!doctype html><meta charset="utf-8"><pre id="result">pending</pre><script type="module">
import {decorateMessageLinks} from ${JSON.stringify(moduleUrl)};
import {renderMarkdown} from ${JSON.stringify(markdownUrl)};
const assert = (condition, label) => {if (!condition) throw Error(label);};
try {
  const root = document.createElement('div'), calls = [];
  const invoke = async (command, args) => {calls.push({command, args});};
  root.textContent = '[Source <script>](https://example.org/source) et https://example.org/other. [fiche](artifacts/page.md) ![photo](https://example.org/a.png)';
  const editor = document.createElement('textarea'); editor.value = 'draft https://example.org/draft'; root.append(editor);
  const file = document.createElement('span'); file.dataset.fileReference = 'true'; file.textContent = 'https://example.org/file'; root.append(file);
  document.body.append(root); decorateMessageLinks(root, invoke); decorateMessageLinks(root, invoke);
  const anchors = root.querySelectorAll('a');
  assert(anchors.length === 2, 'only web links, no duplicates/images/files/editor changes');
  assert(anchors[0].textContent === 'Source <script>' && !root.querySelector('script,img'), 'labels remain inert DOM text');
  assert(editor.value === 'draft https://example.org/draft', 'draft preserved');
  assert(root.textContent.includes('[fiche](artifacts/page.md)'), 'local file reference preserved');
  assert(calls.length === 0, 'no automatic opening');
  const event = new MouseEvent('click', {bubbles:true, cancelable:true}); anchors[0].dispatchEvent(event); await Promise.resolve();
  assert(event.defaultPrevented, 'webview navigation prevented');
  assert(calls.length === 1 && calls[0].command === 'open_external_url' && calls[0].args.url === 'https://example.org/source', 'explicit click uses native opener');
  const markdown = renderMarkdown(${JSON.stringify(markdownSource)}); document.body.append(markdown);
  decorateMessageLinks(markdown, invoke); assert(markdown.querySelectorAll('a').length === 1, 'Markdown body links without touching code');
  const failure = document.createElement('p'); failure.textContent = 'https://example.org/failure'; document.body.append(failure);
  decorateMessageLinks(failure, async () => {throw Error('denied');}); failure.querySelector('a').click(); await Promise.resolve(); await Promise.resolve();
  assert(failure.querySelector('[role=status]').textContent.includes('impossible'), 'native opening failure is visible');
  document.getElementById('result').textContent = 'PASS: safe DOM labels, click-only opener, navigation prevention, Markdown, preserved images/files/draft, visible errors';
} catch(error) {document.getElementById('result').textContent = 'FAIL: ' + error.stack;}
</script>`;
try {
  const file = join(temporary, 'test.html'); await writeFile(file, page);
  const run = spawnSync(executable, ['--headless', '--no-sandbox', '--disable-gpu', '--allow-file-access-from-files',
    '--user-data-dir=' + join(temporary, 'profile'), '--dump-dom', '--virtual-time-budget=3000', pathToFileURL(file).href], {encoding:'utf8', timeout:30_000});
  const result = /<pre id="result">([^<]*)<\/pre>/.exec(run.stdout ?? '')?.[1];
  assert.equal(run.status, 0, run.stderr || run.error?.message); assert(result?.startsWith('PASS:'), result ?? run.stdout);
  process.stdout.write(result + '\n');
} finally {await rm(temporary, {recursive:true, force:true, maxRetries:10, retryDelay:200});}
