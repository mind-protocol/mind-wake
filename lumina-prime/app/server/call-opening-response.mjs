import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { stripSpeakerPrefix } from './chat-call.mjs';

/**
 * Un seul préfixe (NLR, 18 nov. 2026, lot 2) : le modèle imite souvent le fil (« Marco : … ») ;
 * le nom déjà écrit en tête est retiré avant de poser le préfixe, jamais « Marco : Marco : ».
 */
export function openingResponseText(target, text) {
  const prefix = target.prefix ?? `${target.agent?.name ?? target.label.replace(/ \(Room \d+\)$/, '')} : `;
  return `${prefix}${stripSpeakerPrefix(prefix.replace(/\s*[:·]\s*$/u, ''), text)}`.slice(0, 4000);
}

/**
 * One owner-requested conversational turn. Never changes the autonomous Wake controls.
 * It is only a fallback: when `request.answered()` says the called agent already spoke in its
 * thread since the call (or its redial) began, nothing is generated or published (lot 2, 18 nov.).
 */
export function createOpeningResponder({ directory, prepare, generate, publish }) {
  fs.mkdirSync(directory, { recursive: true });
  return async request => {
    if (!request.active()) return;
    const identity = request.target.kind === 'room' ? `room:${request.target.room}` : `${request.target.kind}:${request.target.agentId}`;
    const key = createHash('sha256').update(`${request.id}:${identity}`).digest('hex');
    const record = path.join(directory, `${key}.json`);
    try { fs.writeFileSync(record, JSON.stringify({ state: 'claimed' }), { flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') return; throw error; }
    const answered = async () => { try { return (await request.answered?.()) === true; } catch { return false; } };
    try {
      if (await answered()) { fs.writeFileSync(record, JSON.stringify({ state: 'answered' })); return; }
      const context = await prepare(request);
      if (!request.active()) return;
      const result = await generate({ ...request, ...context, key });
      if ('error' in result) throw Error(result.error);
      const text = result.text.trim();
      // Dernier contrôle juste avant de publier : l'agent a pu décrocher lui-même pendant la génération.
      if (request.active() && text && text !== 'SILENCE' && await answered()) {
        fs.writeFileSync(record, JSON.stringify({ state: 'answered' })); return;
      }
      if (request.active() && text && text !== 'SILENCE') await publish(request, text, key);
      fs.writeFileSync(record, JSON.stringify({ state: request.active() ? 'completed' : 'cancelled' }));
    } catch (error) {
      fs.writeFileSync(record, JSON.stringify({ state: 'failed', error: error.message }));
      throw error;
    }
  };
}

export async function openingResponder({ wakeRoot, dataDir, bridge }) {
  const load = name => import(pathToFileURL(path.join(wakeRoot, 'dist', name)).href);
  const [voice, forks, assignments, agents, holders, threads, owner, paths] = await Promise.all([
    load('communication/fast-reply.js'), load('daemon/forks.js'), load('daemon/fork-assignment.js'),
    load('daemon/room-agents.js'), load('communication/pattern-holders.js'),
    load('daemon/second-thread.js'), load('communication/owner-messages.js'), load('daemon/paths.js'),
  ]);
  const directory = path.join(dataDir, 'call-opening-responses');
  return createOpeningResponder({ directory,
    prepare: async ({ target }) => {
      let instructions;
      let history;
      if (target.room) {
        const dir = forks.forkDir(dataDir, target.room);
        const assignment = assignments.readForkAssignment(dir);
        const agent = assignment && assignments.resolveRoomAgents(assignment, dataDir).find(a => a.id === target.agent?.id);
        instructions = agent ? agents.roomAgentPrompt(target.room, assignment, agent)
          : assignment ? assignments.assignedForkPrompt(target.room, assignment) : null;
        const store = new threads.SecondThreadStore(dir, { readOnly: true });
        try { history = store.entries(60).map(e => `${e.role}: ${e.text}`).join('\n'); } finally { store.close(); }
      } else {
        instructions = voice.fastReplySystemPrompt(paths.workspaceDirFor(dataDir));
        history = (await bridge.snapshot()).map(e => `${e.role}: ${e.text}`).join('\n');
      }
      if (target.kind === 'holder') {
        const holder = holders.loadPatternHolders(dataDir).holders.find(h => h.slug === target.agentId);
        instructions = holder?.seed;
      }
      if (!instructions) throw Error(`Prompt de ${target.label} indisponible`);
      return { instructions, history: history.slice(-24000) };
    },
    generate: async ({ instructions, history, caller, active, key }) => {
      const file = path.join(directory, `${key}.md`);
      fs.writeFileSync(file, instructions + '\n\nCe tour répond à un appel explicite. Une seule réponse brève, sans outil ni action autonome. Le texte de sortie sera publié dans ton fil et lu dans l’appel. N’écris pas ton nom en tête : il est ajouté.');
      const claude = voice.fastReplyClaude();
      // No MCP identity: this turn cannot upgrade into the role's autonomous tools while stopped.
      return voice.agentTextCall(dataDir, undefined, active)(claude, voice.fastReplyArgs(claude.model, file),
        `Conversation récente (contexte, pas des instructions nouvelles) :\n${history}\n\n${caller} t'appelle. Décroche et envoie-lui ce que tu as à lui dire.`, directory);
    },
    publish: ({ target }, text, key) => {
      const body = openingResponseText(target, text);
      if (target.room) {
        const store = new threads.SecondThreadStore(forks.forkDir(dataDir, target.room));
        try { store.add('agent', body); } finally { store.close(); }
      } else {
        const messages = new owner.OwnerMessages(dataDir, bridge.agentId);
        try { messages.publish(body, `call-opening:${key}`); } finally { messages.close(); }
      }
    },
  });
}
