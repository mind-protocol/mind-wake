#!/usr/bin/env node
/** Explicit authenticated read of one shared message, projected locally without an inbox wake. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validateNode, validateStateDir } from './setup-shared-messages.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
export async function relaySharedReceived({ dataDir, stateDir, clientBuild, threadId, messageId }) {
  validateNode();
  if (!dataDir || !path.isAbsolute(dataDir) || !fs.statSync(dataDir).isDirectory()) throw Error('Dossier de donnees existant requis.');
  stateDir = validateStateDir(stateDir);
  const relativeBuild = clientBuild && path.relative(path.join(repo, 'output/shared-messages-client'), path.resolve(clientBuild));
  if (!clientBuild || relativeBuild.startsWith('..') || path.isAbsolute(relativeBuild)) throw Error('Build local du helper requis.');
  if (!/^thr_[A-Za-z0-9_-]{8,64}$/.test(threadId ?? '') || !/^msg_[A-Za-z0-9_-]{8,64}$/.test(messageId ?? '')) throw Error('Fil et message requis.');
  const { recordHubReceived } = await import('../dist/communication/received-messages.js');
  const { RemoteHubLink } = await import(pathToFileURL(path.join(clientBuild, 'services/mcp/shared-https.js')).href);
  const key = fs.readFileSync(path.join(stateDir, 'agent.key'), 'utf8');
  const { endpoint } = JSON.parse(fs.readFileSync(path.join(stateDir, 'endpoint.json'), 'utf8'));
  const link = new RemoteHubLink(endpoint, key);
  const self = await link.call({ op: 'whoami' });
  if (!/^(agent|human)-[a-z2-9]{10}$/.test(self.ref ?? '')) throw Error('Identite de reception invalide.');
  let after = 0;
  while (true) {
    const result = await link.call({ op: 'read_inbox', threadId, after, limit: 50 });
    if (!Array.isArray(result.messages)) throw Error('Reponse invalide.');
    const message = result.messages.find(m => m.message_id === messageId);
    if (message) {
      if (message.from_self !== false || message.to !== self.ref || message.thread_id !== threadId ||
          !/^(agent|human)-[a-z2-9]{10}$/.test(message.from ?? '') || typeof message.text !== 'string' ||
          !['agent', 'human', 'service'].includes(message.provenance?.kind) ||
          message.provenance?.channel !== 'mind-shared-hub' || !Number.isFinite(Date.parse(message.provenance?.received_at)))
        throw Error('Enveloppe de reception invalide.');
      // The only journal input is the direct HTTPS response, never an author/JSON parsed from text.
      recordHubReceived(dataDir, { messages: [message] }, 'mind-shared-hub');
      return { recorded: true, messageId, threadId, senderRef: message.from, channel: 'mind-shared-hub', wakeQueued: false };
    }
    if (result.messages.length < 50) throw Error('Message non recu dans ce fil.');
    if (!Number.isSafeInteger(result.next) || result.next <= after) throw Error('Curseur invalide.');
    after = result.next;
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: {
      'data-dir': { type: 'string' }, 'state-dir': { type: 'string' }, 'client-build': { type: 'string' },
      thread: { type: 'string' }, message: { type: 'string' },
    }});
    console.log(JSON.stringify(await relaySharedReceived({ dataDir: values['data-dir'], stateDir: values['state-dir'], clientBuild: values['client-build'], threadId: values.thread, messageId: values.message })));
  } catch {
    console.error('Relais refuse : verifier build (npm run build), dossiers, identite partagee, fil/message et acces HTTPS. Aucun secret affiche.');
    process.exitCode = 1;
  }
}
