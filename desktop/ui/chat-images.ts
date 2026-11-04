import { tr } from './i18n.js';

export interface DraftImage { name: string; reference: string }
type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const KEY = 'mind-wake.chat-images';
export const MAX_DRAFT_IMAGES = 6;
export const MAX_IMAGE_BYTES = 8_000_000;
export function supportedImageFile(name: string, size: number): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(name) && size > 0 && size <= MAX_IMAGE_BYTES;
}
export function composeWithImages(text: string, images: readonly DraftImage[]): string {
  const links = images.map(image => `![${image.name.replace(/[\[\]\r\n]/g, ' ')}](<${image.reference}>)`);
  return [text.trim(), ...links].filter(Boolean).join('\n\n');
}

/** Imports only dropped files; text, links and HTML drags keep their normal behavior. */
export function bindChatImages(options: {
  zone: HTMLElement; field: HTMLTextAreaElement; preview: HTMLElement; picker: HTMLInputElement;
  status: HTMLElement; invoke: Invoke; storage?: Store;
}): { text(): string; clear(): void; busy(): boolean; count(): number } {
  const {zone, field, preview, picker, status, invoke, storage} = options;
  let images: DraftImage[] = [], importing = false, dragDepth = 0;
  const sources = new Map<string, string>();
  const fingerprints = new Set<string>();
  try {
    const saved: unknown = JSON.parse(storage?.getItem(KEY) ?? 'null');
    if (Array.isArray(saved)) images = saved.filter((x: unknown): x is DraftImage => {
      if (!x || typeof x !== 'object') return false;
      const v = x as Record<string, unknown>;
      return typeof v['name'] === 'string' && typeof v['reference'] === 'string'
        && /^artifacts\/conversation-images\/[a-zA-Z0-9-]+\.(png|jpeg|gif|webp)$/.test(v['reference']);
    }).slice(0, MAX_DRAFT_IMAGES);
  } catch { /* A broken optional local draft must not block conversation. */ }
  const save = (): void => {try {storage?.setItem(KEY, JSON.stringify(images));} catch { /* optional */ }};
  const render = (): void => {
    field.required = images.length === 0;
    preview.replaceChildren(); preview.hidden = images.length === 0;
    for (const image of images) {
      const figure = document.createElement('figure'), img = document.createElement('img');
      const caption = document.createElement('figcaption'), remove = document.createElement('button');
      img.alt = image.name; caption.textContent = image.name;
      remove.type = 'button'; remove.textContent = tr('Retirer'); remove.setAttribute('aria-label', `${tr('Retirer')} ${image.name}`);
      remove.addEventListener('click', () => {images = images.filter(entry => entry !== image); sources.delete(image.reference); fingerprints.clear(); save(); render();});
      figure.append(img, caption, remove); preview.append(figure);
      const source = sources.get(image.reference);
      if (source) img.src = source;
      else void invoke('conversation_image', {reference: image.reference}).then(raw => {
        const value = raw as {dataUrl?: unknown};
        if (typeof value.dataUrl === 'string' && value.dataUrl.startsWith('data:image/')) {
          sources.set(image.reference, value.dataUrl); if (img.isConnected) img.src = value.dataUrl;
        }
      }).catch(() => {caption.textContent = `${image.name} · ${tr('Image indisponible')}`;});
    }
  };
  const importFiles = async (files: File[]): Promise<void> => {
    if (importing) {status.textContent = tr('Import des images en cours…'); return;}
    importing = true;
    const errors: string[] = [];
    for (const file of files) {
      if (images.length >= MAX_DRAFT_IMAGES) {errors.push(tr('Maximum 6 images par message.')); break;}
      if (!supportedImageFile(file.name, file.size)) {errors.push(`${file.name} : ${tr('Choisir une image PNG, JPEG, GIF ou WebP de 8 Mo maximum.')}`); continue;}
      const fingerprint = `${file.name}:${file.size}:${file.lastModified}`;
      if (fingerprints.has(fingerprint)) continue;
      status.textContent = tr('Import des images en cours…');
      try {
        const raw = await invoke('conversation_image_import', {name: file.name, bytes: Array.from(new Uint8Array(await file.arrayBuffer()))});
        const value = raw as {reference?: unknown; dataUrl?: unknown};
        if (typeof value.reference !== 'string' || typeof value.dataUrl !== 'string') throw Error(tr('Image indisponible'));
        images.push({name: file.name, reference: value.reference}); sources.set(value.reference, value.dataUrl);
        fingerprints.add(fingerprint); save(); render();
      } catch (error) {errors.push(`${file.name} : ${error instanceof Error ? error.message : String(error)}`);}
    }
    importing = false;
    status.textContent = errors.length ? errors.join(' ') : tr('Images jointes au brouillon. Cliquer sur Envoyer pour les transmettre.');
  };
  const fileDrag = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  zone.addEventListener('dragenter', event => {if (!fileDrag(event)) return; event.preventDefault(); dragDepth++; zone.classList.add('chat-image-drop');});
  zone.addEventListener('dragover', event => {if (!fileDrag(event)) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';});
  zone.addEventListener('dragleave', event => {if (!fileDrag(event)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) zone.classList.remove('chat-image-drop');});
  zone.addEventListener('drop', event => {
    if (!fileDrag(event)) return;
    event.preventDefault(); dragDepth = 0; zone.classList.remove('chat-image-drop');
    void importFiles(Array.from(event.dataTransfer?.files ?? []));
  });
  picker.addEventListener('change', () => {void importFiles(Array.from(picker.files ?? [])); picker.value = '';});
  render();
  return {
    text: () => composeWithImages(field.value, images),
    busy: () => importing,
    count: () => images.length,
    clear: () => {images = []; fingerprints.clear(); sources.clear(); save(); render();},
  };
}
