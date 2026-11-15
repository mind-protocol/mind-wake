/** Local projection only. Never import runtime managers: several status helpers acquire locks. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";

const digest = (text) =>
  createHash("sha256").update(text).digest("hex").slice(0, 24);
const date = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const activity = (outcome, ended) =>
  !ended
    ? "inconnu"
    : outcome === "completed" || outcome === "succeeded"
      ? "éteint"
      : outcome === "interrupted" ||
          outcome === "cancelled" ||
          outcome === "orphaned"
        ? "interrompu"
        : "erreur";

export function buildSnapshot({
  dataDir,
  codexHome = path.join(os.homedir(), ".codex"),
  now = new Date().toISOString(),
}) {
  const nodes = new Map(),
    messages = [],
    sources = [],
    limits = [
      "Lecture locale seule ; aucune émission, aucun accusé créé par cette vue.",
      "Brouillons et capture du compositeur : non journalisés, état inconnu dans le graphe. Voir le compositeur du Fork.",
      "Un tour ouvert ne prouve pas un processus actif. Travail/attente actuels inconnus sans heartbeat de session.",
      "Lu et entendu restent inconnus : un reçu de transport ou de lecteur ne prouve pas une lecture humaine.",
      "Historique borné par source ; les limites et erreurs sont affichées. Pas de fusion implicite par contenu.",
      "Les refs audio et destinataires ne sont pas assimilées à un Fork sans correspondance explicite.",
    ];
  const tabs = [
    { id: "principal", label: "Principal" },
    ...Array.from({ length: 7 }, (_, i) => ({
      id: `fork${i + 2}`,
      label: `Fork${i + 2}`,
    })),
  ];
  const node = (id, label, kind, tab = null, extra = {}) => {
    if (!nodes.has(id))
      nodes.set(id, {
        id,
        label,
        kind,
        tab,
        activity: "inconnu",
        at: null,
        detail: "Activité non attestée",
      });
    Object.assign(nodes.get(id), extra);
    return id;
  };
  node("owner", "Utilisateur", "utilisateur");
  tabs.forEach((t) => node(t.id, t.label, "session", t.id));
  const unknown = (key) =>
    node(`unknown:${key}`, "Identité inconnue", "inconnu");
  const ref = (value) =>
    typeof value === "string" && value.trim()
      ? node(`ref:${value}`, value, "destinataire")
      : unknown("recipient");
  function read(relative, callback) {
    const file = path.join(dataDir, relative);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error("unsafe_file");
      const result = callback(file, stat);
      sources.push({
        path: relative,
        state: "read-only",
        at: stat.mtime.toISOString(),
        readAt: now,
      });
      return result;
    } catch (error) {
      sources.push({
        path: relative,
        state: "indisponible",
        at: null,
        readAt: now,
        error: error.code || error.message,
      });
      return null;
    }
  }
  const db = (relative, sql) =>
    read(relative, (file) => {
      const connection = new Database(file, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        return connection.prepare(sql).all();
      } finally {
        connection.close();
      }
    }) || [];
  function json(relative) {
    return read(relative, (file) => JSON.parse(fs.readFileSync(file, "utf8")));
  }
  function lines(relative) {
    return (
      read(relative, (file, stat) => {
        const size = Math.min(stat.size, 2_000_000),
          start = stat.size - size,
          b = Buffer.alloc(size),
          fd = fs.openSync(file, "r");
        try {
          fs.readSync(fd, b, 0, size, start);
        } finally {
          fs.closeSync(fd);
        }
        let raw = b.toString("utf8");
        if (start) {
          raw = raw.slice(raw.indexOf("\n") + 1);
          limits.push(`${relative} : derniers 2 Mo seulement`);
        }
        const result = [];
        for (const [i, line] of raw.split("\n").entries()) {
          if (!line.trim()) continue;
          const row = parse(line);
          if (row) result.push({ row, locator: `tail:${start}:line:${i + 1}` });
          else
            limits.push(`${relative} : ligne incomplète ou invalide ignorée`);
        }
        return result;
      }) || []
    );
  }
  function add({
    id,
    from,
    to,
    kind,
    state,
    at,
    text = "",
    source,
    correlationId = null,
    threadId = null,
    retry = null,
    history = [],
    detail = "",
  }) {
    messages.push({
      id,
      from,
      to,
      kind,
      state,
      at: date(at),
      text,
      source,
      correlationId,
      threadId,
      retry,
      history,
      detail,
    });
  }
  const bindings = new Map();
  for (const t of tabs.slice(1)) {
    const folder = `forks/${t.id.slice(4)}`,
      store = `${folder}/second-thread.sqlite`;
    const identity = db(
      store,
      "SELECT value FROM state WHERE key='threadId'",
    )[0]?.value;
    if (identity) {
      bindings.set(identity, t.id);
      nodes.get(t.id).threadId = identity;
    }
    const turn = db(store, "SELECT * FROM turns ORDER BY n DESC LIMIT 1")[0];
    const enabled = json(`${folder}/enabled.json`);
    Object.assign(nodes.get(t.id), {
      activity: turn?.ended_at
        ? activity(turn.outcome, turn.ended_at)
        : !turn && enabled?.enabled === false
          ? "éteint"
          : "inconnu",
      at: date(turn?.ended_at || turn?.started_at),
      detail: turn
        ? `Tour ${turn.n} · ${turn.outcome || "ouvert, activité non attestée"}${enabled?.enabled === false ? " · nouveaux tours désactivés" : ""}`
        : "Aucun tour observé",
    });
    for (const r of db(
      store,
      "SELECT * FROM (SELECT * FROM entries ORDER BY id DESC LIMIT 500) ORDER BY id",
    )) {
      const human = r.role === "human";
      add({
        id: `${t.id}:entry:${r.id}`,
        from: human ? unknown("entry-origin:" + t.id) : t.id,
        to: human ? t.id : r.role === "agent" ? "owner" : t.id,
        kind: human
          ? "entrée humaine/contextuelle"
          : r.role === "agent"
            ? "message agent"
            : "événement",
        state: human
          ? r.delivered
            ? "injecté au tour · lu inconnu"
            : "queued"
          : "enregistré localement",
        at: r.at,
        text: r.text,
        source: `${store}#entries/${r.id}`,
        threadId: identity || null,
        detail:
          "Rôle du registre ; origine pair non structurée inconnue. Aucun destinataire déduit du texte.",
      });
    }
  }
  // Current principal ownership comes only from its native binding files, never journal body text.
  const bindingDir = path.join(dataDir, "codex-threads");
  try {
    const records = fs
      .readdirSync(bindingDir)
      .filter((n) => /^thread-[a-f0-9]+\.json$/.test(n))
      .flatMap((n) => {
        const r = json(`codex-threads/${n}`);
        return r?.threadId ? [r] : [];
      })
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const current = records[0];
    if (current) {
      bindings.set(current.threadId, "principal");
      nodes.get("principal").threadId = current.threadId;
    }
  } catch {
    limits.push("Binding Codex principal indisponible.");
  }
  const session = db(
    "control.sqlite",
    "SELECT id,started_at,ended_at,outcome FROM sessions ORDER BY started_at DESC LIMIT 1",
  )[0];
  if (session)
    Object.assign(nodes.get("principal"), {
      activity: activity(session.outcome, session.ended_at),
      at: date(session.ended_at || session.started_at),
      detail: `Session ${session.id} · ${session.outcome || "ouverte ; processus non attesté"}`,
    });
  for (const row of db(
    "control.sqlite",
    "SELECT sequence,type,at,session_id,reason FROM journal_events ORDER BY at DESC LIMIT 200",
  ))
    add({
      id: `journal:${row.sequence}`,
      from: "principal",
      to: "principal",
      kind: "journal session",
      state: row.type,
      at: row.at,
      text: row.reason,
      source: `control.sqlite#journal_events/${row.sequence}`,
      correlationId: row.session_id,
    });
  const resolve = (value) => bindings.get(value) || ref(value);
  for (const r of db(
    "owner-inbox.sqlite",
    "SELECT * FROM inbox ORDER BY rowid DESC LIMIT 500",
  )) {
    const o = parse(r.origin_json),
      peer = o?.kind === "peer_message",
      context = o?.kind === "context_copy";
    add({
      id: `inbox:${r.id}`,
      from: o?.senderRef ? resolve(o.senderRef) : "owner",
      to: o?.recipientRef ? resolve(o.recipientRef) : "principal",
      kind: context
        ? "copie de contexte"
        : peer
          ? "message pair"
          : "message utilisateur",
      state: r.emitted_at ? "injecté au tour · lu inconnu" : "queued",
      at: r.at,
      text: r.text,
      source: `owner-inbox.sqlite#inbox/${r.id}`,
      threadId: o?.threadId,
      correlationId: o?.correlationId || r.id,
      history: r.emitted_at
        ? [{ state: "injecté au tour", at: r.emitted_at }]
        : [],
      detail: context
        ? "Contexte seulement ; aucune émission vers un pair attestée."
        : "",
    });
  }
  for (const r of db(
    "owner-messages.sqlite",
    "SELECT id,text,created_at,updated_at,version,agent_id FROM messages WHERE deleted=0 ORDER BY created_at DESC LIMIT 500",
  ))
    add({
      id: `owner:${r.id}`,
      from: resolve(r.agent_id),
      to: "owner",
      kind: "message agent",
      state: "publié localement · lu inconnu",
      at: r.created_at,
      text: r.text,
      source: `owner-messages.sqlite#messages/${r.id}`,
      correlationId: r.id,
      history: [{ state: `version ${r.version}`, at: r.updated_at }],
    });
  for (const r of db(
    "recipient-route.sqlite",
    "SELECT json FROM entries ORDER BY rowid DESC LIMIT 500",
  )
    .map((r) => parse(r.json))
    .filter(Boolean))
    add({
      id: `route:${r.id}`,
      from: resolve(r.senderRef),
      to: resolve(r.recipientRef),
      kind: "message routé",
      state:
        {
          local_stored: "queued · stocké localement",
          remote_stored: "transport accepté · reçu/lu inconnus",
          received: "reçu",
        }[r.state] || "inconnu",
      at: r.at,
      text: r.text,
      source: `recipient-route.sqlite#entries/${r.id}`,
      threadId: r.threadId,
      correlationId: r.messageId || r.id,
      retry: r.retry || null,
    });
  for (const file of ["sent-peer-messages.jsonl", "received-messages.jsonl"])
    for (const { row: r, locator } of lines(file)) {
      const sent = file.startsWith("sent");
      add({
        id: `${file}:${r.id || digest(JSON.stringify(r))}`,
        from: resolve(sent ? r.sender?.ref : r.source?.ref),
        to: sent ? resolve(r.recipient?.ref) : unknown("inbound-target"),
        kind: sent ? "message pair sortant" : "message pair entrant",
        state: sent
          ? r.state === "hub_stored"
            ? "transport accepté · reçu/lu inconnus"
            : "enregistré · envoi inconnu"
          : r.state === "delivered"
            ? "injecté au tour · lu inconnu"
            : "reçu",
        at: r.at,
        text: r.text,
        source: `${file}#${locator}`,
        threadId: r.threadId || r.source?.threadId,
        correlationId: r.messageId || r.source?.messageId || r.id,
        retry: r.idempotencyKey
          ? { idempotencyKey: r.idempotencyKey, attempts: "inconnu" }
          : null,
      });
    }
  for (const r of db(
    "background-jobs.sqlite",
    "SELECT payload FROM jobs ORDER BY rowid DESC LIMIT 500",
  )
    .map((r) => parse(r.payload))
    .filter(Boolean)) {
    const id = node(`job:${r.id}`, r.title || r.id, "service", null, {
      activity:
        r.status === "running"
          ? "travaille"
          : r.status === "queued"
            ? "attend"
            : activity(r.status, r.endedAt),
      at: date(r.endedAt || r.startedAt || r.createdAt),
      detail: `Job ${r.status} · état déclaré par le superviseur ; propriétaire de fil inconnu`,
    });
    add({
      id: `job-event:${r.id}`,
      from: id,
      to: id,
      kind: "job",
      state: r.status,
      at: r.endedAt || r.startedAt || r.createdAt,
      text: r.detail || "",
      source: `background-jobs.sqlite#jobs/${r.id}`,
      correlationId: r.id,
      detail: "Un job ne devient pas une session Fork par son titre.",
    });
  }
  // Durable clip metadata contains no API key. Configuration/MP3 files are never read.
  const audio = "elevenlabs-audio",
    playback = lines(`${audio}/playback.jsonl`);
  try {
    const clips = new Map();
    for (const name of fs
      .readdirSync(path.join(dataDir, audio))
      .filter((n) => /^[a-f0-9-]{36}\.(clip|json)$/.test(n))
      .sort()) {
      const r = json(`${audio}/${name}`);
      if (r?.id) clips.set(r.id, r);
    }
    for (const r of clips.values()) {
      const events = playback
          .filter((x) => x.row.id === r.id)
          .map((x) => ({ state: x.row.phase, at: date(x.row.at) })),
        last = events.at(-1);
      const state =
        {
          queued: "lecture en file",
          started: "lecture démarrée · fin inconnue",
          ended: "joué · accusé lecteur · entendu inconnu",
          blocked: "lecture bloquée",
          cancelled: "lecture annulée",
          error: "erreur lecteur",
        }[last?.state] || "clip généré · lecture inconnue";
      add({
        id: `audio:${r.id}`,
        from: resolve(r.agentRef),
        to: node("service:desktop-audio", "Lecteur desktop", "service"),
        kind: "audio",
        state,
        at: last?.at || r.createdAt,
        text: r.text,
        source: `${audio}/${r.id}.clip + playback.jsonl`,
        threadId: r.threadId,
        correlationId: r.cycleId || r.id,
        history: events,
        detail:
          "fil1/2/3 désigne une conversation vocale, pas Fork2/3. Retry inconnu sans compteur de tentative.",
      });
    }
  } catch {
    limits.push("Spool audio indisponible.");
  }
  // Read only explicitly bound journals; children are separate nodes and inherited rows excluded.
  const journals = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile() && e.name.endsWith(".jsonl")) journals.push(f);
    }
  };
  try {
    walk(path.join(codexHome, "sessions"));
  } catch {
    limits.push("Transcripts Codex indisponibles.");
  }
  const owned = new Map(bindings);
  if (!journals.length)
    limits.push(
      "Aucun journal natif dans " +
        path.join(codexHome, "sessions") +
        " ; v?rifier CODEX_HOME du desktop.",
    );
  const indexed = [];
  for (const file of journals)
    try {
      const fd = fs.openSync(file, "r"),
        b = Buffer.alloc(128000);
      let n;
      try {
        n = fs.readSync(fd, b, 0, b.length, 0);
      } finally {
        fs.closeSync(fd);
      }
      const first = parse(b.subarray(0, n).toString("utf8").split("\n")[0]);
      if (first?.type === "session_meta" && first.payload?.id)
        indexed.push({ file, meta: first.payload });
    } catch {
      /* A rotating journal is reported only if bound below. */
    }
  for (let size = -1; size !== owned.size;) {
    size = owned.size;
    for (const { meta } of indexed) {
      const parent =
        meta.source?.subagent?.thread_spawn?.parent_thread_id ||
        meta.parent_thread_id;
      if (owned.has(parent) && !owned.has(meta.id))
        owned.set(meta.id, owned.get(parent));
    }
  }
  for (const { file, meta } of indexed.filter((x) => owned.has(x.meta.id))) {
    const tab = owned.get(meta.id),
      session = bindings.has(meta.id)
        ? tab
        : node(
            `session:${meta.id}`,
            `Sous-session ${meta.id}`,
            "session",
            tab,
            { threadId: meta.id },
          );
    const journalRows = lines(path.relative(dataDir, file));
    const results = new Map(
      journalRows
        .filter((x) =>
          ["function_call_output", "custom_tool_call_output"].includes(
            x.row.payload?.type,
          ),
        )
        .map((x) => [x.row.payload.call_id, x]),
    );
    for (const { row, locator } of journalRows) {
      const at = date(row.timestamp),
        p = row.payload;
      if (
        !at ||
        !date(meta.timestamp) ||
        at < date(meta.timestamp) ||
        row.type !== "response_item" ||
        !p
      )
        continue;
      if (
        p.type === "message" &&
        p.role === "assistant" &&
        ["commentary", "final"].includes(p.channel || p.phase)
      ) {
        const text = (p.content || [])
          .filter((b) => b.type === "output_text")
          .map((b) => b.text)
          .join("\n");
        add({
          id: `transcript:${meta.id}:${digest(at + JSON.stringify(p))}`,
          from: session,
          to: unknown("assistant-audience"),
          kind: "message agent · transcript",
          state: "produit · transport inconnu",
          at,
          text,
          source: `${file}#${locator}`,
          threadId: meta.id,
          detail:
            "Une sortie de session ne prouve pas une publication au propriétaire.",
        });
      } else if (
        ["function_call", "custom_tool_call"].includes(p.type) &&
        typeof p.name === "string"
      ) {
        const result = results.get(p.call_id),
          completedAt = date(result?.row.timestamp);
        add({
          id: `tool:${meta.id}:${p.call_id || digest(at + JSON.stringify(p))}`,
          from: session,
          to: node(`tool:${p.name}`, p.name, "service"),
          kind: "appel outil",
          state: "appel observé · résultat inconnu",
          at,
          text: p.name,
          source: `${file}#${locator}`,
          threadId: meta.id,
          correlationId: p.call_id,
          history: result
            ? [{ state: "r?sultat outil re?u", at: completedAt }]
            : [],
          detail:
            "Arguments et résultats non exposés ; une intention send_message ne prouve pas un envoi.",
        });
      }
    }
  }
  limits.push(
    "500 entrées par registre, 200 événements de session ; transcripts : derniers 2 Mo, assistant public et appels outils seulement. Claude/anciens fils non liés et outboxes spécifiques aux projets non raccordés.",
  );
  return {
    version: 1,
    observedAt: now,
    tabs,
    nodes: [...nodes.values()],
    messages: messages.sort((a, b) => (b.at || "").localeCompare(a.at || "")),
    sources,
    limits,
  };
}
