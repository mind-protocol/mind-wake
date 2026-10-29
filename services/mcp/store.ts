/**
 * État local du hub (SQLite, écrivain unique : le processus hub). Annuaire pseudonyme,
 * messages et fils, demandes d'aide, invitations et séances. Aucun envoi vers l'extérieur :
 * un message n'est qu'une ligne de cette base, lue par son destinataire via le hub.
 *
 * Idempotence : (expéditeur, clé) est unique ; même clé et contenu différent = conflit.
 * Le texte d'un message est conservé tel quel et livré comme donnée non fiable.
 */

import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { digest, opaque } from "../advice/conversation/capability.js";
import { HubError, type HelpStatus } from "./protocol.js";

export type PartyKind = "agent" | "human";
export type Provenance = PartyKind | "service";
export type InvitationStatus = "pending" | "accepted" | "declined" | "cancelled";

export interface StoredMessage {
  readonly messageId: string;
  readonly sequence: number;
  readonly threadId: string;
  readonly senderRef: string;
  readonly recipientRef: string;
  readonly provenance: Provenance;
  readonly text: string;
  readonly inReplyTo: string | null;
  readonly createdAt: string;
}

export interface Thread {
  readonly threadId: string;
  readonly subject: string;
  readonly aRef: string;
  readonly bRef: string;
}

