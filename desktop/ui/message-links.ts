/// <reference lib="dom" />
export interface MessageLink {readonly start: number; readonly end: number; readonly label: string; readonly href: string}
type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

export function externalUrl(value: string): string | null {
  if (value.length > 8192 || /[\s\u0000-\u001f\u007f\\]/.test(value) || !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.hostname && !url.username && !url.password ? url.href : null;
  } catch {return null;}
}

/** Recognize explicit Markdown and bare web links without interpreting HTML. */
export function messageLinks(text: string): MessageLink[] {
  const result: MessageLink[] = [], reserved: {start: number; end: number}[] = [];
  for (const match of text.matchAll(/(?:^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[^\n]*(?:\n|$)|$)|`[^`\n]*`/g)) reserved.push({start: match.index, end: match.index + match[0].length});
  const blocked = (start: number, end: number): boolean => reserved.some(span => start < span.end && end > span.start);
  for (const match of text.matchAll(/!?\[([^\]\n]*)\]\(\s*/g)) {
    const start = match.index;
    if (blocked(start, start + match[0].length)) continue;
    let cursor = start + match[0].length, destination = '', close = -1;
    if (text[cursor] === '<') {
      const end = text.indexOf('>', cursor + 1); if (end < 0) continue;
      destination = text.slice(cursor + 1, end); cursor = end + 1;
    } else {
      const begin = cursor; let depth = 1;
      while (cursor < text.length && !/\s/.test(text[cursor]!)) {
        if (text[cursor] === '(') depth++;
        if (text[cursor] === ')' && --depth === 0) {close = cursor; break;}
        cursor++;
      }
      destination = text.slice(begin, cursor);
    }
    if (close < 0) {
      const suffix = /^\s*(?:"[^"\n]*"\s*)?\)/.exec(text.slice(cursor));
      if (!suffix) continue; close = cursor + suffix[0].length - 1;
    }
    const end = close + 1, href = externalUrl(destination);
    reserved.push({start, end});
    if (href && !match[0].startsWith('!')) result.push({start, end, label: match[1] || destination, href});
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    let raw = match[0];
    if (blocked(match.index, match.index + raw.length)) continue;
    if (/[\p{L}\p{N}_:@/\\]/u.test(text[match.index - 1] ?? '')) continue;
    raw = raw.replace(/[.,;!?]+$/, '');
    for (const [opening, closing] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (raw.endsWith(closing!) && raw.split(closing!).length > raw.split(opening!).length) raw = raw.slice(0, -1);
    }
    const href = externalUrl(raw);
    if (href) result.push({start: match.index, end: match.index + raw.length, label: raw, href});
  }
  return result.sort((a, b) => a.start - b.start);
}

/** Decorate only message text; file buttons, code, previews and editors stay untouched. */
export function decorateMessageLinks(root: HTMLElement, invoke: Invoke): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.parentElement && !node.parentElement.closest('a,button,code,pre,textarea,input,select,script,style,[contenteditable],[data-file-reference],.message-images')) nodes.push(node as Text);
  }
  for (const textNode of nodes) {
    const text = textNode.textContent ?? '', links = messageLinks(text); if (!links.length) continue;
    const fragment = document.createDocumentFragment(); let end = 0;
    for (const link of links) {
      fragment.append(document.createTextNode(text.slice(end, link.start)));
      const anchor = document.createElement('a'); anchor.href = link.href; anchor.textContent = link.label;
      anchor.title = link.href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
      anchor.addEventListener('click', event => {
        event.preventDefault();
        void invoke('open_external_url', {url: link.href}).catch(() => {
          anchor.title = 'Ouverture impossible : ' + link.href;
          let status = anchor.nextElementSibling;
          if (!status?.classList.contains('message-link-error')) {
            status = document.createElement('span'); status.className = 'message-link-error'; status.setAttribute('role', 'status'); anchor.after(status);
          }
          status.textContent = ' (ouverture impossible)';
        });
      });
      fragment.append(anchor); end = link.end;
    }
    fragment.append(document.createTextNode(text.slice(end))); textNode.replaceWith(fragment);
  }
}
