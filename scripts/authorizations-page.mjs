import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const revision = text => createHash('sha256').update(text).digest('hex');

/** Only this selected JSON is editable; no filesystem or shell API is exposed. */
export async function startAuthorizationPage({ file = path.join(root, 'AUTORISATIONS.json'), port = 0 } = {}) {
  file = fs.realpathSync(file);
  JSON.parse(fs.readFileSync(file, 'utf8'));
  const token = randomBytes(32).toString('hex');
  let origin;
  const server = http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return send(403, { error: 'Origin refused' });
    try {
      if (req.method === 'GET' && req.url === '/') {
        const html = fs.readFileSync(path.join(root, 'AUTORISATIONS.html'), 'utf8')
          .replace('<script>', `<script>window.WAKE_AUTHORIZATIONS_TOKEN=${JSON.stringify(token)};</script><script>`);
        return send(200, html, 'text/html; charset=utf-8');
      }
      if (req.url !== '/api/authorizations' || req.headers['x-wake-token'] !== token) return send(403, { error: 'Access refused' });
      if (req.method === 'GET') {
        const text = fs.readFileSync(file, 'utf8');
        return send(200, { document: JSON.parse(text), revision: revision(text), file });
      }
      if (req.method !== 'PUT' || !req.headers['content-type']?.startsWith('application/json')) return send(405, { error: 'Method refused' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 1_000_000) return send(413, { error: 'Too large' }); }
      const input = JSON.parse(body);
      const previous = fs.readFileSync(file, 'utf8');
      if (input.revision !== revision(previous)) return send(409, { error: 'Le fichier a changé ailleurs. Recharge la page avant de modifier cette version.' });
      const current = JSON.parse(previous), next = input.document;
      // This editor changes decisions and scopes only, preserving every other field.
      const fixed = doc => ({ ...doc, entries: doc.entries.map(({ decision, scope, ...entry }) => entry) });
      if (!next || !Array.isArray(next.entries) || JSON.stringify(fixed(next)) !== JSON.stringify(fixed(current)) || next.entries.some(e => !['authorized','encouraged','discouraged','forbidden'].includes(e.decision) || typeof e.scope !== 'string' || !e.scope.trim())) return send(400, { error: 'Décisions ou périmètres invalides.' });
      const text = JSON.stringify(next, null, 2) + '\n';
      const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
      try { fs.writeFileSync(temporary, text, { flag: 'wx' }); fs.renameSync(temporary, file); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      return send(200, { revision: revision(text) });
    } catch { return send(500, { error: 'Lecture ou enregistrement impossible.' }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, url: origin, file };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { file: { type: 'string' }, port: { type: 'string' } } });
  const page = await startAuthorizationPage({ file: values.file, port: values.port ? Number(values.port) : 0 });
  console.log(JSON.stringify({ url: page.url, file: page.file }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => page.server.close());
}