export interface HelpRequest {
  readonly requestId: string;
  readonly requesterRef: string;
  readonly topic: string;
  readonly context: string;
  readonly language: string;
  readonly maxExchanges: number;
  readonly status: HelpStatus;
  readonly sessionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Invitation {
  readonly invitationId: string;
  readonly requestId: string;
  readonly guideRef: string;
  readonly status: InvitationStatus;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

export interface SessionRow {
  readonly sessionId: string;
  readonly requestId: string;
  readonly contractId: string;
  readonly agentRef: string;
  readonly guideRef: string;
  readonly createdAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS parties (
  private_digest TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'human'))
);
CREATE TABLE IF NOT EXISTS threads (
  thread_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  a_ref TEXT NOT NULL,
  b_ref TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL REFERENCES threads(thread_id),
  sender_ref TEXT NOT NULL,
  recipient_ref TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('agent', 'human', 'service')),
  text TEXT NOT NULL,
  in_reply_to TEXT,
  idempotency_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (sender_ref, idempotency_key)
);
CREATE INDEX IF NOT EXISTS messages_recipient ON messages (recipient_ref, sequence);
CREATE TABLE IF NOT EXISTS help_requests (
  request_id TEXT PRIMARY KEY,
  requester_ref TEXT NOT NULL,
  topic TEXT NOT NULL,
  context TEXT NOT NULL,
  language TEXT NOT NULL,
  max_exchanges INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'taken', 'closed')),
  session_id TEXT,
  idempotency_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (requester_ref, idempotency_key)
);
CREATE TABLE IF NOT EXISTS invitations (
  invitation_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES help_requests(request_id),
  guide_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE (request_id, guide_ref)
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES help_requests(request_id),
  contract_id TEXT NOT NULL UNIQUE,
  agent_ref TEXT NOT NULL,
  guide_ref TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const REF_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

function randomRef(kind: PartyKind): string {
  let suffix = "";
  for (const byte of randomBytes(10)) suffix += REF_ALPHABET[byte % REF_ALPHABET.length] ?? "x";
  return `${kind}-${suffix}`;
}

interface MessageRowDb {
  sequence: number;
  message_id: string;
  thread_id: string;
  sender_ref: string;
  recipient_ref: string;
  provenance: Provenance;
  text: string;
  in_reply_to: string | null;
  created_at: string;
}

interface HelpRowDb {
  request_id: string;
  requester_ref: string;
  topic: string;
  context: string;
  language: string;
  max_exchanges: number;
  status: HelpStatus;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

interface InvitationRowDb {
  invitation_id: string;
  request_id: string;
  guide_ref: string;
  status: InvitationStatus;
  created_at: string;
  decided_at: string | null;
}

const toMessage = (r: MessageRowDb): StoredMessage => ({
  messageId: r.message_id,
  sequence: r.sequence,
  threadId: r.thread_id,
  senderRef: r.sender_ref,
  recipientRef: r.recipient_ref,
  provenance: r.provenance,
  text: r.text,
  inReplyTo: r.in_reply_to,
  createdAt: r.created_at,
});

const toHelp = (r: HelpRowDb): HelpRequest => ({
  requestId: r.request_id,
  requesterRef: r.requester_ref,
  topic: r.topic,
  context: r.context,
  language: r.language,
  maxExchanges: r.max_exchanges,
  status: r.status,
  sessionId: r.session_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toInvitation = (r: InvitationRowDb): Invitation => ({
  invitationId: r.invitation_id,
  requestId: r.request_id,
  guideRef: r.guide_ref,
  status: r.status,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

export interface NewMessage {
  readonly senderRef: string;
  readonly recipientRef: string;
  readonly provenance: Provenance;
  readonly text: string;
  readonly idempotencyKey: string;
  readonly threadId?: string;
  readonly subject?: string;
  readonly inReplyTo?: string;
}

export class HubStore {
  readonly #db: Database.Database;
  readonly #now: () => Date;

  constructor(path: string, now: () => Date = () => new Date()) {
    this.#db = new Database(path);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("foreign_keys = ON");
    this.#db.exec(SCHEMA);
    this.#now = now;
  }

  close(): void {
    this.#db.close();
  }

  #iso(): string {
    return this.#now().toISOString();
  }

  /** Pseudonyme stable d'une partie configurée, créé au premier démarrage. */
  ensureParty(privateId: string, kind: PartyKind): string {
    const key = digest(`party:${privateId}`);
    const row = this.#db
      .prepare<[string], { ref: string; kind: PartyKind }>(
        "SELECT ref, kind FROM parties WHERE private_digest = ?",
      )
      .get(key);
    if (row !== undefined) {
      if (row.kind !== kind) throw new Error("nature d'une partie modifiée dans la configuration");
      return row.ref;
    }
    for (;;) {
      const ref = randomRef(kind);
      const taken = this.#db.prepare("SELECT 1 FROM parties WHERE ref = ?").get(ref);
      if (taken !== undefined) continue;
      this.#db
        .prepare("INSERT INTO parties (private_digest, ref, kind) VALUES (?, ?, ?)")
        .run(key, ref, kind);
      return ref;
    }
  }

  thread(threadId: string): Thread | null {
    const row = this.#db
      .prepare<[string], { thread_id: string; subject: string; a_ref: string; b_ref: string }>(
        "SELECT thread_id, subject, a_ref, b_ref FROM threads WHERE thread_id = ?",
      )
      .get(threadId);
    return row === undefined
      ? null
      : { threadId: row.thread_id, subject: row.subject, aRef: row.a_ref, bRef: row.b_ref };
  }

  message(messageId: string): StoredMessage | null {
    const row = this.#db
      .prepare<[string], MessageRowDb>("SELECT * FROM messages WHERE message_id = ?")
      .get(messageId);
    return row === undefined ? null : toMessage(row);
  }

  /** Insère un message (et son fil s'il est nouveau) ; un rejeu renvoie l'original. */
  insertMessage(input: NewMessage): { message: StoredMessage; duplicate: boolean } {
    const payload = digest(
      JSON.stringify([
        input.recipientRef,
        input.text,
        input.threadId ?? null,
        input.subject ?? null,
        input.inReplyTo ?? null,
      ]),
    );
    return this.#db.transaction(() => {
      const prior = this.#db
        .prepare<[string, string], MessageRowDb & { payload_digest: string }>(
          "SELECT * FROM messages WHERE sender_ref = ? AND idempotency_key = ?",
        )
        .get(input.senderRef, input.idempotencyKey);
      if (prior !== undefined) {
        if (prior.payload_digest !== payload) {
          throw new HubError(
            "idempotency_conflict",
            "Clé d'idempotence déjà utilisée avec un contenu différent ; rien n'a été envoyé.",
          );
        }
        return { message: toMessage(prior), duplicate: true };
      }
      const now = this.#iso();
      let threadId = input.threadId;
      if (threadId === undefined) {
        threadId = opaque("thr", 12);
        this.#db
          .prepare(
            "INSERT INTO threads (thread_id, subject, a_ref, b_ref, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(threadId, input.subject ?? "(no subject)", input.senderRef, input.recipientRef, now);
      }
      const messageId = opaque("msg", 12);
      this.#db
        .prepare(
          `INSERT INTO messages (message_id, thread_id, sender_ref, recipient_ref, provenance, text,
             in_reply_to, idempotency_key, payload_digest, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          messageId,
          threadId,
          input.senderRef,
          input.recipientRef,
          input.provenance,
          input.text,
          input.inReplyTo ?? null,
          input.idempotencyKey,
          payload,
          now,
        );
      const stored = this.message(messageId);
      if (stored === null) throw new Error("message introuvable après insertion");
      return { message: stored, duplicate: false };
    })();
  }

  /** Messages reçus par `ref` (ou tout le fil, dans les deux sens), après un curseur. */
  inbox(ref: string, after: number, limit: number, threadId?: string): StoredMessage[] {
    const rows =
      threadId === undefined
        ? this.#db
            .prepare<[string, number, number], MessageRowDb>(
              "SELECT * FROM messages WHERE recipient_ref = ? AND sequence > ? ORDER BY sequence LIMIT ?",
            )
            .all(ref, after, limit)
        : this.#db
            .prepare<[string, number, number], MessageRowDb>(
              "SELECT * FROM messages WHERE thread_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
            )
            .all(threadId, after, limit);
    return rows.map(toMessage);
  }

  insertHelp(input: {
    readonly requesterRef: string;
    readonly topic: string;
    readonly context: string;
    readonly language: string;
    readonly maxExchanges: number;
    readonly idempotencyKey: string;
  }): { request: HelpRequest; duplicate: boolean } {
    const payload = digest(
      JSON.stringify([input.topic, input.context, input.language, input.maxExchanges]),
    );
    return this.#db.transaction(() => {
      const prior = this.#db
        .prepare<[string, string], HelpRowDb & { payload_digest: string }>(
          "SELECT * FROM help_requests WHERE requester_ref = ? AND idempotency_key = ?",
        )
        .get(input.requesterRef, input.idempotencyKey);
      if (prior !== undefined) {
        if (prior.payload_digest !== payload) {
          throw new HubError(
            "idempotency_conflict",
            "Clé d'idempotence déjà utilisée avec une autre demande ; rien n'a été publié.",
          );
        }
        return { request: toHelp(prior), duplicate: true };
      }
      const requestId = opaque("req", 12);
      const now = this.#iso();
      this.#db
        .prepare(
          `INSERT INTO help_requests (request_id, requester_ref, topic, context, language,
             max_exchanges, status, session_id, idempotency_key, payload_digest, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, ?, ?)`,
        )
        .run(
          requestId,
          input.requesterRef,
          input.topic,
          input.context,
          input.language,
          input.maxExchanges,
          input.idempotencyKey,
          payload,
          now,
          now,
        );
      const request = this.help(requestId);
      if (request === null) throw new Error("demande introuvable après insertion");
      return { request, duplicate: false };
    })();
  }

  help(requestId: string): HelpRequest | null {
    const row = this.#db
      .prepare<[string], HelpRowDb>("SELECT * FROM help_requests WHERE request_id = ?")
      .get(requestId);
    return row === undefined ? null : toHelp(row);
  }

  listHelp(filter: { status?: HelpStatus; requesterRef?: string }, limit: number): HelpRequest[] {
    const rows = this.#db
      .prepare<[{ status: string | null; requester: string | null; limit: number }], HelpRowDb>(
        `SELECT * FROM help_requests
         WHERE (@status IS NULL OR status = @status)
           AND (@requester IS NULL OR requester_ref = @requester)
         ORDER BY created_at DESC, request_id LIMIT @limit`,
      )
      .all({ status: filter.status ?? null, requester: filter.requesterRef ?? null, limit });
    return rows.map(toHelp);
  }

  setHelpStatus(requestId: string, status: HelpStatus, sessionId?: string): void {
    this.#db
      .prepare(
        "UPDATE help_requests SET status = ?, session_id = COALESCE(?, session_id), updated_at = ? WHERE request_id = ?",
      )
      .run(status, sessionId ?? null, this.#iso(), requestId);
  }

  /** Invitation unique par (demande, guide) : une seconde invitation renvoie la première. */
  invite(requestId: string, guideRef: string): { invitation: Invitation; duplicate: boolean } {
    return this.#db.transaction(() => {
      const prior = this.#db
        .prepare<[string, string], InvitationRowDb>(
          "SELECT * FROM invitations WHERE request_id = ? AND guide_ref = ?",
        )
        .get(requestId, guideRef);
      if (prior !== undefined) return { invitation: toInvitation(prior), duplicate: true };
      const invitationId = opaque("inv", 12);
      this.#db
        .prepare(
          "INSERT INTO invitations (invitation_id, request_id, guide_ref, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
        )
        .run(invitationId, requestId, guideRef, this.#iso());
      const invitation = this.invitation(invitationId);
      if (invitation === null) throw new Error("invitation introuvable après insertion");
      return { invitation, duplicate: false };
    })();
  }

  invitation(invitationId: string): Invitation | null {
    const row = this.#db
      .prepare<[string], InvitationRowDb>("SELECT * FROM invitations WHERE invitation_id = ?")
      .get(invitationId);
    return row === undefined ? null : toInvitation(row);
  }

  invitationsFor(filter: { guideRef?: string; requestId?: string }): Invitation[] {
    return this.#db
      .prepare<[{ guide: string | null; request: string | null }], InvitationRowDb>(
        `SELECT * FROM invitations WHERE (@guide IS NULL OR guide_ref = @guide)
         AND (@request IS NULL OR request_id = @request) ORDER BY created_at, invitation_id`,
      )
      .all({ guide: filter.guideRef ?? null, request: filter.requestId ?? null })
      .map(toInvitation);
  }

  setInvitationStatus(invitationId: string, status: InvitationStatus): void {
    this.#db
      .prepare("UPDATE invitations SET status = ?, decided_at = ? WHERE invitation_id = ?")
      .run(status, this.#iso(), invitationId);
  }

  insertSession(row: Omit<SessionRow, "createdAt">): void {
    this.#db
      .prepare(
        "INSERT INTO sessions (session_id, request_id, contract_id, agent_ref, guide_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(row.sessionId, row.requestId, row.contractId, row.agentRef, row.guideRef, this.#iso());
  }

  session(sessionId: string): SessionRow | null {
    const row = this.#db
      .prepare<
        [string],
        {
          session_id: string;
          request_id: string;
          contract_id: string;
          agent_ref: string;
          guide_ref: string;
          created_at: string;
        }
      >("SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId);
    return row === undefined
      ? null
      : {
          sessionId: row.session_id,
          requestId: row.request_id,
          contractId: row.contract_id,
          agentRef: row.agent_ref,
          guideRef: row.guide_ref,
          createdAt: row.created_at,
        };
  }

  /** Transaction explicite pour enchaîner plusieurs écritures du hub. */
  transaction<T>(fn: () => T): T {
    return this.#db.transaction(fn)();
  }
}
