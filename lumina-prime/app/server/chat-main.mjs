import { openCallControls } from '../../../services/mcp/call-control-store.mjs';
import { openPhoneBook, humanHandle } from '../../../services/mcp/phone-book.mjs';
import fs from 'node:fs';
import { serveDesktopCall } from './desktop-call-page.mjs';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { createChatServer } from './chat-server.mjs';
import { createFileReader } from './chat-files.mjs';
import { createWakeChatBridge } from './chat-wake.mjs';
import { createLocalTranscriber } from './chat-voice.mjs';
import { createChatSessionStore } from './chat-session-store.mjs';
import { createChatReportStore } from './chat-reports.mjs';
import { pathToFileURL } from 'node:url';
import { createCallService } from './chat-call.mjs';
import { createCallSpeaker } from './chat-speech.mjs';
import { createCallbackFileStore, createRingFeed } from './chat-ring.mjs';

/** Mode Appel : MIND toujours ; rooms, agents et holders si les modules du runtime se chargent. */
async function createCall({ wakeRoot, dataDir, bridge }) {
  const load = name => import(pathToFileURL(path.join(wakeRoot, 'dist', name)).href);
  let route = null; let rooms = null; let wake = null; let noticeRoom = null; let noticeMain = null;
  try { route = await load('communication/telegram-handle-route.js'); } catch { /* MIND seul. */ }
  try {
    const [{ SecondThreadStore }, { forkDir }] = await Promise.all([load('daemon/second-thread.js'), load('daemon/forks.js')]);
    rooms = room => {
      const dir = forkDir(dataDir, room);
      if (!SecondThreadStore.exists(dir)) return [];
      const store = new SecondThreadStore(dir, { readOnly: true });
      try { return store.entries(200); } finally { store.close(); }
    };
    // Copie d'appel dans une room : notice étiquetée « Appel », non humaine, une fois par clé.
    noticeRoom = (room, key, text) => {
      const dir = forkDir(dataDir, room);
      if (!SecondThreadStore.exists(dir)) return;
      const store = new SecondThreadStore(dir);
      try { store.addNoticeOnce(key, text, 'Appel'); } finally { store.close(); }
    };
  } catch { /* Réponses de room indisponibles. */ }
  try {
    const { enqueueOwnerMessage } = await load('communication/owner-inbox.js');
    // Copie d'appel au fil principal : message pair (origine hôte), jamais humain. Le préfixe
    // `fast-reply-fyi:` est celui que ownerMessagePending(…, wakeEligibleOnly) exclut : la copie
    // s'insère dans un tour vivant ou au prochain réveil, sans jamais en demander un.
    noticeMain = (key, text) => enqueueOwnerMessage(dataDir, { id: `fast-reply-fyi:${key}`.slice(0, 160), at: new Date().toISOString(), text,
      origin: { kind: 'peer_message', channel: 'call', author: 'Appel', senderRef: 'call', recipientRef: 'principal',
        threadId: 'call', messageId: key, correlationId: key } });
  } catch { /* Pas de copie vers le fil principal. */ }
  try {
    const [{ requestHumanWake }, { externalInboxSyncAllowed }] = await Promise.all([load('daemon/human-wake.js'), load('communication/external-inbox-policy.js')]);
    // Même règle que le pont Telegram : jamais de réveil en pause, arrêt ou Force-off.
    wake = () => { if (externalInboxSyncAllowed(dataDir)) requestHumanWake(dataDir, Date.now()); };
  } catch { /* Le message reste dans la file ; le scheduler décide. */ }
  let directory = { holders: [], owners: new Map(), table: new Map() };
  const directoryWorker = new Worker(new URL('./chat-call-directory.mjs', import.meta.url), {
    workerData: { wakeRoot, dataDir }, execArgv: [],
  });
  await new Promise(resolve => {
    directoryWorker.on('message', snapshot => { if (snapshot) directory = snapshot; resolve(); });
    directoryWorker.on('error', () => resolve());
    directoryWorker.once('exit', resolve);
  });
  const service = createCallService({ mainLabel: 'Marco', mainAgentId: 'marco',
    holders: () => directory.holders, owners: () => directory.owners, handleTable: () => directory.table,
    routeHandle: route ? (handle, text, id) => route.routeTelegramHandle(dataDir, handle, text, `call-${id}`, directory.table) : null,
    sendMain: (id, text) => bridge.send(id, text), wakeMain: wake ?? undefined,
    mainReplies: () => bridge.snapshot(), roomEntries: rooms, noticeMain, noticeRoom,
    speak: await createCallSpeaker({ wakeRoot, dataDir, mainVoiceId: 'marco' }) });
  /**
   * Notice de rappel programmé dans le fil de l'agent (chat-ring.mjs). Fil principal : message pair
   * puis demande de réveil (même règle pause/Force-off que le pont Telegram) ; room : notice lue à son
   * prochain réveil.
   */
  const noticeCallback = async (handle, key, text) => {
    const target = service.resolve(handle);
    if (target.room) { if (!noticeRoom) throw new Error('room notices unavailable'); return noticeRoom(target.room, key, text); }
    if (!noticeMain) throw new Error('main notices unavailable');
    await noticeMain(key, target.mention ? `${target.mention} ${text}` : text);
    try { wake?.(); } catch { /* Le scheduler décide. */ }
  };
  return { ...service, noticeCallback, close: () => { service.stop(); return directoryWorker.terminate(); } };
}


