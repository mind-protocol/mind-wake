/** Image references remain untrusted text. Only raster URLs/paths become previews. */
export interface MessageImage { readonly reference: string; readonly label: string; readonly remote: boolean }
const raster = /\.(?:png|jpe?g|gif|webp)$/i;
const MAX_IMAGES = 6;

export function imageReference(raw: string, explicit = false): MessageImage | null {
  const reference = raw.trim();
  if (!reference || reference.length > 4096 || /[\u0000-\u001f]/.test(reference)) return null;
  if (/^https?:\/\//i.test(reference)) {
    try {
      const url = new URL(reference);
      if (url.username || url.password || /\.(?:svgz?|html?|xml|pdf)$/i.test(url.pathname) || (!explicit && !raster.test(url.pathname))) return null;
      return {reference: url.href, label: reference, remote: true};
    } catch { return null; }
  }
  // No URL schemes, UNC shares, device paths, ADS, parent traversal or active formats.
  const path = reference.replaceAll('\\', '/');
  if (!raster.test(path) || path.startsWith('//') || path.startsWith('/') || /[<>"|?*]/.test(path)
    || path.split('/').some(part => part === '..' || part === '')
    || path.replace(/^[a-z]:/i, '').includes(':')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:\//i.test(path)) return null;
  return {reference, label: reference, remote: false};
}

/** Quoted, code and Markdown paths support spaces; bare relative paths do not. */
export function messageImages(text: string): MessageImage[] {
  const found: {index: number; image: MessageImage}[] = [];
  const spans: {start: number; end: number}[] = [];
  const add = (raw: string, index: number, explicit = false, label?: string): void => {
    const image = imageReference(raw, explicit);
    if (image) found.push({index, image: label ? {...image, label} : image});
  };
  // Fenced snippets are examples/code, not image requests.
  const fenced = [...text.matchAll(/(?:^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[^\n]*(?:\n|$)|$)/g)]
    .map(m => ({start: m.index, end: m.index + m[0].length}));
  for (const match of text.matchAll(/\b[a-z][a-z0-9+.-]*:[^\s<>"'`]+/gi)) {
    if (!/^https?:\/\//i.test(match[0]) && !/^[a-z]:[\\/]/i.test(match[0])) spans.push({start: match.index, end: match.index + match[0].length});
  }
  const blocked = (start: number, end: number): boolean => [...fenced, ...spans].some(s => start < s.end && end > s.start);
  // Balanced destinations also cover ordinary Wikimedia filenames with parentheses.
  for (const match of text.matchAll(/!?\[([^\]\n]*)\]\(\s*/g)) {
    const start = match.index, destination = start + match[0].length;
    let end = destination, close = -1, raw = '';
    if (text[destination] === '<') {
      const angle = text.indexOf('>', destination + 1);
      if (angle < 0) continue;
      raw = text.slice(destination + 1, angle); end = angle + 1;
    } else {
      let depth = 1;
      while (end < text.length && !/\s/.test(text[end]!)) {
        if (text[end] === '(') depth++;
        if (text[end] === ')' && --depth === 0) {close = end; break;}
        end++;
      }
      raw = text.slice(destination, end);
    }
    if (close < 0) {
      const suffix = /^\s*(?:"[^"\n]*"\s*)?\)/.exec(text.slice(end));
      if (!suffix) continue;
      close = end + suffix[0].length - 1;
    }
    if (blocked(start, close + 1)) continue;
    add(raw, start, match[0].startsWith('!'), match[1]); spans.push({start, end: close + 1});
  }
  const patterns: [RegExp, number][] = [
    [/["'`]([^"'`\r\n]+)["'`]/g, 1],
    [/<([^<>\r\n]+)>/g, 1],
    [/\bhttps?:\/\/[^\s<>"'`]+/gi, 0],
    [/\b[a-z]:[\\/][^\r\n<>"'`]*?\.(?:png|jpe?g|gif|webp)(?=$|[\s),;!?\]}]|\.(?=$|[\s),;!?\]}]))/gi, 0],
    [/(?:^|(?<=[\s([:]))(?:\.\/)?[\p{L}\p{N}_.-]+(?:[\\/][\p{L}\p{N}_.-]+)*\.(?:png|jpe?g|gif|webp)(?=$|[\s),;!?\]}]|\.(?=$|[\s),;!?\]}]))/giu, 0],
  ];
  for (let p = 0; p < patterns.length; p++) {
    const [pattern, group] = patterns[p]!;
    for (const match of text.matchAll(pattern)) {
      const start = match.index, end = start + match[0].length;
      if (blocked(start, end)) continue;
      let raw = match[group] ?? '';
      // A valid signed URL is opaque: do not remove token punctuation such as ! or .
      if (p === 2 && (!imageReference(raw) || /[([{]/.test(text[start - 1] ?? ''))) {
        raw = raw.replace(/[,;.!?]+$/, '');
        for (const [opening, closing] of [['(', ')'], ['[', ']'], ['{', '}']]) {
          while (raw.endsWith(closing!) && raw.split(closing!).length > raw.split(opening!).length) raw = raw.slice(0, -1);
        }
      }
      add(raw, start); spans.push({start, end});
    }
  }
  const seen = new Set<string>();
  return found.sort((a, b) => a.index - b.index).flatMap(({image}) => {
    const key = image.remote ? image.reference : image.reference.replaceAll('\\', '/').toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key); return [image];
  }).slice(0, MAX_IMAGES);
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
const localImages = new Map<string, Promise<string>>();
function loadLocal(reference: string, invoke: Invoke): Promise<string> {
  let pending = localImages.get(reference);
  if (!pending) {
    pending = invoke('conversation_image', {reference}).then(raw => {
      const value = raw as {dataUrl?: unknown};
      if (typeof value.dataUrl !== 'string' || !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value.dataUrl)) throw Error('Image indisponible');
      return value.dataUrl;
    });
    localImages.set(reference, pending);
    // Bounded cache; failures may be retried after the next conversation render.
    void pending.catch(() => {localImages.delete(reference);});
    if (localImages.size > 6) localImages.delete(localImages.keys().next().value!);
  }
  return pending;
}

const pendingLocal = new Map<Element, () => void>();
let imageObserver: IntersectionObserver | undefined;
function lazyLocal(image: HTMLImageElement, load: () => void): void {
  queueMicrotask(() => {
    for (const node of pendingLocal.keys()) if (!node.isConnected) {imageObserver?.unobserve(node); pendingLocal.delete(node);}
    if (!image.isConnected) return;
    if (typeof IntersectionObserver === 'undefined') {load(); return;}
    imageObserver ??= new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        const run = pendingLocal.get(entry.target); pendingLocal.delete(entry.target); imageObserver!.unobserve(entry.target); run?.();
      }
    }, {rootMargin: '400px'});
    pendingLocal.set(image, load); imageObserver.observe(image);
  });
}

export function openMessageImage(source: string, label: string, provenance: string, trigger: HTMLElement): void {
  const message = trigger.closest('li'), messageId = message?.getAttribute('data-message-id');
  const containerId = message?.parentElement?.getAttribute('id'), reference = trigger.getAttribute('data-message-image');
  const dialog = document.createElement('dialog');
  dialog.className = 'message-image-dialog';
  dialog.setAttribute('aria-label', 'Image agrandie');
  const panel = document.createElement('div'), close = document.createElement('button'), image = document.createElement('img');
  const caption = document.createElement('p'), origin = document.createElement('small');
  close.type = 'button'; close.textContent = 'Fermer'; close.autofocus = true;
  image.alt = label; image.referrerPolicy = 'no-referrer';
  image.src = source; caption.textContent = label; origin.textContent = provenance;
  close.addEventListener('click', () => dialog.close());
  image.addEventListener('error', () => {image.hidden = true; caption.textContent = 'Image indisponible · ' + label;}, {once: true});
  dialog.addEventListener('click', event => {if (event.target === dialog) dialog.close();});
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (trigger.isConnected) {trigger.focus({preventScroll: true}); return;}
    // A message received during viewing may have replaced the conversation DOM.
    if (!messageId || !reference) return;
    for (const replacement of document.querySelectorAll<HTMLButtonElement>('button[data-message-image]')) {
      const parent = replacement.closest('li');
      if (replacement.getAttribute('data-message-image') === reference && parent?.getAttribute('data-message-id') === messageId
        && parent.parentElement?.getAttribute('id') === containerId) {replacement.focus({preventScroll: true}); break;}
    }
  });
  panel.append(close, image, caption, origin); dialog.append(panel); document.body.append(dialog); dialog.showModal();
}

