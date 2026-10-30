type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
export interface DocumentImage { readonly reference: string | null; readonly label: string }

/** Resolve only document-relative raster paths. The native reader still confines real paths. */
export function documentImageReference(source: string, relative: string): string | null {
  let path: string;
  try { path = decodeURIComponent(source); } catch { return null; }
  const safe = (value: string): boolean => Boolean(value) && value.length <= 4096
    && !/[\u0000-\u001f\u007f:<>"|?*#]/.test(value) && !value.startsWith('/')
    && !value.startsWith('\\') && !value.split(/[\\/]/).some(part => part === '..' || !part);
  if (!safe(path) || !safe(relative) || !/\.(png|jpe?g|gif|webp)$/i.test(path)) return null;
  path = path.replaceAll('\\', '/');
  return [...relative.replaceAll('\\', '/').split('/').slice(0, -1), ...path.split('/')]
    .filter(part => part !== '.').join('/');
}

/** Capture references in memory, then remove every source supplied by the document. */
export function sanitizeDocument(parsed: Document, relative: string): DocumentImage[] {
  parsed.querySelectorAll('script,iframe,object,embed,base,meta,link,form,svg,math').forEach(el => el.remove());
  const images = [...parsed.querySelectorAll<HTMLImageElement>('img')].map(image => ({
    reference: documentImageReference(image.getAttribute('src') ?? '', relative),
    label: image.getAttribute('alt') || 'Image',
  }));
  for (const el of parsed.querySelectorAll('*')) for (const attr of [...el.attributes]) {
    if (/^on/i.test(attr.name) || ['src', 'srcset', 'action', 'formaction', 'srcdoc', 'background', 'poster'].includes(attr.name)) el.removeAttribute(attr.name);
  }
  const policy = parsed.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy';
  policy.content = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; form-action 'none'; base-uri 'none'";
  parsed.head.prepend(policy);
  return images;
}

/** Hydrate the sanitized frame only while its document and navigation generation are current. */
export async function loadDocumentImages(images: readonly DocumentImage[], doc: Document, scope: string, invoke: Invoke, current: () => boolean): Promise<void> {
  const active = (image: HTMLImageElement): boolean => current() && image.ownerDocument === doc && image.isConnected;
  // Sequential reads bound peak native/base64 memory without retaining a second image cache.
  const elements = [...doc.querySelectorAll<HTMLImageElement>('img')];
  for (const [index, entry] of images.entries()) {
    if (!current()) return;
    const image = elements[index];
    if (!image || !active(image)) continue;
    const unavailable = (): void => {
      if (!active(image)) return;
      image.removeAttribute('src'); image.alt = 'Image indisponible · ' + entry.label;
      image.title = image.alt;
      const text = doc.createElement('span'); text.textContent = image.alt;
      image.replaceWith(text);
    };
    if (!entry.reference) { unavailable(); continue; }
    try {
      const raw = await invoke('conversation_image', {reference: entry.reference, scope}) as {dataUrl?: unknown};
      if (!active(image)) continue;
      if (typeof raw?.dataUrl !== 'string' || raw.dataUrl.length > 10_666_720
        || !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(raw.dataUrl)) throw Error('Image indisponible');
      image.addEventListener('error', unavailable, {once: true});
      image.addEventListener('load', () => {
        if (image.naturalWidth > 16384 || image.naturalHeight > 16384 || image.naturalWidth * image.naturalHeight > 32_000_000) unavailable();
      }, {once: true});
      image.src = raw.dataUrl;
    } catch { unavailable(); }
  }
}
