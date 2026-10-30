/// <reference lib="dom" />
/** Small, inert Markdown renderer: no HTML parsing, images, or executable links. */
export type Block =
  | {kind: "paragraph" | "heading" | "code" | "quote"; text: string}
  | {kind: "list"; ordered: boolean; start: number; items: string[]}
  | {kind: "table"; rows: string[][]};

const listItem = /^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/;
const cells = (line: string): string[] => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map(s => s.trim().replace(/\\\|/g, "|"));
const separator = (line: string): boolean => line.includes("|") && cells(line).every(s => /^:?-{3,}:?$/.test(s));
export function markdownBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n"), blocks: Block[] = [];
  let i = 0;
  const boundary = (n: number): boolean => {
    const line = lines[n] ?? "";
    return !line.trim() || /^\s*```|^#{1,6}\s|^>\s?/.test(line) || listItem.test(line) || (line.includes("|") && separator(lines[n + 1] ?? ""));
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    if (/^\s*```/.test(line)) {
      const content: string[] = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) content.push(lines[i++]!);
      if (i < lines.length) i++;
      blocks.push({kind:"code", text:content.join("\n")}); continue;
    }
    if (/^#{1,6}\s/.test(line)) { blocks.push({kind:"heading", text:line.replace(/^#{1,6}\s+/, "")}); i++; continue; }
    if (line.includes("|") && separator(lines[i + 1] ?? "")) {
      const rows = [cells(line)]; i += 2;
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) rows.push(cells(lines[i++]!));
      blocks.push({kind:"table", rows}); continue;
    }
    const first = listItem.exec(line);
    if (first) {
      const ordered = !!first[2], items: string[] = [];
      while (i < lines.length) {
        const item = listItem.exec(lines[i]!);
        if (!item || !!item[2] !== ordered) break;
        items.push(item[3]!); i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !boundary(i)) items[items.length-1] += "\n" + lines[i++]!.trim();
      }
      blocks.push({kind:"list", ordered, start:Number(first[2] ?? 1), items}); continue;
    }
    if (/^>\s?/.test(line)) {
      const content: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) content.push(lines[i++]!.replace(/^>\s?/, ""));
      blocks.push({kind:"quote", text:content.join("\n")}); continue;
    }
    const content = [line]; i++;
    while (i < lines.length && !boundary(i)) content.push(lines[i++]!);
    blocks.push({kind:"paragraph", text:content.join("\n")});
  }
  return blocks;
}

export function appendInline(parent: HTMLElement, text: string): void {
  const tokens = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
  let end = 0;
  for (const match of text.matchAll(tokens)) {
    parent.append(document.createTextNode(text.slice(end, match.index)));
    const token = match[0], strong = token.startsWith("**"), width = strong ? 2 : 1;
    const el = document.createElement(token.startsWith("`") ? "code" : strong ? "strong" : "em");
    el.textContent = token.slice(width, -width); parent.append(el);
    end = match.index + token.length;
  }
  parent.append(document.createTextNode(text.slice(end)));
}

export function renderMarkdown(text: string): HTMLDivElement {
  const root = document.createElement("div"); root.className = "message-markdown";
  for (const block of markdownBlocks(text)) {
    if (block.kind === "table") {
      const wrapper = document.createElement("div"), table = document.createElement("table");
      wrapper.className = "markdown-table";
      block.rows.forEach((row, index) => {
        const tr = document.createElement("tr");
        for (const cell of row) { const td = document.createElement(index === 0 ? "th" : "td"); appendInline(td, cell); tr.append(td); }
        table.append(tr);
      });
      wrapper.append(table); root.append(wrapper);
    } else if (block.kind === "list") {
      const list = document.createElement(block.ordered ? "ol" : "ul");
      if (block.ordered) list.setAttribute("start", String(block.start));
      for (const text of block.items) { const item = document.createElement("li"); appendInline(item, text); list.append(item); }
      root.append(list);
    } else {
      const el = document.createElement(block.kind === "code" ? "pre" : block.kind === "heading" ? "h3" : block.kind === "quote" ? "blockquote" : "p");
      if (block.kind === "code") el.textContent = block.text; else appendInline(el, block.text);
      root.append(el);
    }
  }
  return root;
}