const ipv4 = value => { const ip = String(value).split('.').map(Number);
  return ip.length === 4 && ip.every(part => Number.isInteger(part) && part >= 0 && part <= 255) ? ip : null; };
const privateIpv4 = ip => Boolean(ip) && (ip[0] === 127 || ip[0] === 10 || (ip[0] === 192 && ip[1] === 168)
  || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127));

/**
 * privateNetworkConnect: no pairing — LAN/Tailscale/loopback peers (socket address) get a session, public peers are refused.
 * Only then may host be 0.0.0.0, with `hostnames` listing the private addresses the phone uses (Host header allowlist).
 */
export async function startWakeChat({ wakeRoot, dataDir, outputDir, host = '127.0.0.1', port = 8789, origins = [], localConnect = false,
  privateNetworkConnect = false, hostnames = [] }) {
  const ip = ipv4(host);
  const anyHost = host === '0.0.0.0' && privateNetworkConnect;
  if ((!anyHost && !privateIpv4(ip)) || !Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Loopback or explicit private LAN IPv4 required');
  if (hostnames.some(name => !privateIpv4(ipv4(name)))) throw new Error('Private IPv4 hostnames required');
  if (!outputDir || !path.isAbsolute(outputDir)) throw new Error('Daemon output directory required');
  const allowedHosts = [...new Set([...(anyHost ? [] : [host]), ...hostnames,
    ...(anyHost || ip[0] === 127 ? ['127.0.0.1', 'localhost'] : [])])];
  const bridge = await createWakeChatBridge({ wakeRoot, dataDir });
  const transcribe = createLocalTranscriber({ dataDir });
  const reportStore = createChatReportStore(path.join(dataDir, 'mobile-chat-reports.sqlite'));
  const call = await createCall({ wakeRoot, dataDir, bridge });
  // Erreurs affichées dans l'app mobile → message pair `app-error` au principal (src/communication/app-error-relay.ts).
  let appErrors = null;
  try {
    const { relayAppError } = await import(pathToFileURL(path.join(wakeRoot, 'dist', 'communication/app-error-relay.js')).href);
    appErrors = input => relayAppError(dataDir, input);
  } catch { /* Runtime non compilé : l'endpoint répond app_errors_unavailable. */ }
  // Sonneries et rappels programmés : rappels tenus sur disque, passage toutes les 15 s.
  const ring = createRingFeed({ snapshot: () => bridge.snapshot(), targets: () => call.targets(), active: () => call.active(),
    mainLabel: 'Marco', store: createCallbackFileStore(path.join(dataDir, 'mobile-chat-callbacks.json')), notify: call.noticeCallback });
  const ringTimer = setInterval(() => { ring.tick().catch(() => {}); }, 15_000); ringTimer.unref();
  const phones = openPhoneBook(dataDir);
  const controls = openCallControls(dataDir);
  const addressMap = JSON.parse(process.env.MIND_WAKE_PHONE_HANDLES ?? '{}');
  const phoneOwner = address => humanHandle(addressMap[String(address).replace(/^::ffff:/, '')] ?? 'nlr');
  let sending = false;
  const pushTimer = setInterval(async () => {
    if (sending) return;
    sending = true;
    try {
      await phones.push(async messages => {
        const response = await fetch('https://exp.host/--/api/v2/push/send', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(messages), signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw Error('push service unavailable');
        const result = await response.json();
        if (!Array.isArray(result.data)) throw Error('push rejected');
        return result.data;
      });
    } catch { /* Retry while ringing. */ } finally { sending = false; }
  }, 2000);
  pushTimer.unref();
  const service = createChatServer({ bridge, transcribe, call, ring, phones, phoneOwner, controls, files: createFileReader({ root: path.join(dataDir, 'workspace') }), hosts: allowedHosts, origins: [...origins, `http://127.0.0.1:${port}`], desktopCallPage: serveDesktopCall,
    reportStore, appErrors,
    localConnect, privateNetworkConnect, sessionTtlMs: 365 * 24 * 60 * 60_000,
    sessionStore: createChatSessionStore(path.join(dataDir, 'credentials', 'mobile-chat-sessions.json')) });
  try {
    await new Promise((resolve, reject) => { service.server.once('error', reject); service.server.listen(port, host, resolve); });
  } catch (error) { clearInterval(pushTimer); clearInterval(ringTimer); phones.close(); await call.close(); reportStore.close(); controls.close(); throw error; }
  transcribe?.warm();
  const url = `http://${anyHost ? (hostnames[0] ?? '127.0.0.1') : host}:${port}`;
  fs.writeFileSync(path.join(outputDir, 'pairing.private.json'), JSON.stringify({ url, ...service.pairing,
    note: 'Local owner pairing only. Do not publish as a public URL or put in the bundle.' }, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(outputDir, 'progress.json'), JSON.stringify({ startedAt: new Date().toISOString(),
    url, transport: 'authenticated long-poll', ownerAgentId: bridge.agentId, status: 'listening', privateNetworkConnect, hosts: allowedHosts,
    pairingExpiresAt: service.pairing.expiresAt, localTranscriptionConfigured: Boolean(transcribe), public: false }, null, 2));
  console.log(JSON.stringify({ status: 'listening', url, bind: host, privateNetworkConnect, transport: 'authenticated long-poll' }));
  const close = service.close;
  service.close = async () => { clearInterval(pushTimer); clearInterval(ringTimer); try { await close(); } finally { transcribe?.close(); await call.close(); reportStore.close(); phones.close(); controls.close(); } };
  return service;
}
