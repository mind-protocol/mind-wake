import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

const { wakeRoot, dataDir } = workerData;
const load = name => import(pathToFileURL(path.join(wakeRoot, 'dist', name)).href);
const route = await load('communication/telegram-handle-route.js');
const { loadPatternHolders } = await load('communication/pattern-holders.js');
const { readForkAssignment, forkOwnerChannel } = await load('daemon/fork-assignment.js');
const { FORK_IDS, forkDir, forkEnabled } = await load('daemon/forks.js');

function directory() {
  const assignments = new Map();
  const owners = new Map();
  const threads = new Map();
  for (const room of FORK_IDS) {
    let assignment;
    try { assignment = readForkAssignment(forkDir(dataDir, room)); } catch { continue; }
    assignments.set(room, assignment);
    const signature = forkOwnerChannel(room, assignment)?.signature;
    const handle = signature && route.signatureHandle(signature);
    if (handle) owners.set(room, { handle, name: signature.replace(/\s*\(.*\)\s*/g, ' ').trim() || handle });
    const slug = assignment?.holder;
    if (slug && !threads.get(slug)) threads.set(slug, forkEnabled(dataDir, room) ? 'fork:' + room : null);
  }
  const holders = loadPatternHolders(dataDir).holders.map(({ slug, name, emoji }) => ({
    slug, name, emoji, thread: threads.has(slug) ? threads.get(slug) : 'principal',
  }));
  const table = route.telegramHandleTable(dataDir, room => assignments.get(room) ?? null,
    () => holders.filter(h => h.thread === 'principal'));
  return { holders, owners, table };
}

function refresh() {
  try { parentPort.postMessage(directory()); }
  catch { parentPort.postMessage(null); }
}
refresh();
setInterval(refresh, 5000);
