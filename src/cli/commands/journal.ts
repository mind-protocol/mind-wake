/**
 * `journal` : derniers événements, ou ceux qui suivent `--after`. Lecture seule ; les
 * événements sont ré-expurgés à l'affichage.
 */

import type { JournalEvent } from "../../contracts/index.js";
import { sanitizeMetadata, sanitizeReason } from "../../journal/index.js";
import { DEFAULT_PROFILE_ID, type CliContext } from "../context.js";
import { EXIT_OK, type CommandResult } from "../output.js";
import type { DataDir } from "../paths.js";
import { NO_PROFILE_HINT, withReadStore } from "./read.js";

export const DEFAULT_JOURNAL_LIMIT = 50;
export const MAX_JOURNAL_LIMIT = 1000;

export interface JournalOptions {
  readonly limit: number;
  readonly afterSequence: number | null;
}

export interface JournalData {
  readonly profileId: string | null;
  readonly hint: string | null;
  readonly afterSequence: number | null;
  readonly limit: number;
  readonly events: readonly JournalEvent[];
  /** `true` si d'autres événements existent hors de la fenêtre affichée. */
  readonly truncated: boolean;
}

function forDisplay(event: JournalEvent): JournalEvent {
  return {
    ...event,
    reason: sanitizeReason(event.reason),
    metadata: sanitizeMetadata(event.metadata),
  };
}

export function journal(
  ctx: CliContext,
  dataDir: DataDir,
  options: JournalOptions,
): CommandResult<JournalData> {
  const data = withReadStore(ctx, dataDir, ({ uow }): JournalData => {
    const profile = uow?.profiles.get(DEFAULT_PROFILE_ID) ?? null;
    if (uow === null || profile === null) {
      return {
        profileId: null,
        hint: NO_PROFILE_HINT,
        afterSequence: options.afterSequence,
        limit: options.limit,
        events: [],
        truncated: false,
      };
    }
    let events: readonly JournalEvent[];
    let truncated: boolean;
    if (options.afterSequence === null) {
      const all = uow.journal.list(profile.id);
      events = all.slice(-options.limit);
      truncated = all.length > events.length;
    } else {
      const page = uow.journal.list(profile.id, {
        afterSequence: options.afterSequence,
        limit: options.limit + 1,
      });
      events = page.slice(0, options.limit);
      truncated = page.length > options.limit;
    }
    return {
      profileId: profile.id,
      hint: null,
      afterSequence: options.afterSequence,
      limit: options.limit,
      events: events.map(forDisplay),
      truncated,
    };
  });
  return { exitCode: EXIT_OK, data, human: formatJournal };
}

function formatJournal(data: JournalData): string {
  if (data.profileId === null) return `Journal : ${data.hint ?? "—"}`;
  if (data.events.length === 0) return "Journal vide.";
  const lines = data.events.map((e) => {
    const scope = [
      e.sessionId && `session=${e.sessionId}`,
      e.experimentId && `expérience=${e.experimentId}`,
    ]
      .filter(Boolean)
      .join(" ");
    const meta = Object.keys(e.metadata).length === 0 ? "" : `  ${JSON.stringify(e.metadata)}`;
    return `#${String(e.sequence)}  ${e.at}  ${e.type}${scope === "" ? "" : `  ${scope}`}  — ${e.reason}${meta}`;
  });
  if (data.truncated) {
    lines.push(
      data.afterSequence === null
        ? `(${String(data.events.length)} derniers événements ; --after N pour paginer)`
        : "(suite disponible : relancer avec --after sur la dernière séquence affichée)",
    );
  }
  return lines.join("\n");
}
