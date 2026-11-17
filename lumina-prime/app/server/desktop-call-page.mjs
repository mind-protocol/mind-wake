import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const root = new URL('../dist/', import.meta.url);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.wav': 'audio/wav', '.jpg': 'image/jpeg', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };

export async function serveDesktopCall(pathname, res) {
  // Expo route chunks may contain literal or URI-encoded brackets, e.g. [username].
  const route = pathname.replace(/%5b/gi, '[').replace(/%5d/gi, ']');
  const home = route === '/desktop-call';
  if (!home && (route.split('/').some(segment => segment === '.' || segment === '..') || !/^\/(?:_expo\/static|assets)\/(?:[\w@.+\[\]-]+\/)*[\w@.+\[\]-]+$/.test(route))) return false;
  const file = new URL(home ? 'index.html' : route.slice(1), root);
  const type = types[extname(file.pathname)];
  if (!file.href.startsWith(root.href) || !type) return false;
  try {
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': home ? 'no-store' : 'no-cache',
      'Content-Security-Policy': "frame-ancestors http://tauri.localhost https://tauri.localhost tauri://localhost 'self'" });
    res.end(bytes);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Export mobile indisponible.');
  }
  return true;
}