/** The text body is untouched; previews are separate siblings inside its bubble. */
export function appendMessageImages(body: HTMLElement, text: string, invoke: Invoke): void {
  const references = messageImages(text);
  if (!references.length) return;
  const gallery = document.createElement('div'); gallery.className = 'message-images';
  for (const entry of references) {
    const figure = document.createElement('figure'), button = document.createElement('button'), image = document.createElement('img');
    const caption = document.createElement('figcaption'), status = document.createElement('span');
    button.type = 'button'; button.disabled = true; button.setAttribute('aria-label', 'Agrandir : ' + entry.label);
    button.setAttribute('data-message-image', entry.reference);
    image.alt = entry.label; image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
    caption.textContent = entry.label; status.className = 'message-image-status'; status.textContent = 'Chargement de l’image…';
    const unavailable = (): void => {image.removeAttribute('src'); image.hidden = true; button.disabled = true; status.textContent = 'Image indisponible';};
    image.addEventListener('error', unavailable, {once: true});
    image.addEventListener('load', () => {
      if (image.naturalWidth > 16384 || image.naturalHeight > 16384 || image.naturalWidth * image.naturalHeight > 32_000_000) {unavailable(); return;}
      button.disabled = false; status.textContent = 'Cliquer pour agrandir';
    }, {once: true});
    button.addEventListener('click', () => {
      if (button.disabled) return;
      const provenance = body.closest('li')?.querySelector('small')?.textContent ?? '';
      openMessageImage(image.src, entry.label, provenance, button);
    });
    button.append(image); figure.append(button, caption, status); gallery.append(figure);
    if (entry.remote) image.src = entry.reference;
    else lazyLocal(image, () => {void loadLocal(entry.reference, invoke).then(source => {if (body.isConnected) image.src = source;}).catch(unavailable);});
  }
  body.append(gallery);
}
