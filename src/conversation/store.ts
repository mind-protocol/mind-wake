import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { assertSingleParagraphEdit, ParagraphEditLimitError } from "./edit-constraints.js";
import { CONVERSATION_ROLES } from "./contracts.js";
import type {
  CallMessage,
  CanonicalConversation,
  ConversationCall,
  ConversationEvent,
  ConversationMessage,
  ConversationRole,
  ConversationSnapshot,
  ConversationState,
  FinishConversationCall,
  NewConversationCall,
  NewConversationEvent,
  RepositoryContribution,
  RepositoryEntry,
  ConversationChange,
  NewConversationChange,
  ConversationSegment,
} from "./contracts.js";

export const CONVERSATION_DB = "conversation.sqlite";
export class ConversationConflict extends Error {
  readonly code = "conflict";
}
type JsonRow = { payload: string };
const parse = (row: JsonRow): unknown => JSON.parse(row.payload) as unknown;
const now = (): string => new Date().toISOString();
function identifier(value: string): void {
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(value)) throw new Error("Invalid conversation identity");
}
function roleValue(value: ConversationRole): void {
  if (!(CONVERSATION_ROLES as readonly string[]).includes(value))
    throw new Error("Invalid conversation role");
}
function messagesValue(messages: unknown): asserts messages is readonly CallMessage[] {
  if (
    !Array.isArray(messages) ||
    messages.some((value: unknown) => {
      if (!value || typeof value !== "object") return true;
      const message = value as Record<string, unknown>;
      return (
        (message["role"] !== "user" && message["role"] !== "assistant") ||
        typeof message["content"] !== "string"
      );
    })
  )
    throw new Error("Invalid reconstructed messages");
}
function textValue(text: string): void {
  if (typeof text !== "string" || !text.trim()) throw new Error("Empty conversation text");
}
function leadSegments(text: string, previous?: ConversationMessage): ConversationSegment[] {
  const comments = (previous?.segments ?? [])
    .filter((s) => s.role === "commentary")
    .map((s) => ({ ...s }));
  const suffix = comments.map((segment) => segment.text).join("");
  const lead = suffix && text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
  return [{ role: "lead", text: lead }, ...comments];
}
const combined = (segments: readonly ConversationSegment[]): string =>
  segments.map((segment) => segment.text).join("");
const nonLeadSegments = (message: ConversationMessage): ConversationSegment[] =>
  (message.segments ?? [{ role: "lead", text: message.text }]).filter(
    (segment) => segment.role !== "lead",
  );
interface ParagraphDocument {
  paragraphs: { before: string; body: string }[];
  suffix: string;
}
function paragraphDocument(text: string): ParagraphDocument {
  const pieces = text.split(/(\r?\n[\t ]*\r?\n(?:[\t ]*\r?\n)*)/),
    paragraphs: ParagraphDocument["paragraphs"] = [];
  let pending = "";
  for (let index = 0; index < pieces.length; index += 2) {
    const body = pieces[index] ?? "",
      separator = pieces[index + 1] ?? "";
    if (body.trim()) {
      paragraphs.push({ before: pending, body });
      pending = separator;
    } else pending += body + separator;
  }
  return { paragraphs, suffix: pending };
}
const paragraphText = (document: ParagraphDocument): string =>
  document.paragraphs.map((p) => p.before + p.body).join("") + document.suffix;

