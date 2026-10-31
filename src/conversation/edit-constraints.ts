/** Model edits are bounded across the whole call, not separately per message. */
export interface ParagraphEdit {
  before: string;
  after: string;
  /** Omitted for conversation edits; files are scoped to .md and .txt only. */
  filePath?: string;
}

export class ParagraphEditLimitError extends Error {
  readonly code = "paragraph_edit_limit";
  constructor() {
    super(
      "An editing call may modify or insert at most one paragraph. Pure deletions are exempt. Submit a new edit against the current version.",
    );
    this.name = "ParagraphEditLimitError";
  }
}

const normalize = (text: string): string => text.replace(/\r\n?/g, "\n");
const paragraphs = (text: string): string[] =>
  text.split(/\n[\t ]*\n(?:[\t ]*\n)*/).filter((p) => p.length > 0);

/** A deletion may remove words, separators or entire paragraphs, with no new text. */
function deletionOnly(before: string, after: string): boolean {
  let cursor = 0;
  for (let index = 0; index < before.length && cursor < after.length; index++) {
    if (before[index] === after[cursor]) cursor++;
  }
  return cursor === after.length;
}

export function assertSingleParagraphEdit(edits: readonly ParagraphEdit[]): void {
  let changed = 0;
  for (const edit of edits) {
    if (edit.filePath !== undefined && !/\.(?:md|txt)$/i.test(edit.filePath)) continue;
    const before = normalize(edit.before),
      after = normalize(edit.after);
    if (before === after || deletionOnly(before, after)) continue;
    const old = paragraphs(before),
      next = paragraphs(after);
    let start = 0;
    while (start < old.length && start < next.length && old[start] === next[start]) start++;
    let oldEnd = old.length,
      newEnd = next.length;
    while (oldEnd > start && newEnd > start && old[oldEnd - 1] === next[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    const count = Math.max(oldEnd - start, newEnd - start);
    changed += count;
    if (changed > 1) throw new ParagraphEditLimitError();
  }
}
