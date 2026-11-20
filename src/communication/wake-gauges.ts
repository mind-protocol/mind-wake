import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PRINCIPAL_CONVERSATIONS_DIR, PRINCIPAL_CORPUS_MAX_CHARS } from "./markdown-conversation.js";
import { principalConversationFiles } from "./principal-thread-view.js";

/**
 * One French line of gauges at the head of the principal's wake (NLR, 20 nov. 2026):
 * corpus size against its hard limit, age of the last successful automatic push, and
 * time since the last completed holder pass. Each gauge degrades to « illisible » on its
 * own: a gauge never makes a wake fail.
 */
export const CORPUS_WARNING_RATIO = 0.8;
const HOLDER_PASS_FILE = path.join("pattern-holders", "last-pass.json");
const SYNC_STATE_FILE = "workspace-sync-state.json";

export interface WakeGaugeOptions {
  readonly now?: number;
  /** Local commits ahead of the upstream branch; null when unknown. Injected by tests. */
  readonly pendingCommits?: (workspace: string) => number | null;
}

export function frenchNumber(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export function frenchAge(from: string, now: number): string | null {
  const at = Date.parse(from);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 60) return `il y a ${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `il y a ${String(hours)} h`;
  return `il y a ${String(Math.floor(hours / 24))} j`;
}

/** Characters of the files the wake loads (same list as the thread view). */
export function principalCorpusChars(workspace: string): number {
  const directory = path.join(workspace, PRINCIPAL_CONVERSATIONS_DIR);
  if (!fs.existsSync(directory)) return 0;
  return principalConversationFiles(workspace)
    .reduce((sum, file) => sum + fs.readFileSync(path.join(directory, file), "utf8").length, 0);
}

function corpusGauge(workspace: string): string {
  const size = principalCorpusChars(workspace);
  const ratio = size / PRINCIPAL_CORPUS_MAX_CHARS;
  const percent = `${String(Math.round(ratio * 100))} %`;
  const warning = ratio > 1 ? ", dépassé : chargement partiel" : ratio >= CORPUS_WARNING_RATIO ? ", attention" : "";
  return `corpus ${frenchNumber(size)} / ${frenchNumber(PRINCIPAL_CORPUS_MAX_CHARS)} (${percent}${warning})`;
}

/** Cheap local count against the remote-tracking branch, as of the last fetch. */
export function localPendingCommits(workspace: string): number | null {
  try {
    const result = spawnSync("git", ["-C", workspace, "rev-list", "--count", "@{upstream}..HEAD"], {
      encoding: "utf8", timeout: 3_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    });
    const count = Number(result.stdout.trim());
    return result.status === 0 && Number.isSafeInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

interface SyncSnapshot {
  status?: unknown;
  lastSuccessAt?: unknown;
  error?: unknown;
  gitDetail?: unknown;
  pendingCommits?: unknown;
}

function pushGauge(dataDir: string, workspace: string, now: number, pending: (workspace: string) => number | null): string {
  const file = path.join(dataDir, SYNC_STATE_FILE);
  const state: SyncSnapshot = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as SyncSnapshot : {};
  if (state.status === "disabled") return "push automatique désactivé";
  const age = typeof state.lastSuccessAt === "string" ? frenchAge(state.lastSuccessAt, now) : null;
  const parts = [age ? `dernier push réussi ${age}` : "dernier push réussi : inconnu"];
  const live = pending(workspace);
  const count = live ?? (typeof state.pendingCommits === "number" ? state.pendingCommits : null);
  if (count !== null && count > 0) parts.push(`${frenchNumber(count)} commit${count > 1 ? "s" : ""} en attente`);
  if (state.status === "blocked" || state.status === "error") {
    const raw = typeof state.gitDetail === "string" && state.gitDetail ? state.gitDetail
      : typeof state.error === "string" && state.error ? state.error : "sans détail";
    const text = raw.replace(/\s+/g, " ").trim();
    parts.push(`erreur${state.status === "blocked" ? " (bloqué)" : ""} : ${text.length > 160 ? `${text.slice(0, 159)}…` : text}`);
  }
  return parts.join(", ");
}

/** Called by the holder loop after each holder finishes its pass on the files. */
export function recordHolderPass(dataDir: string, slug: string, at = new Date().toISOString()): void {
  const file = path.join(dataDir, HOLDER_PASS_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${String(process.pid)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ completedAt: at, holder: slug }) + "\n");
  fs.renameSync(temp, file);
}

function holderGauge(dataDir: string, now: number): string {
  const file = path.join(dataDir, HOLDER_PASS_FILE);
  if (!fs.existsSync(file)) return "dernier passage des holders : inconnu";
  const { completedAt } = JSON.parse(fs.readFileSync(file, "utf8")) as { completedAt?: unknown };
  const age = typeof completedAt === "string" ? frenchAge(completedAt, now) : null;
  return age ? `dernier passage des holders ${age}` : "dernier passage des holders : inconnu";
}

function safely(label: string, gauge: () => string): string {
  try {
    return gauge();
  } catch {
    return `${label} : illisible`;
  }
}

export function wakeGaugeLine(dataDir: string, workspace: string, options: WakeGaugeOptions = {}): string {
  const now = options.now ?? Date.now();
  const pending = options.pendingCommits ?? localPendingCommits;
  return `Jauges : ${[
    safely("corpus", () => corpusGauge(workspace)),
    safely("push", () => pushGauge(dataDir, workspace, now, pending)),
    safely("holders", () => holderGauge(dataDir, now)),
  ].join(" · ")}.`;
}