export class ConversationStore {
  readonly db: Database.Database;
  constructor(readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, CONVERSATION_DB);
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new Error("Invalid conversation store");
    }
    this.db = new Database(file);
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(conversation_id TEXT NOT NULL, revision INTEGER NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY(conversation_id,revision), FOREIGN KEY(conversation_id) REFERENCES conversations(id));
      CREATE TABLE IF NOT EXISTS submissions(conversation_id TEXT NOT NULL, request_key TEXT NOT NULL,
        text TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(conversation_id,request_key));
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_versions(message_id TEXT NOT NULL, version INTEGER NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY(message_id,version));
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS canonical(conversation_id TEXT NOT NULL, role TEXT NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY(conversation_id,role));
      CREATE TABLE IF NOT EXISTS canonical_versions(conversation_id TEXT NOT NULL, role TEXT NOT NULL,
        version INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(conversation_id,role,version));
      CREATE TABLE IF NOT EXISTS repository(conversation_id TEXT NOT NULL, role TEXT NOT NULL, entry_key TEXT NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY(conversation_id,role,entry_key));
      CREATE TABLE IF NOT EXISTS repository_versions(conversation_id TEXT NOT NULL, role TEXT NOT NULL,
        entry_key TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(conversation_id,role,entry_key,version));
      CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL,
        payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL,
        payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS conversation_messages ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS conversation_calls ON calls(conversation_id);
      CREATE INDEX IF NOT EXISTS conversation_events ON events(conversation_id,sequence);
      CREATE INDEX IF NOT EXISTS conversation_changes ON changes(conversation_id,sequence);
    `);
  }
  close(): void {
    this.db.close();
  }
  current(conversationId: string): ConversationState | null {
    identifier(conversationId);
    const row = this.db
      .prepare("SELECT payload FROM conversations WHERE id=?")
      .get(conversationId) as JsonRow | undefined;
    return row ? (parse(row) as ConversationState) : null;
  }
  private require(id: string, revision?: number): ConversationState {
    const state = this.current(id);
    if (!state) throw new Error("Unknown conversation");
    if (revision !== undefined && state.revision !== revision)
      throw new ConversationConflict("Conversation revision changed");
    return state;
  }
  private save(state: ConversationState, newRevision = false): void {
    this.db
      .prepare(
        "INSERT INTO conversations(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(state.id, JSON.stringify(state));
    if (newRevision)
      this.db
        .prepare("INSERT INTO revisions(conversation_id,revision,payload) VALUES (?,?,?)")
        .run(state.id, state.revision, JSON.stringify(state));
  }
  createConversation(id = "main"): ConversationState {
    identifier(id);
    return this.db
      .transaction(() => {
        const old = this.current(id);
        if (old) return old;
        const at = now();
        const state: ConversationState = {
          id,
          revision: 0,
          status: "active",
          text: "",
          createdAt: at,
          updatedAt: at,
        };
        this.save(state, true);
        this.recordChange({
          conversationId: id,
          revision: 0,
          kind: "conversation_created",
          before: null,
          after: state,
          at,
        });
        return state;
      })
      .immediate();
  }
  submit(
    conversationId: string,
    text: string,
    idempotencyKey: string,
    expectedRevision?: number,
  ): ConversationState {
    identifier(conversationId);
    identifier(idempotencyKey);
    textValue(text);
    return this.db
      .transaction(() => {
        const prior = this.db
          .prepare(
            "SELECT text,revision FROM submissions WHERE conversation_id=? AND request_key=?",
          )
          .get(conversationId, idempotencyKey) as { text: string; revision: number } | undefined;
        if (prior) {
          if (prior.text !== text)
            throw new ConversationConflict("Submission key already used for another message");
          return this.revision(conversationId, prior.revision);
        }
        const old = this.current(conversationId) ?? this.createConversation(conversationId);
        if (expectedRevision !== undefined && old.revision !== expectedRevision)
          throw new ConversationConflict("Conversation revision changed");
        const at = now();
        // Persisting a human message does not lift a stopped conversation.
        const state: ConversationState = {
          ...old,
          revision: old.revision + 1,
          text,
          updatedAt: at,
          status: old.status === "stopped" ? "stopped" : "active",
        };
        this.save(state, true);
        const message: ConversationMessage = {
          id: `message-${randomUUID()}`,
          conversationId,
          revision: state.revision,
          role: "human",
          text,
          version: 1,
          at,
          edited: false,
        };
        this.saveMessage(message);
        this.db
          .prepare(
            "INSERT INTO submissions(conversation_id,request_key,text,revision) VALUES (?,?,?,?)",
          )
          .run(conversationId, idempotencyKey, text, state.revision);
        this.appendEvent({
          conversationId,
          revision: state.revision,
          kind: "human_message",
          text: message.id,
          at,
        });
        this.recordChange({
          conversationId,
          revision: state.revision,
          kind: "human_message",
          messageId: message.id,
          before: null,
          after: message,
          at,
        });
        return state;
      })
      .immediate();
  }
  revision(conversationId: string, revision: number): ConversationState {
    const row = this.db
      .prepare("SELECT payload FROM revisions WHERE conversation_id=? AND revision=?")
      .get(conversationId, revision) as JsonRow | undefined;
    if (!row) throw new Error("Unknown conversation revision");
    return parse(row) as ConversationState;
  }
  messages(conversationId: string): ConversationMessage[] {
    return (
      this.db
        .prepare("SELECT payload FROM messages WHERE conversation_id=? ORDER BY rowid")
        .all(conversationId) as JsonRow[]
    ).map((row) => parse(row) as ConversationMessage);
  }
  messageHistory(messageId: string): ConversationMessage[] {
    return (
      this.db
        .prepare("SELECT payload FROM message_versions WHERE message_id=? ORDER BY version")
        .all(messageId) as JsonRow[]
    ).map((row) => parse(row) as ConversationMessage);
  }
  messageVersions(conversationId: string): ConversationMessage[] {
    return (
      this.db
        .prepare(
          "SELECT v.payload FROM message_versions v JOIN messages m ON m.id=v.message_id WHERE m.conversation_id=? ORDER BY m.rowid,v.version",
        )
        .all(conversationId) as JsonRow[]
    ).map((row) => parse(row) as ConversationMessage);
  }
  private saveMessage(message: ConversationMessage): void {
    if (
      message.segments &&
      (message.segments.some(
        (s) =>
          !(CONVERSATION_ROLES as readonly string[]).includes(s.role) || typeof s.text !== "string",
      ) ||
        combined(message.segments) !== message.text)
    )
      throw Error("Message segments must reproduce its complete public text");
    this.db
      .prepare(
        "INSERT INTO messages(id,conversation_id,payload) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(message.id, message.conversationId, JSON.stringify(message));
    this.db
      .prepare("INSERT INTO message_versions(message_id,version,payload) VALUES (?,?,?)")
      .run(message.id, message.version, JSON.stringify(message));
  }
  private logParagraphRejection(
    conversationId: string,
    revision: number,
    role: ConversationRole,
    error: ParagraphEditLimitError,
    detail: { callId?: string; messageId?: string } = {},
  ): void {
    this.appendEvent({
      conversationId,
      revision,
      role,
      kind: "paragraph_edit_rejected",
      text: error.message,
      ...(detail.callId ? { callId: detail.callId } : {}),
    });
    this.recordChange({
      conversationId,
      revision,
      role,
      kind: "edit_rejected",
      before: null,
      after: { code: error.code },
      reason: error.message,
      ...detail,
    });
  }
  /** Called only after validation of the whole candidate, never to bypass that limit. */
  private projectParagraphs(
    before: ConversationMessage,
    after: string,
    revision: number,
    detail: { callId?: string; reason?: string },
  ): void {
    const document = paragraphDocument(before.text),
      wanted = paragraphDocument(after);
    let current = before;
    const commit = (kind: "replace" | "insert" | "delete", paragraphIndex: number): void => {
      const text = paragraphText(document);
      if (text === current.text) return;
      const value: ConversationMessage = {
        ...current,
        text,
        version: current.version + 1,
        ...(current.role === "lead"
          ? { segments: [{ role: "lead", text }], draft: false }
          : current.segments
            ? { segments: [{ role: current.role as ConversationRole, text }] }
            : {}),
      };
      this.saveMessage(value);
      this.recordChange({
        conversationId: before.conversationId,
        revision,
        role: before.role as ConversationRole,
        kind: "message_rewritten",
        messageId: before.id,
        before: current,
        after: value,
        operation: { kind, paragraphIndex },
        ...detail,
      });
      current = value;
    };
    let position = 0,
      next = 0;
    while (position < document.paragraphs.length || next < wanted.paragraphs.length) {
      const old = document.paragraphs[position],
        target = wanted.paragraphs[next];
      if (old && target && old.body === target.body) {
        position++;
        next++;
        continue;
      }
      const laterOld = target
        ? document.paragraphs.findIndex((p, index) => index > position && p.body === target.body)
        : -1;
      const laterNew = old
        ? wanted.paragraphs.findIndex((p, index) => index > next && p.body === old.body)
        : -1;
      if (old && (!target || laterOld !== -1)) {
        document.paragraphs.splice(position, 1);
        if (position === 0 && document.paragraphs[0]) document.paragraphs[0].before = old.before;
        if (document.paragraphs.length === 0)
          document.suffix = wanted.paragraphs.length === 0 ? wanted.suffix : "";
        commit("delete", position);
        continue;
      }
      if (target && (!old || laterNew !== -1)) {
        document.paragraphs.splice(position, 0, { ...target });
        const following = document.paragraphs[position + 1];
        if (following && !following.before)
          following.before = wanted.paragraphs[next + 1]?.before || "\n\n";
        commit("insert", position);
        position++;
        next++;
        continue;
      }
      if (old && target) {
        old.body = target.body;
        commit("replace", position);
        position++;
        next++;
      }
    }
    // Separator formatting stays exact, attributed to one adjacent paragraph.
    for (let index = 0; index < document.paragraphs.length; index++) {
      const paragraph = document.paragraphs[index],
        target = wanted.paragraphs[index];
      if (!paragraph || !target) throw Error("Paragraph projection lost its aligned target");
      if (paragraph.before !== target.before) {
        paragraph.before = target.before;
        commit("replace", index);
      }
    }
    if (document.suffix !== wanted.suffix) {
      document.suffix = wanted.suffix;
      commit("replace", Math.max(0, document.paragraphs.length - 1));
    }
    if (current.text !== after)
      throw Error("Paragraph projection did not reproduce the validated candidate");
  }
  editMessage(
    conversationId: string,
    messageId: string,
    text: string,
    expectedVersion: number,
  ): ConversationState {
    textValue(text);
    return this.db
      .transaction(() => {
        const state = this.require(conversationId);
        const row = this.db
          .prepare("SELECT payload FROM messages WHERE id=? AND conversation_id=?")
          .get(messageId, conversationId) as JsonRow | undefined;
        if (!row) throw new Error("Unknown conversation message");
        const message = parse(row) as ConversationMessage;
        if (message.role !== "human" && message.role !== "lead")
          throw new Error("Only human and Lead messages are editable");
        if (message.version !== expectedVersion)
          throw new ConversationConflict("Message version changed");
        if (message.text === text && message.draft !== true) return state;
        const at = now(),
          nextRevision = state.revision + 1;
        const edited: ConversationMessage = {
          ...message,
          text,
          version: message.version + 1,
          revision: nextRevision,
          edited: true,
          ...(message.role === "lead"
            ? { segments: [{ role: "lead" as const, text }], draft: false }
            : {}),
        };
        this.saveMessage(edited);
        const humans = this.messages(conversationId).filter((m) => m.role === "human");
        const next: ConversationState = {
          ...state,
          revision: nextRevision,
          text: humans.at(-1)?.text ?? state.text,
          status: state.status === "stopped" ? "stopped" : "active",
          updatedAt: at,
        };
        this.save(next, true);
        this.appendEvent({
          conversationId,
          revision: nextRevision,
          kind: "human_edit",
          text: messageId,
          at,
        });
        this.recordChange({
          conversationId,
          revision: nextRevision,
          kind: "human_edit",
          messageId,
          before: message,
          after: edited,
          at,
          ...(message.role === "human" ? {} : { role: message.role }),
        });
        return next;
      })
      .immediate();
  }
  /** Materialize a streamed draft only on the exact revision the human edited. */
  editPreview(
    conversationId: string,
    callId: string,
    text: string,
    expectedRevision: number,
  ): ConversationState {
    textValue(text);
    return this.db
      .transaction(() => {
        const state = this.require(conversationId, expectedRevision),
          call = this.call(callId);
        if (
          !call ||
          call.conversationId !== conversationId ||
          call.revision !== expectedRevision ||
          call.role !== "lead" ||
          call.pass !== 1
        )
          throw new ConversationConflict(
            "Lead preview no longer belongs to the current conversation",
          );
        const existing = this.messages(conversationId).findLast(
          (m) => m.role === "lead" && m.revision === expectedRevision,
        );
        if (existing?.draft === true && existing.sourceCallId === callId)
          return this.editMessage(conversationId, existing.id, text, existing.version);
        if (existing)
          throw new ConversationConflict(
            "The final Lead answer has arrived; preserve the draft and edit that answer instead",
          );
        const at = now(),
          revision = state.revision + 1;
        const message: ConversationMessage = {
          id: `preview-${callId}`,
          conversationId,
          revision,
          role: "lead",
          text,
          version: 1,
          at,
          edited: true,
          pass: 1,
          sourceCallId: callId,
          segments: [{ role: "lead", text }],
          draft: false,
        };
        this.saveMessage(message);
        const next: ConversationState = {
          ...state,
          revision,
          status: state.status === "stopped" ? "stopped" : "active",
          updatedAt: at,
        };
        this.save(next, true);
        this.appendEvent({
          conversationId,
          revision,
          role: "lead",
          callId,
          kind: "human_edit",
          text: message.id,
          at,
        });
        this.recordChange({
          conversationId,
          revision,
          role: "lead",
          callId,
          messageId: message.id,
          kind: "human_preview_edit",
          before: null,
          after: message,
          at,
        });
        return next;
      })
      .immediate();
  }
  /** A stable editable Lead slot, populated from public text while its call runs. */
  updateLeadDraft(
    conversationId: string,
    revision: number,
    callId: string,
    text: string,
  ): ConversationMessage | null {
    if (typeof text !== "string" || !text.trim()) return null;
    return this.db
      .transaction(() => {
        const state = this.current(conversationId),
          call = this.call(callId);
        if (
          !state ||
          state.revision !== revision ||
          state.status !== "active" ||
          !call ||
          call.status !== "running" ||
          call.conversationId !== conversationId ||
          call.revision !== revision ||
          call.role !== "lead" ||
          call.pass !== 1
        )
          return null;
        const before = this.messages(conversationId).findLast(
          (m) => m.role === "lead" && m.revision === revision,
        );
        if (before && (before.edited || before.draft !== true)) return null;
        const segments = leadSegments(text, before),
          value = combined(segments);
        if (before?.text === value) return before;
        const at = now(),
          message: ConversationMessage = {
            id: before?.id ?? `lead-${randomUUID()}`,
            conversationId,
            revision,
            role: "lead",
            text: value,
            segments,
            draft: true,
            version: (before?.version ?? 0) + 1,
            at: before?.at ?? at,
            edited: false,
            pass: 1,
            sourceCallId: callId,
          };
        this.saveMessage(message);
        // Deltas are already in events. Do not flood the change log with every token.
        if (!before)
          this.recordChange({
            conversationId,
            revision,
            role: "lead",
            callId,
            messageId: message.id,
            kind: "lead_draft_started",
            before: null,
            after: message,
            at,
          });
        return message;
      })
      .immediate();
  }
  /** Commentary edits the current Lead message, without creating a second bubble. */
  applyCommentary(
    conversationId: string,
    revision: number,
    callId: string,
    targetMessageId: string,
    expectedVersion: number,
    text: string,
  ): ConversationMessage {
    if (typeof text !== "string") throw Error("Invalid Commentary text");
    try {
      return this.db
        .transaction(() => {
          const state = this.require(conversationId, revision),
            call = this.call(callId);
          if (state.status !== "active")
            throw new ConversationConflict("Conversation is not active");
          if (
            !call ||
            call.conversationId !== conversationId ||
            call.revision !== revision ||
            call.role !== "commentary" ||
            call.pass !== 1 ||
            call.status !== "succeeded"
          )
            throw new ConversationConflict(
              "Commentary result does not belong to the current conversation",
            );
          const target = this.messages(conversationId).find((m) => m.id === targetMessageId);
          if (!target || target.role !== "lead" || target.revision !== revision || target.edited)
            throw new ConversationConflict("Lead message was changed by the human or superseded");
          if (
            !Number.isSafeInteger(expectedVersion) ||
            expectedVersion < 1 ||
            expectedVersion > target.version
          )
            throw new ConversationConflict("Invalid Commentary target version");
          const versions = this.messageHistory(targetMessageId),
            base = versions.find((m) => m.version === expectedVersion);
          if (!base) throw new ConversationConflict("Commentary target version is unavailable");
          if (expectedVersion !== target.version) {
            const unchanged = JSON.stringify(nonLeadSegments(base));
            const anotherCommentary = this.changes(conversationId).some(
              (change) =>
                change.kind === "commentary_applied" &&
                change.messageId === targetMessageId &&
                change.after !== null &&
                typeof change.after === "object" &&
                typeof (change.after as { version?: unknown }).version === "number" &&
                (change.after as { version: number }).version > expectedVersion,
            );
            if (
              anotherCommentary ||
              versions
                .filter((m) => m.version >= expectedVersion)
                .some(
                  (m) =>
                    m.edited ||
                    m.revision !== revision ||
                    JSON.stringify(nonLeadSegments(m)) !== unchanged,
                )
            )
              throw new ConversationConflict("Another Commentary or human edit changed the target");
          }
          const current = (target.segments ?? [{ role: "lead" as const, text: target.text }])
            .filter((segment) => segment.role !== "commentary")
            .map((segment) => ({ ...segment }));
          assertSingleParagraphEdit([{ before: "", after: text }]);
          const leadText = combined(current),
            commentaryText =
              leadText && !/\n\s*$/.test(leadText) && !/^\s*\n/.test(text) ? `\n\n${text}` : text;
          const segments: ConversationSegment[] = text
            ? [...current, { role: "commentary", text: commentaryText }]
            : current;
          const message: ConversationMessage = {
            ...target,
            segments,
            text: combined(segments),
            version: target.version + 1,
          };
          this.saveMessage(message);
          this.recordChange({
            conversationId,
            revision,
            role: "commentary",
            callId,
            messageId: targetMessageId,
            kind: "commentary_applied",
            before: target,
            after: message,
            ...(expectedVersion === target.version
              ? {}
              : {
                  reason: `Rebased on automatic Lead changes after version ${String(expectedVersion)}`,
                }),
          });
          this.appendEvent({
            conversationId,
            revision,
            role: "commentary",
            callId,
            kind: "commentary_applied",
            text: targetMessageId,
          });
          return message;
        })
        .immediate();
    } catch (error) {
      if (error instanceof ParagraphEditLimitError)
        this.logParagraphRejection(conversationId, revision, "commentary", error, {
          callId,
          messageId: targetMessageId,
        });
      throw error;
    }
  }
  addCall(input: NewConversationCall): ConversationCall {
    roleValue(input.role);
    messagesValue(input.messages);
    if (![1, 2].includes(input.pass) || typeof input.systemPrompt !== "string")
      throw new Error("Invalid conversation call");
    const id = input.id ?? `call-${randomUUID()}`;
    identifier(id);
    const request = {
      conversationId: input.conversationId,
      revision: input.revision,
      role: input.role,
      pass: input.pass,
      systemPrompt: input.systemPrompt,
      messages: input.messages,
    };
    const inputHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    return this.db
      .transaction(() => {
        const prior = this.call(id);
        if (prior) {
          if (prior.inputHash !== inputHash)
            throw new ConversationConflict("Call identity already used for other inputs");
          return prior;
        }
        const state = this.require(input.conversationId, input.revision);
        if (state.status !== "active") throw new ConversationConflict("Conversation is not active");
        const call: ConversationCall = {
          id,
          ...request,
          inputHash,
          status: "running",
          startedAt: now(),
          endedAt: null,
          text: "",
          published: false,
        };
        this.saveCall(call);
        this.appendEvent({
          conversationId: call.conversationId,
          revision: call.revision,
          role: call.role,
          callId: id,
          kind: "call_started",
          text: "",
          at: call.startedAt,
        });
        this.recordChange({
          conversationId: call.conversationId,
          revision: call.revision,
          role: call.role,
          callId: id,
          kind: "call_started",
          at: call.startedAt,
          before: null,
          after: { status: call.status, pass: call.pass, inputHash: call.inputHash },
        });
        return call;
      })
      .immediate();
  }
  call(id: string): ConversationCall | null {
    const row = this.db.prepare("SELECT payload FROM calls WHERE id=?").get(id) as
      JsonRow | undefined;
    return row ? (parse(row) as ConversationCall) : null;
  }
  calls(conversationId: string): ConversationCall[] {
    return (
      this.db
        .prepare("SELECT payload FROM calls WHERE conversation_id=? ORDER BY rowid")
        .all(conversationId) as JsonRow[]
    ).map((row) => parse(row) as ConversationCall);
  }
  private saveCall(call: ConversationCall): void {
    this.db
      .prepare(
        "INSERT INTO calls(id,conversation_id,payload) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(call.id, call.conversationId, JSON.stringify(call));
  }
  finishCall(
    id: string,
    result: FinishConversationCall,
  ): { call: ConversationCall; published: boolean; message?: ConversationMessage } {
    if (
      !["succeeded", "failed", "cancelled", "interrupted"].includes(result.status) ||
      typeof result.text !== "string" ||
      (result.usage !== undefined && (!Number.isFinite(result.usage) || result.usage < 0))
    )
      throw new Error("Invalid call result");
    try {
      return this.db
        .transaction(() => {
          const old = this.call(id);
          if (!old) throw new Error("Unknown conversation call");
          if (old.status !== "running") {
            if (
              old.status !== result.status ||
              old.text !== result.text ||
              old.error !== result.error ||
              old.usage !== result.usage ||
              old.rawOutput !== result.rawOutput
            )
              throw new ConversationConflict("Call is already finished with another result");
            const message = this.messageVersions(old.conversationId).findLast(
              (m) => m.sourceCallId === id,
            );
            return { call: old, published: old.published, ...(message ? { message } : {}) };
          }
          const state = this.require(old.conversationId),
            at = now();
          const leadSlot =
            old.role === "lead" && old.pass === 1
              ? this.messages(old.conversationId).findLast(
                  (m) => m.role === "lead" && m.revision === old.revision,
                )
              : undefined;
          const published =
            state.revision === old.revision &&
            state.status === "active" &&
            result.status === "succeeded" &&
            leadSlot?.edited !== true &&
            (result.publish ?? old.pass === 1) &&
            result.text.trim().length > 0;
          const call: ConversationCall = {
            ...old,
            status: result.status,
            text: result.text,
            endedAt: at,
            published,
            ...(result.error === undefined ? {} : { error: result.error }),
            ...(result.usage === undefined ? {} : { usage: result.usage }),
            ...(result.rawOutput === undefined ? {} : { rawOutput: result.rawOutput }),
          };
          this.saveCall(call);
          let message: ConversationMessage | undefined;
          if (published) {
            const segments = old.role === "lead" ? leadSegments(result.text, leadSlot) : undefined;
            if (old.role === "lead")
              assertSingleParagraphEdit([
                {
                  before: leadSlot?.text ?? "",
                  after: segments ? combined(segments) : result.text,
                },
              ]);
            message = {
              id: leadSlot?.id ?? `result-${id}`,
              conversationId: old.conversationId,
              revision: old.revision,
              role: old.role,
              pass: old.pass,
              text: segments ? combined(segments) : result.text,
              version: (leadSlot?.version ?? 0) + 1,
              at: leadSlot?.at ?? at,
              edited: false,
              sourceCallId: id,
              ...(segments ? { segments, draft: false } : {}),
            };
            this.saveMessage(message);
            this.recordChange({
              conversationId: old.conversationId,
              revision: old.revision,
              role: old.role,
              callId: id,
              messageId: message.id,
              kind: leadSlot ? "lead_improved" : "message_published",
              before: leadSlot ?? null,
              after: message,
              at,
            });
          }
          this.recordChange({
            conversationId: old.conversationId,
            revision: old.revision,
            role: old.role,
            callId: id,
            kind: "call_finished",
            at,
            before: { status: old.status, published: old.published },
            after: {
              status: call.status,
              published: call.published,
              outputRef: id,
              ...(call.error === undefined ? {} : { error: call.error }),
              ...(call.usage === undefined ? {} : { usage: call.usage }),
            },
          });
          this.appendEvent({
            conversationId: old.conversationId,
            revision: old.revision,
            role: old.role,
            callId: id,
            kind: published
              ? "call_published"
              : state.revision !== old.revision
                ? "call_stale"
                : "call_finished",
            text: result.error ?? "",
            at,
          });
          return { call, published, ...(message ? { message } : {}) };
        })
        .immediate();
    } catch (error) {
      if (error instanceof ParagraphEditLimitError) {
        const call = this.call(id);
        if (call?.status === "running")
          this.finishCall(id, {
            ...result,
            status: "failed",
            error: error.message,
            publish: false,
          });
        if (call)
          this.logParagraphRejection(call.conversationId, call.revision, call.role, error, {
            callId: id,
          });
      }
      throw error;
    }
  }
  appendEvent(input: NewConversationEvent): ConversationEvent {
    const state = this.require(input.conversationId);
    if (
      !Number.isInteger(input.revision) ||
      input.revision < 0 ||
      input.revision > state.revision ||
      !input.kind ||
      typeof input.text !== "string"
    )
      throw new Error("Invalid conversation event");
    if (input.role !== undefined) roleValue(input.role);
    const payload = { ...input, at: input.at ?? now() };
    const result = this.db
      .prepare("INSERT INTO events(conversation_id,payload) VALUES (?,?)")
      .run(input.conversationId, JSON.stringify(payload));
    const event = { ...payload, sequence: Number(result.lastInsertRowid) };
    if (input.kind === "rewrite_applied" && input.role !== undefined) {
      const canonical = this.canonical(input.role, input.conversationId);
      this.recordChange({
        conversationId: input.conversationId,
        revision: input.revision,
        role: input.role,
        kind: "rewrite_explanation",
        at: payload.at,
        before: null,
        after: { canonicalVersion: canonical?.version ?? null, eventSequence: event.sequence },
        reason: input.text,
        ...(input.callId === undefined ? {} : { callId: input.callId }),
      });
    }
    return event;
  }
  events(conversationId: string, after = 0): ConversationEvent[] {
    return (
      this.db
        .prepare(
          "SELECT sequence,payload FROM events WHERE conversation_id=? AND sequence>? ORDER BY sequence",
        )
        .all(conversationId, after) as (JsonRow & { sequence: number })[]
    ).map((row) => ({
      ...(parse(row) as Omit<ConversationEvent, "sequence">),
      sequence: row.sequence,
    }));
  }
  recordChange(input: NewConversationChange): ConversationChange {
    const state = this.require(input.conversationId);
    if (
      !Number.isInteger(input.revision) ||
      input.revision < 0 ||
      input.revision > state.revision ||
      !input.kind
    )
      throw Error("Invalid conversation change");
    if (input.role !== undefined) roleValue(input.role);
    const payload = {
      ...input,
      before: input.before ?? null,
      after: input.after ?? null,
      at: input.at ?? now(),
    };
    const result = this.db
      .prepare("INSERT INTO changes(conversation_id,payload) VALUES (?,?)")
      .run(input.conversationId, JSON.stringify(payload));
    return { ...payload, sequence: Number(result.lastInsertRowid) };
  }
  changes(conversationId: string, after = 0): ConversationChange[] {
    return (
      this.db
        .prepare(
          "SELECT sequence,payload FROM changes WHERE conversation_id=? AND sequence>? ORDER BY sequence",
        )
        .all(conversationId, after) as (JsonRow & { sequence: number })[]
    ).map((row) => ({
      ...(parse(row) as Omit<ConversationChange, "sequence">),
      sequence: row.sequence,
    }));
  }
  canonical(role: ConversationRole, conversationId: string): CanonicalConversation | null {
    roleValue(role);
    const row = this.db
      .prepare("SELECT payload FROM canonical WHERE conversation_id=? AND role=?")
      .get(conversationId, role) as JsonRow | undefined;
    return row ? (parse(row) as CanonicalConversation) : null;
  }
  setCanonical(
    role: ConversationRole,
    conversationId: string,
    expectedRevision: number,
    messages: readonly CallMessage[],
    detail: { callId?: string; reason?: string } = {},
  ): CanonicalConversation {
    roleValue(role);
    messagesValue(messages);
    return this.db
      .transaction(() => {
        const state = this.require(conversationId, expectedRevision);
        if (state.status === "stopped") throw new ConversationConflict("Conversation is stopped");
        const prior = this.canonical(role, conversationId);
        const value: CanonicalConversation = {
          role,
          conversationId,
          revision: expectedRevision,
          version: (prior?.version ?? 0) + 1,
          messages,
          updatedAt: now(),
        };
        this.db
          .prepare(
            "INSERT INTO canonical(conversation_id,role,payload) VALUES (?,?,?) ON CONFLICT(conversation_id,role) DO UPDATE SET payload=excluded.payload",
          )
          .run(conversationId, role, JSON.stringify(value));
        this.db
          .prepare(
            "INSERT INTO canonical_versions(conversation_id,role,version,payload) VALUES (?,?,?,?)",
          )
          .run(conversationId, role, value.version, JSON.stringify(value));
        this.appendEvent({
          conversationId,
          revision: expectedRevision,
          role,
          kind: "canonical_updated",
          text: String(value.version),
        });
        this.recordChange({
          conversationId,
          revision: expectedRevision,
          role,
          kind: "canonical_updated",
          before: prior,
          after: value,
          at: value.updatedAt,
          ...detail,
        });
        return value;
      })
      .immediate();
  }
  canonicalHistory(role: ConversationRole, conversationId: string): CanonicalConversation[] {
    return (
      this.db
        .prepare(
          "SELECT payload FROM canonical_versions WHERE conversation_id=? AND role=? ORDER BY version",
        )
        .all(conversationId, role) as JsonRow[]
    ).map((row) => parse(row) as CanonicalConversation);
  }
  /** Commit the next-call context and its visible projection as one CAS operation. */
  publishRewrite(
    conversationId: string,
    expectedRevision: number,
    role: ConversationRole,
    messages: readonly CallMessage[],
    detail: { callId?: string; reason?: string } = {},
  ): CanonicalConversation {
    roleValue(role);
    messagesValue(messages);
    try {
      return this.db
        .transaction(() => {
          this.require(conversationId, expectedRevision);
          const visible = this.messages(conversationId).filter((m) => m.role === role);
          const rewritten = messages.filter((m) => m.role === "assistant");
          if (rewritten.length !== visible.length)
            throw new ConversationConflict(
              "Rewritten assistant messages do not match the role conversation",
            );
          for (const [index, before] of visible.entries()) {
            const after = rewritten[index];
            if (!after) throw new ConversationConflict("A rewritten message is missing");
            if (before.edited && before.text !== after.content)
              throw new ConversationConflict("A human-edited answer must be preserved");
          }
          assertSingleParagraphEdit(
            visible.map((before, index) => {
              const after = rewritten[index];
              if (!after) throw new ConversationConflict("A rewritten message is missing");
              return { before: before.text, after: after.content };
            }),
          );
          for (const [index, before] of visible.entries()) {
            const after = rewritten[index];
            if (!after) throw new ConversationConflict("A rewritten message is missing");
            if (before.text !== after.content)
              this.projectParagraphs(before, after.content, expectedRevision, detail);
          }
          const canonical = this.setCanonical(
            role,
            conversationId,
            expectedRevision,
            messages,
            detail,
          );
          this.appendEvent({
            conversationId,
            revision: expectedRevision,
            role,
            kind: "rewrite_published",
            text: String(canonical.version),
          });
          return canonical;
        })
        .immediate();
    } catch (error) {
      if (error instanceof ParagraphEditLimitError)
        this.logParagraphRejection(conversationId, expectedRevision, role, error, detail);
      throw error;
    }
  }
  contributeRepository(
    role: ConversationRole,
    conversationId: string,
    input: RepositoryContribution,
  ): RepositoryEntry {
    roleValue(role);
    identifier(input.key);
    textValue(input.text);
    if (
      input.sources?.some((source) => typeof source !== "string") ||
      (input.status !== undefined &&
        !["proposed", "accepted", "superseded", "unverified"].includes(input.status))
    )
      throw new Error("Invalid repository contribution");
    return this.db
      .transaction(() => {
        this.require(conversationId);
        const prior = this.repository(role, conversationId).find((e) => e.key === input.key);
        if (input.expectedVersion !== undefined && input.expectedVersion !== (prior?.version ?? 0))
          throw new ConversationConflict("Repository version changed");
        const value: RepositoryEntry = {
          role,
          conversationId,
          key: input.key,
          text: input.text,
          sources: input.sources ?? [],
          status: input.status ?? "proposed",
          version: (prior?.version ?? 0) + 1,
          updatedAt: now(),
        };
        this.db
          .prepare(
            "INSERT INTO repository(conversation_id,role,entry_key,payload) VALUES (?,?,?,?) ON CONFLICT(conversation_id,role,entry_key) DO UPDATE SET payload=excluded.payload",
          )
          .run(conversationId, role, value.key, JSON.stringify(value));
        this.db
          .prepare(
            "INSERT INTO repository_versions(conversation_id,role,entry_key,version,payload) VALUES (?,?,?,?,?)",
          )
          .run(conversationId, role, value.key, value.version, JSON.stringify(value));
        this.recordChange({
          conversationId,
          revision: this.require(conversationId).revision,
          role,
          kind: "repository_updated",
          before: prior ?? null,
          after: value,
          at: value.updatedAt,
          ...(input.sourceCallId === undefined ? {} : { callId: input.sourceCallId }),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        });
        return value;
      })
      .immediate();
  }
  repository(role: ConversationRole, conversationId: string): RepositoryEntry[] {
    roleValue(role);
    return (
      this.db
        .prepare("SELECT payload FROM repository WHERE conversation_id=? AND role=? ORDER BY rowid")
        .all(conversationId, role) as JsonRow[]
    ).map((row) => parse(row) as RepositoryEntry);
  }
  stopConversation(conversationId: string): ConversationState {
    return this.db
      .transaction(() => {
        const old = this.require(conversationId);
        if (old.status === "stopped") return old;
        const state: ConversationState = { ...old, status: "stopped", updatedAt: now() };
        this.save(state);
        this.appendEvent({
          conversationId,
          revision: state.revision,
          kind: "conversation_stopped",
          text: "",
        });
        this.recordChange({
          conversationId,
          revision: state.revision,
          kind: "conversation_stopped",
          before: old,
          after: state,
          at: state.updatedAt,
        });
        return state;
      })
      .immediate();
  }
  resumeConversation(conversationId: string, expectedRevision?: number): ConversationState {
    return this.db
      .transaction(() => {
        const old = this.require(conversationId, expectedRevision);
        if (old.status === "active") return old;
        // A delayed pre-stop result must not become current when the user resumes.
        const bumped = old.status === "stopped";
        const state: ConversationState = {
          ...old,
          revision: old.revision + (bumped ? 1 : 0),
          status: "active",
          updatedAt: now(),
        };
        this.save(state, bumped);
        this.appendEvent({
          conversationId,
          revision: state.revision,
          kind: "conversation_resumed",
          text: "",
        });
        this.recordChange({
          conversationId,
          revision: state.revision,
          kind: "conversation_resumed",
          before: old,
          after: state,
          at: state.updatedAt,
        });
        return state;
      })
      .immediate();
  }
  completeConversation(conversationId: string, expectedRevision: number): ConversationState {
    return this.db
      .transaction(() => {
        const old = this.require(conversationId, expectedRevision);
        if (old.status === "stopped") throw new ConversationConflict("Conversation is stopped");
        if (old.status === "completed") return old;
        const state: ConversationState = { ...old, status: "completed", updatedAt: now() };
        this.save(state);
        this.appendEvent({
          conversationId,
          revision: state.revision,
          kind: "conversation_completed",
          text: "",
        });
        this.recordChange({
          conversationId,
          revision: state.revision,
          kind: "conversation_completed",
          before: old,
          after: state,
          at: state.updatedAt,
        });
        return state;
      })
      .immediate();
  }
  /** Explicit recovery only: opening another store connection never kills active work. */
  recoverInterruptedCalls(
    conversationId: string,
    detail = "Worker ended before recording its result",
  ): ConversationCall[] {
    return this.db
      .transaction(() =>
        this.calls(conversationId)
          .filter((c) => c.status === "running")
          .map(
            (c) =>
              this.finishCall(c.id, {
                status: "interrupted",
                text: "",
                error: detail,
                publish: false,
              }).call,
          ),
      )
      .immediate();
  }
  snapshot(conversationId: string): ConversationSnapshot {
    return this.db.transaction(() => {
      const conversation = this.require(conversationId);
      return {
        conversationId,
        revision: conversation.revision,
        status: conversation.status,
        text: conversation.text,
        conversation,
        messages: this.messages(conversationId),
        messageVersions: this.messageVersions(conversationId),
        calls: this.calls(conversationId),
        events: this.events(conversationId),
        changes: this.changes(conversationId),
        canonicalVersions: CONVERSATION_ROLES.flatMap((role) =>
          this.canonicalHistory(role, conversationId),
        ),
        canonicals: CONVERSATION_ROLES.flatMap((role) => {
          const c = this.canonical(role, conversationId);
          return c ? [c] : [];
        }),
        repository: CONVERSATION_ROLES.flatMap((role) => this.repository(role, conversationId)),
      };
    })();
  }
}
