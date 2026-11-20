const WINDOW_MS = 5 * 60_000;
export interface EditedWord {text: string; at: number}
export const wordTokens = (text: string): string[] => text.match(/[\p{L}\p{M}\p{N}_]+(?:['’\-][\p{L}\p{M}\p{N}_]+)*|[^\s]/gu) ?? [];

/** Keep the timestamp of unchanged words, including across successive edits. */
export function changedWords(previous: EditedWord[] | undefined, text: string, now: number, fresh = false): EditedWord[] {
  const tokens = wordTokens(text);
  const result = tokens.map(text => ({text, at: previous || fresh ? now : 0}));
  if (!previous) return result;
  let start = 0, oldEnd = previous.length, newEnd = tokens.length;
  while (start < oldEnd && start < newEnd && previous[start]!.text === tokens[start]) {
    result[start]!.at = previous[start]!.at; start++;
  }
  while (oldEnd > start && newEnd > start && previous[oldEnd - 1]!.text === tokens[newEnd - 1]) {
    result[--newEnd]!.at = previous[--oldEnd]!.at;
  }
  const rows = oldEnd - start, cols = newEnd - start;
  // Bound the diff's memory on wholesale rewrites of large files.
  if (rows * cols > 2_000_000) return result;
  const table = Array.from({length: rows + 1}, () => new Uint32Array(cols + 1));
  for (let i = rows - 1; i >= 0; i--) for (let j = cols - 1; j >= 0; j--) {
    table[i]![j] = previous[start+i]!.text === tokens[start+j] ? 1 + table[i+1]![j+1]! : Math.max(table[i+1]![j]!, table[i]![j+1]!);
  }
  let i = 0, j = 0;
  while (i < rows && j < cols) {
    if (previous[start+i]!.text === tokens[start+j]) {result[start+j]!.at = previous[start+i]!.at; i++; j++;}
    else if (table[i+1]![j]! >= table[i]![j+1]!) i++;
    else j++;
  }
  return result;
}
export function recentEditColor(at: number, now: number): string | null {
  const age = now - at;
  if (!at || age < 0 || age >= WINDOW_MS) return null;
  const t = age / WINDOW_MS;
  return `rgb(${Math.round(230+16*t)} ${Math.round(237+6*t)} ${Math.round(244-21*t)})`;
}
export function ageRecentWords(root: HTMLElement, now = Date.now()): void {
  for (const mark of root.querySelectorAll<HTMLElement>("mark.recent-word-edit")) {
    const color = recentEditColor(Number(mark.dataset["editedAt"]), now);
    if (!color) mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
    else mark.style.backgroundColor = color;
  }
}
export function markRecentWords(root: HTMLElement, words: EditedWord[], now: number): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  const content = nodes.map(n => n.data).join("");
  const tokens = [...content.matchAll(/[\p{L}\p{M}\p{N}_]+(?:['’\-][\p{L}\p{M}\p{N}_]+)*|[^\s]/gu)].map((m,i) => ({start:m.index,end:m.index+m[0].length,at:words[i]?.at ?? 0}));
  // Include the whitespace between two recently edited words, even across inline Markdown nodes.
  const ranges = tokens.flatMap((left, i) => {
    const right = tokens[i + 1];
    return right && left.end < right.start && recentEditColor(left.at, now) && recentEditColor(right.at, now)
      ? [left, {start: left.end, end: right.start, at: Math.min(left.at, right.at)}] : [left];
  });
  let offset = 0, cursor = 0;
  for (const node of nodes) {
    const end = offset + node.length, fragment = document.createDocumentFragment(); let consumed = 0;
    while (cursor < ranges.length && ranges[cursor]!.end <= offset) cursor++;
    for (let index = cursor; index < ranges.length && ranges[index]!.start < end; index++) {
      const range = ranges[index]!, color = recentEditColor(range.at, now);
      if (!color) continue;
      const from = Math.max(0, range.start-offset), to = Math.min(node.length, range.end-offset);
      fragment.append(document.createTextNode(node.data.slice(consumed,from)));
      const mark = document.createElement("mark"); mark.className = "recent-word-edit";
      mark.dataset["editedAt"] = String(range.at); mark.style.backgroundColor = color;
      mark.title = `Modifié à ${new Date(range.at).toLocaleTimeString()}`;
      mark.textContent = node.data.slice(from,to); fragment.append(mark); consumed = to;
    }
    if (consumed) {fragment.append(document.createTextNode(node.data.slice(consumed))); node.replaceWith(fragment);}
    offset = end;
  }
}
