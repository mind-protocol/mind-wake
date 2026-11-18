import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

const { wakeRoot, dataDir } = workerData;
const load = name => import(pathToFileURL(path.join(wakeRoot, 'dist', name)).href);
const route = await load('communication/telegram-handle-route.js');
const { loadPatternHolders, parsePatternHolder } = await load('communication/pattern-holders.js');
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
  const loaded = loadPatternHolders(dataDir).holders;
  const holders = loaded.map(({ slug, name, emoji, topics }) => ({
    slug, name, emoji, thread: threads.has(slug) ? threads.get(slug) : 'principal', ...(topics ? { topics } : {}),
  }));
  // Registre « sujet → agent » (NLR, 18 nov. 2026 14:55) : champ `topics` du bloc json des holders,
  // et des agents de room dont les instructions sont un holder (dossier avec `_holder.md` ou fichier).
  const topics = loaded.filter(h => h.topics?.length).map(h => ({ handle: h.slug, topics: [...h.topics] }));
  for (const assignment of assignments.values())
    for (const agent of assignment?.agents ?? []) {
      if (topics.some(t => t.handle === agent.id)) continue;
      const found = agentTopics(agent);
      if (found.length) topics.push({ handle: agent.id, topics: found });
    }
  const table = route.telegramHandleTable(dataDir, room => assignments.get(room) ?? null,
    () => holders.filter(h => h.thread === 'principal'));
  return { holders, owners, table, topics };
}

function agentTopics(agent) {
  try {
    const file = fs.statSync(agent.instructions).isDirectory() ? path.join(agent.instructions, '_holder.md') : agent.instructions;
    const parsed = parsePatternHolder(`${agent.id}.md`, fs.readFileSync(file, 'utf8'));
    return 'holder' in parsed ? [...(parsed.holder.topics ?? [])] : [];
  } catch { return []; }
}

function refresh() {
  try { parentPort.postMessage(directory()); }
  catch { parentPort.postMessage(null); }
}
refresh();
setInterval(refresh, 5000);
