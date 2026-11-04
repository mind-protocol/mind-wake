import fs from 'node:fs';
import path from 'node:path';
import { createChatServer } from './chat-server.mjs';
import { createWakeChatBridge } from './chat-wake.mjs';
import { createLocalTranscriber } from './chat-voice.mjs';

export async function startWakeChat({ wakeRoot, dataDir, outputDir, host = '127.0.0.1', port = 8789, origins = [] }) {
  const ip = host.split('.').map(Number);
  const valid = ip.length === 4 && ip.every(part => Number.isInteger(part) && part >= 0 && part <= 255);
  const privateHost = valid && (ip[0] === 127 || ip[0] === 10 || (ip[0] === 192 && ip[1] === 168)
    || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31));
  if (!privateHost || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Loopback or explicit private LAN IPv4 required');
  if (!outputDir || !path.isAbsolute(outputDir)) throw new Error('Daemon output directory required');
  const bridge = await createWakeChatBridge({ wakeRoot, dataDir });
  const transcribe = createLocalTranscriber({ dataDir });
  const service = createChatServer({ bridge, transcribe, hosts: [host, ...(ip[0] === 127 ? ['localhost'] : [])], origins });
  await new Promise((resolve, reject) => { service.server.once('error', reject); service.server.listen(port, host, resolve); });
  const url = `http://${host}:${port}`;
  fs.writeFileSync(path.join(outputDir, 'pairing.private.json'), JSON.stringify({ url, ...service.pairing,
    note: 'Local owner pairing only. Do not publish as a public URL or put in the bundle.' }, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(outputDir, 'progress.json'), JSON.stringify({ startedAt: new Date().toISOString(),
    url, transport: 'authenticated long-poll', ownerAgentId: bridge.agentId, status: 'listening',
    pairingExpiresAt: service.pairing.expiresAt, localTranscriptionConfigured: Boolean(transcribe), public: false }, null, 2));
  console.log(JSON.stringify({ status: 'listening', url, transport: 'authenticated long-poll' }));
  return service;
}
