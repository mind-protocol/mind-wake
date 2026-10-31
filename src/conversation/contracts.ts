/** Durable application state, independent of provider session history. */
export const CONVERSATION_ROLES = [
  "pattern",
  "context",
  "lead",
  "work",
  "commentary",
  "expertise",
] as const;
export type ConversationRole = (typeof CONVERSATION_ROLES)[number];
export type Role = ConversationRole;
export interface CallMessage {
  role: "user" | "assistant";
  content: string;
}
export type ConversationStatus = "active" | "completed" | "stopped";
export type CallStatus = "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export interface ConversationState {
  id: string;
  revision: number;
  status: ConversationStatus;
  text: string;
  createdAt: string;
  updatedAt: string;
}
export interface ConversationSegment {
  role: ConversationRole;
  text: string;
}
export interface ConversationMessage {
  id: string;
  conversationId: string;
  revision: number;
  role: "human" | ConversationRole;
  text: string;
  version: number;
  at: string;
  edited: boolean;
  pass?: 1 | 2;
  sourceCallId?: string;
  /** Public attribution; concatenating segment texts reproduces text exactly. */
  segments?: ConversationSegment[];
  draft?: boolean;
}
export interface NewConversationCall {
  id?: string;
  conversationId: string;
  revision: number;
  role: ConversationRole;
  pass: 1 | 2;
  systemPrompt: string;
  messages: readonly CallMessage[];
}
export interface ConversationCall {
  id: string;
  conversationId: string;
  revision: number;
  role: ConversationRole;
  pass: 1 | 2;
  status: CallStatus;
  systemPrompt: string;
  messages: readonly CallMessage[];
  inputHash: string;
  startedAt: string;
  endedAt: string | null;
  text: string;
  published: boolean;
  error?: string;
  usage?: number;
  rawOutput?: string;
}
export interface FinishConversationCall {
  status: Exclude<CallStatus, "running">;
  text: string;
  error?: string;
  usage?: number;
  /** Second passes are normally committed as canonical data, not raw messages. */
  publish?: boolean;
  rawOutput?: string;
}
export interface ConversationEvent {
  sequence: number;
  conversationId: string;
  revision: number;
  kind: string;
  text: string;
  at: string;
  role?: ConversationRole;
  callId?: string;
}
export type NewConversationEvent = Omit<ConversationEvent, "sequence" | "at"> & { at?: string };
export interface ConversationChange {
  sequence: number;
  conversationId: string;
  revision: number;
  kind: string;
  at: string;
  before: unknown;
  after: unknown;
  role?: ConversationRole;
  callId?: string;
  messageId?: string;
  reason?: string;
  operation?: { kind: "replace" | "insert" | "delete"; paragraphIndex: number };
}
export type NewConversationChange = Omit<ConversationChange, "sequence" | "at"> & { at?: string };
export interface CanonicalConversation {
  role: ConversationRole;
  conversationId: string;
  revision: number;
  version: number;
  messages: readonly CallMessage[];
  updatedAt: string;
}
export type RepositoryStatus = "proposed" | "accepted" | "superseded" | "unverified";
export interface RepositoryContribution {
  key: string;
  text: string;
  sources?: readonly string[];
  status?: RepositoryStatus;
  /** Reject an update to a repository entry that changed since it was read. */
  expectedVersion?: number;
  sourceCallId?: string;
  reason?: string;
}
export interface RepositoryEntry {
  role: ConversationRole;
  conversationId: string;
  key: string;
  text: string;
  sources: readonly string[];
  status: RepositoryStatus;
  version: number;
  updatedAt: string;
}
export interface ConversationSnapshot {
  conversationId: string;
  revision: number;
  status: ConversationStatus;
  text: string;
  conversation: ConversationState;
  messages: ConversationMessage[];
  calls: ConversationCall[];
  canonicals: CanonicalConversation[];
  repository: RepositoryEntry[];
  events: ConversationEvent[];
  messageVersions: ConversationMessage[];
  changes: ConversationChange[];
  canonicalVersions: CanonicalConversation[];
}
