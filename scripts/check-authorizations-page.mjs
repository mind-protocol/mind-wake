import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startAuthorizationPage } from './authorizations-page.mjs';

const { values } = parseArgs({ options: { url: { type: 'string' }, file: { type: 'string' }, playwright: { type: 'string' }, output: { type: 'string' } } });
const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.resolve(values.file || path.join(root, 'AUTORISATIONS.json'));
const output = path.resolve(values.output || path.join(root, '.local/authorization-page-check'));
fs.mkdirSync(output, { recursive: true });
const playwright = values.playwright || path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'playwright/index.mjs');
const { chromium } = await import(pathToFileURL(playwright).href);
const expected = JSON.parse(fs.readFileSync(source, 'utf8'));
const temporary = fs.mkdtempSync(path.join(output, 'edit-test-'));
const testFile = path.join(temporary, 'AUTORISATIONS.json');
fs.copyFileSync(source, testFile);
const fixture = await startAuthorizationPage({ file: testFile });
let browser;
const report = { checkedAt: new Date().toISOString(), source, url: values.url || fixture.url, checks: [], errors: [], passed: false };
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(report.url);
  await page.locator('#entries article').first().waitFor();
  const displayed = await page.locator('#entries article').evaluateAll(cards => cards.map(card => ({
    id: card.querySelector('small').textContent,
    action: card.querySelector('h2').textContent,
    decision: card.querySelector('select').value,
    scope: card.querySelector('textarea').value,
    choices: card.querySelectorAll('select option').length,
  })));
  assert.deepEqual(displayed, expected.entries.map(({ id, action, decision, scope }) => ({ id, action, decision, scope, choices: 4 })));
  assert.equal(await page.locator('#example').textContent(), expected.example);
  assert.equal(await page.locator('#guidance').textContent(), expected.guidance);
  report.checks.push(`${displayed.length} actions, décisions, périmètres et quatre choix conformes au JSON`, 'Exemple et portée conformes');
  await page.screenshot({ path: path.join(output, 'page-desktop.png'), fullPage: true });
  await page.locator('#search').fill(expected.entries[0].action);
  assert.equal(await page.locator('#entries article').count(), 1);
  await page.locator('#search').fill('');
  await page.setViewportSize({ width: 420, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, 'page-mobile.png'), fullPage: true });
  report.checks.push('Recherche fonctionnelle', 'Pas de débordement horizontal à 420 px');

  // Write tests use only the isolated copy, never the owner's actual decisions.
  await page.goto(fixture.url);
  await page.locator('#entries article').first().waitFor();
  await page.locator('#entries select').first().selectOption('forbidden');
  await page.locator('#entries textarea').first().fill('Périmètre du test navigateur');
  await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Enregistré dans le JSON actif.');
  const saved = JSON.parse(fs.readFileSync(testFile, 'utf8'));
  assert.equal(saved.entries[0].decision, 'forbidden');
  assert.equal(saved.entries[0].scope, 'Périmètre du test navigateur');
  await page.reload();
  await page.locator('#entries article').first().waitFor();
  assert.equal(await page.locator('#entries select').first().inputValue(), 'forbidden');
  fs.appendFileSync(testFile, ' ');
  await page.locator('#entries select').first().selectOption('encouraged');
  await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('changé ailleurs'));
  assert.equal(JSON.parse(fs.readFileSync(testFile, 'utf8')).entries[0].decision, 'forbidden');
  assert.equal((await fetch(`${fixture.url}/api/authorizations`)).status, 403);
  report.checks.push('Enregistrement et relecture vérifiés sur copie isolée', 'Écrasement concurrent refusé', 'API sans jeton refusée');
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) { report.errors.push(error.stack || String(error)); process.exitCode = 1; }
finally {
  await browser?.close();
  await new Promise(resolve => fixture.server.close(resolve));
  assert.equal(path.dirname(fs.realpathSync(temporary)), fs.realpathSync(output));
  assert.ok(path.basename(temporary).startsWith('edit-test-'));
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
