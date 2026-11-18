// Colonie « brute » (P2PNode sans service) pour les tests de refus : faux expéditeur, message
// modifié, squat de nom. argv[2] = JSON de configuration du nœud (keyFile déjà écrit par le test).
import { P2PNode } from "../p2p-node.mjs";
import { signEnvelope } from "../crypto.mjs";

const cfg = JSON.parse(process.argv[2]);
const node = new P2PNode(cfg);
const emit = (event, data) => process.send?.({ event, data });
node.on("status", (v) => emit("status", v));
node.on("peer-online", (c) => emit("peer-online", c));
node.on("conflit", (c) => emit("conflit", c));

const commands = {
  info: () => ({ name: node.name, publicKey: node.keys.publicKey, peers: [...node.peers.keys()] }),
  log: () => node.log,
  forge: async ({ colony, from, to, body }) => {
    const env = await signEnvelope(node.keys.privateKey, { v: 1, id: "m" + "f".repeat(16), from, to, ts: Date.now(), kind: "call", body });
    return node.sendRaw(colony, env);
  },
  tamper: async ({ colony, to, body }) => {
    const env = await signEnvelope(node.keys.privateKey, { v: 1, id: "m" + "a".repeat(16), from: node.name, to, ts: Date.now(), kind: "call", body });
    return node.sendRaw(colony, { ...env, body: body + " (modifié)" });
  },
  stop: async () => { await node.stop(); setTimeout(() => process.exit(0), 50); return true; },
};

process.on("message", async ({ rid, cmd, args }) => {
  if (!rid) return;
  try { process.send({ rid, result: await commands[cmd](args ?? {}) }); }
  catch (e) { process.send({ rid, error: String(e?.message ?? e) }); }
});

await node.start();
emit("ready", { name: node.name, publicKey: node.keys.publicKey });
