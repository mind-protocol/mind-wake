import type {ConversationItem} from "./conversation.js";

const time = (value: string | undefined): number | null => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Display order only: a message sits at the later of its creation and its last modification
 * (`orderAt`, computed by the runtime from per-message hashes, see principal-message-edits.ts),
 * so an edited message goes to the bottom in the order of the modifications. Undated corpus
 * passages keep their file position at the top; ties keep the source order.
 */
export function orderByModification(items: readonly ConversationItem[]): ConversationItem[] {
  return items
    .map((item, index) => ({item, index, at: time(item.corpusSource !== undefined ? item.orderAt : item.at) ?? time(item.at)}))
    .sort((a, b) => (a.at ?? -Infinity) - (b.at ?? -Infinity) || a.index - b.index)
    .map(row => row.item);
}
