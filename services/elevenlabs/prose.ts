/** Select response prose without paraphrasing or speaking code, tables or destinations. */
export function speechProse(text: string): string {
  return text
    .replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, "")
    .replace(/~~~[^\n]*\n[\s\S]*?(?:~~~|$)/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\(<?[^)]*>?\)/g, "$1")
    .replace(/https?:\/\/[^\s<>]+/g, "")
    .replace(/`[^`]*`/g, "")
    .split("\n")
    .filter(
      (line) => !/^\s*(?:\||<|\[[^\]]+\]:)/.test(line) && !line.includes("|"),
    )
    .map((line) =>
      line
        .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/(?<!\w)[*_]([^*_]+)[*_](?!\w)/g, "$1")
        .replace(/<[^>]+>/g, "")
        .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
        .trim(),
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}
