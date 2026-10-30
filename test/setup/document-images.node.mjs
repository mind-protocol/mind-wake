// Run after npm run desktop:ui. Pass an installed Chromium headless executable.
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';

const executable = process.argv[2];
assert(executable, 'Pass the path to an installed Chromium headless executable');
const temporary = await mkdtemp(join(tmpdir(), 'mind-reader-images-'));
const moduleUrl = pathToFileURL(resolve('desktop/ui/build/document-images.js')).href;
const markdownUrl = pathToFileURL(resolve('desktop/ui/build/documents.js')).href;
const page = `<!doctype html><meta charset="utf-8"><pre id="result">pending</pre>
<script type="module">
import {sanitizeDocument, loadDocumentImages} from ${JSON.stringify(moduleUrl)};
import {markdownHtml} from ${JSON.stringify(markdownUrl)};
const assert = (value, label) => {if (!value) throw Error(label);};
try {
  const source = markdownHtml('![Carte](images/pixel.png)') +
    '<img src="images/pixel.png" alt="HTML local">' +
    '<script>parent.attacked=true;<\\/script>' +
    '<img src="javascript:attack.png" onerror="parent.attacked=true" srcset="https://invalid.invalid/a.png 2x">' +
    '<img src="https://invalid.invalid/remote.png"><img src="fake.png">' +
    '<svg><image href="https://invalid.invalid/a.png"/></svg><iframe srcdoc="attack"></iframe>' +
    '<style>body{background-image:url(https://invalid.invalid/track.png)}</style>';
  const parsed = new DOMParser().parseFromString(source, 'text/html');
  const entries = sanitizeDocument(parsed, 'artifacts/page.md');
  assert(entries[0].reference === 'artifacts/images/pixel.png', 'relative Markdown source');
  assert(!parsed.querySelector('script,iframe,svg,[src],[srcset],[onerror]'), 'active markup and original sources removed');
  assert(parsed.head.querySelector('meta').content.includes('img-src data:'), 'raster-only injection CSP');
  const frame = document.createElement('iframe'); frame.sandbox = 'allow-same-origin'; document.body.append(frame);
  const loaded = new Promise(resolve => {frame.onload = resolve;}); frame.srcdoc = '<!doctype html>' + parsed.documentElement.outerHTML; await loaded;
  const doc = frame.contentDocument;
  const calls = [];
  await loadDocumentImages(entries, doc, 'project', async (command, args) => {
    calls.push(args.reference);
    if (args.reference.endsWith('fake.png')) return {dataUrl: 'data:image/svg+xml;base64,AAAA'};
    return {dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO0sAAAAASUVORK5CYII='};
  }, () => frame.contentDocument === doc);
  const image = doc.querySelector('img');
  await new Promise(resolve => {if (image.complete) resolve(); else {image.onload = resolve; image.onerror = resolve;}});
  assert(image.naturalWidth === 1, 'local raster actually decoded in sanitized frame');
  assert(calls.join(',') === 'artifacts/images/pixel.png,artifacts/images/pixel.png,artifacts/fake.png', 'blocked references never reach native read');
  assert(doc.body.textContent.includes('Image indisponible'), 'failures have visible text');
  assert(!window.attacked, 'document scripts and events never ran');
  document.getElementById('result').textContent = 'PASS: DOM sanitization, relative Markdown/HTML images, CSP, native boundary, raster decode, visible errors';
} catch (error) {document.getElementById('result').textContent = 'FAIL: ' + error.stack;}
</script>`;
try {
  const file = join(temporary, 'test.html'); await writeFile(file, page);
  const run = spawnSync(executable, ['--headless', '--no-sandbox', '--disable-gpu', '--allow-file-access-from-files',
    '--user-data-dir=' + join(temporary, 'profile'), '--dump-dom', '--virtual-time-budget=5000', pathToFileURL(file).href], {encoding: 'utf8', timeout: 30_000});
  const result = /<pre id="result">([^<]*)<\/pre>/.exec(run.stdout ?? '')?.[1];
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  assert(result?.startsWith('PASS:'), result ?? run.stdout);
  process.stdout.write(result + '\n');
} finally {await rm(temporary, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});}
