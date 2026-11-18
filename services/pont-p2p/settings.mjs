// Réglages « Pont pair-à-pair entre colonies » : actions de l'humain dans l'app desktop.
// Jamais la clé privée en sortie : seulement la clé publique, son empreinte et la carte à partager.
import { NAME_RE } from "./crypto.mjs";
import {
  pontPaths, readSettings, writeSettings, normalizeName, ensureColonyKey, colonyPublicKey, fingerprint,
  contactCard, parseCard, serviceAlive, readJson, writeJson, enqueueRequest, awaitResult, carnetView,
  conflictsView, messageView, queuedSends, KEY_RE,
} from "./state.mjs";

export function pontStatus(dataDir) {
  const s = readSettings(dataDir);
  const P = pontPaths(dataDir);
  const publicKey = colonyPublicKey(dataDir);
  const running = serviceAlive(dataDir);
  const st = running ? readJson(P.status, {}) : {};
  const outbox = readJson(P.outbox, []);
  const queued = queuedSends(dataDir).map((r) => ({ id: r.id, to: r.to, status: "en attente", detail: "pont pas encore démarré", label: "en attente : pont pas encore démarré", createdAt: r.at, history: [] }));
  return {
    enabled: s.enabled, name: s.name, annuaire: s.annuaire,
    publicKey, fingerprint: fingerprint(publicKey), card: s.name && publicKey ? contactCard(s.name, publicKey) : null,
    service: s.enabled ? (running ? "en marche" : "en démarrage (le moteur le lance sous 10 s ; moteur arrêté ou à redémarrer ?)") : "arrêté",
    dht: st.dht ?? null,
    carnet: carnetView(dataDir),
    conflicts: conflictsView(dataDir),
    messages: [...queued, ...outbox.slice(-30).reverse().map(messageView)].slice(0, 30),
  };
}

const fail = (message) => { const e = new Error(message); e.userFacing = true; throw e; };

async function carnetOp(dataDir, op) {
  if (serviceAlive(dataDir)) {
    const rid = enqueueRequest(dataDir, op);
    const r = await awaitResult(dataDir, rid, 8000);
    if (!r) fail("le service du pont ne répond pas ; réessayer dans quelques secondes");
    if (!r.ok) fail(r.reason ?? "refusé");
    return r;
  }
  // Service arrêté : personne d'autre n'écrit le carnet, modification directe.
  const P = pontPaths(dataDir);
  const carnet = readJson(P.carnet, {});
  let conflicts = readJson(P.conflicts, []);
  if (op.op === "addContact") {
    const prev = carnet[op.name];
    if (prev && prev.publicKey !== op.publicKey && !op.force) fail(`${op.name} est déjà épinglé à une autre clé (empreinte ${fingerprint(prev.publicKey)})`);
    const same = prev?.publicKey === op.publicKey;
    carnet[op.name] = { publicKey: op.publicKey, fiche: same ? prev.fiche : null, source: "manuel", firstSeen: prev?.firstSeen ?? new Date().toISOString(), refreshed: same ? prev.refreshed ?? null : null, lastSeen: same ? prev.lastSeen ?? null : null };
    conflicts = conflicts.filter((c) => !(c.name === op.name && (c.claimed === op.publicKey || op.force)));
  } else if (op.op === "forget") {
    delete carnet[op.name];
    conflicts = conflicts.filter((c) => c.name !== op.name);
  } else if (op.op === "dismissConflict") {
    conflicts = conflicts.filter((c) => !(c.name === op.name && c.claimed === op.claimed));
  }
  writeJson(P.carnet, carnet);
  writeJson(P.conflicts, conflicts);
  return { ok: true };
}

/** Une action des Réglages. `payload` vient du webview : tout est revalidé ici. */
export async function pontAction(dataDir, action, payload = {}) {
  const p = payload && typeof payload === "object" ? payload : {};
  switch (action) {
    case "status":
      return pontStatus(dataDir);
    case "enable": {
      const current = readSettings(dataDir);
      const name = p.name === undefined && current.name ? current.name : normalizeName(p.name);
      if (!name) fail("nom invalide : ⬡ suivi de 2 à 31 caractères (minuscules, chiffres, tirets), par exemple ⬡nlr-bureau");
      await ensureColonyKey(dataDir);
      writeSettings(dataDir, { enabled: true, name });
      return pontStatus(dataDir);
    }
    case "disable":
      writeSettings(dataDir, { enabled: false });
      return pontStatus(dataDir);
    case "set_annuaire":
      writeSettings(dataDir, { annuaire: p.annuaire !== false });
      return pontStatus(dataDir);
    case "add_contact": {
      const card = parseCard(String(p.key ?? ""));
      if (!card || !KEY_RE.test(card.publicKey)) fail("clé invalide : coller la carte « ⬡nom ed25519:… » ou la clé ed25519:… reçue");
      const name = normalizeName(p.name ? String(p.name) : card.name ?? "");
      if (!name || !NAME_RE.test(name)) fail("nom invalide : ⬡ suivi de 2 à 31 caractères (minuscules, chiffres, tirets)");
      if (name === readSettings(dataDir).name) fail("c'est le nom de cette colonie");
      if (card.publicKey === colonyPublicKey(dataDir)) fail("c'est la clé de cette colonie");
      await carnetOp(dataDir, { op: "addContact", name, publicKey: card.publicKey, force: p.force === true });
      return pontStatus(dataDir);
    }
    case "forget": {
      const name = normalizeName(String(p.name ?? ""));
      if (!name) fail("nom invalide");
      await carnetOp(dataDir, { op: "forget", name });
      return pontStatus(dataDir);
    }
    case "resolve_conflict": {
      // keep : garder la clé épinglée ; replace : adopter la clé réclamée (après vérification humaine de l'empreinte).
      const name = normalizeName(String(p.name ?? ""));
      const claimed = String(p.claimed ?? "");
      if (!name || !KEY_RE.test(claimed)) fail("conflit invalide");
      if (p.choice === "replace") await carnetOp(dataDir, { op: "addContact", name, publicKey: claimed, force: true });
      else await carnetOp(dataDir, { op: "dismissConflict", name, claimed });
      return pontStatus(dataDir);
    }
    default:
      fail("action inconnue");
  }
}

/** Point d'entrée commun : JSON {action, payload} → {exitCode, stdout}. */
export async function runPontSettings(dataDir, input) {
  try {
    const req = JSON.parse(input || "{}");
    const data = await pontAction(dataDir, String(req.action ?? ""), req.payload ?? {});
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, data }) };
  } catch (e) {
    const message = e?.userFacing ? e.message : "Pont pair-à-pair : action impossible (voir pont-p2p/service.log)";
    return { exitCode: 1, stdout: JSON.stringify({ ok: false, error: { message } }) };
  }
}

