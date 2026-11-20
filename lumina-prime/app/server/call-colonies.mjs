import { createHash, generateKeyPairSync, createPublicKey, diffieHellman } from 'node:crypto';
import path from 'node:path';
import { pontPaths, readJson, writeJson, readSettings } from '../../../services/pont-p2p/state.mjs';
import { canonical, sign, verify, ficheText } from '../../../services/pont-p2p/crypto.mjs';

// The address book pins identities; a signed directory entry advertises the LAN call endpoint.
export function createCallColonies(dataDir) {
  const paths = pontPaths(dataDir);
  const exchange = generateKeyPairSync('x25519');
  const publicKey = exchange.publicKey.export({ type:'spki', format:'der' }).toString('base64');
  const publication = path.join(paths.state, 'call-endpoint.json');
  const identity = () => {
    const settings = readSettings(dataDir), keys = readJson(paths.key, null);
    return settings.enabled && settings.name && keys ? { ...keys, name:settings.name } : null;
  };
  const id = (name, key) => createHash('sha256').update(`${name}|${key}`).digest('hex').slice(0,16);
  async function contacts() {
    if (!identity()) return [];
    const entries = [];
    for (const [name, entry] of Object.entries(readJson(paths.carnet, {}))) {
      const f = entry.fiche;
      if (!f || f.colony !== name || f.publicKey !== entry.publicKey || !await verify(entry.publicKey, ficheText(f), f.signature)) continue;
      const endpoint = f.reach?.call;
      if (!endpoint || !Array.isArray(endpoint.addresses) || typeof endpoint.key !== 'string') continue;
      entries.push({ id:id(name, entry.publicKey), colony:name, publicKey:entry.publicKey, label:name,
        caller:name, direction:'out', addresses:endpoint.addresses.slice(0,8), exchangeKey:endpoint.key });
    }
    return entries;
  }
  function secret(remoteKey) {
    const shared = diffieHellman({ privateKey:exchange.privateKey,
      publicKey:createPublicKey({ key:Buffer.from(remoteKey,'base64'), type:'spki', format:'der' }) });
    return createHash('sha256').update('mind-call-colony-v2|').update(shared).digest('hex');
  }
  async function authorize(envelope) {
    const me = identity();
    if (!me || envelope.to !== me.name) throw Error('disabled or wrong recipient');
    const entry = readJson(paths.carnet, {})[envelope.from];
    if (!entry || id(envelope.from, entry.publicKey) !== envelope.id) throw Error('unknown colony');
    const { signature, ...signed } = envelope;
    if (!await verify(entry.publicKey, 'mind-call-colony-v2|' + canonical(signed), signature)) throw Error('invalid signature');
    return { peer:{ id:envelope.id, colony:envelope.from, label:envelope.from, caller:envelope.from }, secret:secret(envelope.key) };
  }
  async function wrap(packet, remote) {
    const me = identity();
    if (!me) throw Error('bridge disabled');
    const signed = { ...packet, id:id(me.name, me.publicKey), from:me.name, to:remote.colony, key:publicKey };
    return { ...signed, signature:await sign(me.privateKey, 'mind-call-colony-v2|' + canonical(signed)) };
  }
  // Entry present in the address book, with or without a call endpoint (contacts() skips the latter).
  const known = name => Object.hasOwn(readJson(paths.carnet, {}) ?? {}, name);
  return { identity, contacts, known, authorize, secret, wrap,
    ownId:() => { const me=identity(); return me ? id(me.name,me.publicKey) : null; },
    publish(addresses) { writeJson(publication, { addresses, key:publicKey, at:Date.now() }); },
    unpublish() { writeJson(publication, null); },
  };
}
