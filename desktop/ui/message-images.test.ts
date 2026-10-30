import { afterEach, expect, it, vi } from 'vitest';
import { appendMessageImages, imageReference, messageImages } from './message-images.js';

it('recognizes Markdown images/links, signed raster URLs, quoted Windows paths and relative paths in source order', () => {
  const images = messageImages('![Mon image](<C:\\Mes images\\test.PNG>) puis https://cdn.example/a.jpg?sig=abc&v=2 et `artifacts/photo.webp` puis [Vue](https://cdn.example/b.png).');
  expect(images.map(i => i.reference)).toEqual(['C:\\Mes images\\test.PNG', 'https://cdn.example/a.jpg?sig=abc&v=2', 'artifacts/photo.webp', 'https://cdn.example/b.png']);
  expect(images[0]?.label).toBe('Mon image');
  expect(messageImages('C:\\Mes images\\photo.jpg puis autre texte')[0]?.reference).toBe('C:\\Mes images\\photo.jpg');
  expect(messageImages('![Générée](https://cdn.example/render?id=123)')[0]?.remote).toBe(true);
  expect(messageImages('![Parenthèses](https://cdn.example/test_(1).png)')[0]?.reference).toBe('https://cdn.example/test_(1).png');
  expect(messageImages('(https://cdn.example/test.png?sig=(abc)).')[0]?.reference).toBe('https://cdn.example/test.png?sig=(abc)');
  expect(messageImages('C:/images/photo.png.jpg')[0]?.reference).toBe('C:/images/photo.png.jpg');
  expect(messageImages('photo.v2.png')[0]?.reference).toBe('photo.v2.png');
  expect(messageImages('https://example.com/a.png?sig=abc!')[0]?.reference).toBe('https://example.com/a.png?sig=abc!');
  expect(messageImages('https://example.com/a.png?sig=abc.')[0]?.reference).toBe('https://example.com/a.png?sig=abc.');
  expect(messageImages('![vector](https://example.com/a.svg)')).toEqual([]);
});

it('does not interpret code fences, active formats, schemes, network shares or parent traversal as previews', () => {
  expect(messageImages('```text\nartifacts/example.png\n```\nassets/real.jpg').map(i => i.reference)).toEqual(['assets/real.jpg']);
  for (const raw of ['javascript:attack.png', 'data:image/png;base64,AAAA', 'file:///C:/secret.png', '//server/share.png', '\\\\server\\share.png', '../private.png', 'C:\\space\\..\\private.png', 'image.svg', 'https://name:secret@example.com/a.png']) expect(imageReference(raw)).toBeNull();
  expect(messageImages('https://example.com/page.html')).toEqual([]);
  expect(messageImages('javascript:assets/photo.png file:///private/a.png data:image/svg+xml;base64,AAAA')).toEqual([]);
});

it('deduplicates references, caps each message and preserves ordinary text for the caller', () => {
  const text = 'photo.PNG puis PHOTO.png ' + Array.from({length: 12}, (_, i) => `https://example.com/${i}.png`).join(' ');
  expect(messageImages(text)).toHaveLength(6);
  expect(messageImages(text).filter(i => !i.remote)).toHaveLength(1);
});

// Small DOM contract harness: no browser/window is opened or controlled.
type Handler = (event: {target: Node; defaultPrevented?: boolean}) => void;
class Node {
  children: Node[] = []; parentElement: Node | null = null;
  readonly attributes = new Map<string, string>(); readonly listeners = new Map<string, Handler[]>();
  private ownText = ''; className = ''; disabled = false; hidden = false; src = ''; alt = ''; type = ''; autofocus = false; open = false;
  naturalWidth = 400; naturalHeight = 200;
  constructor(readonly tagName: string, readonly owner: FakeDocument) {}
  get textContent(): string {return this.ownText + this.children.map(c => c.textContent).join('');}
  set textContent(value: string) {this.ownText = value; this.children = [];}
  set innerHTML(_value: string) {throw Error('HTML interpolation forbidden');}
  get isConnected(): boolean {return this === this.owner.body || Boolean(this.parentElement?.isConnected);}
  append(...children: Node[]): void {for (const child of children) {child.parentElement = this; this.children.push(child);}}
  remove(): void {if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this); this.parentElement = null;}
  setAttribute(key: string, value: string): void {this.attributes.set(key, value);}
  getAttribute(key: string): string | null {return this.attributes.get(key) ?? null;}
  removeAttribute(key: string): void {this.attributes.delete(key); if (key === 'src') this.src = '';}
  addEventListener(name: string, handler: Handler): void {const handlers = this.listeners.get(name) ?? []; handlers.push(handler); this.listeners.set(name, handlers);}
  fire(name: string, target = this): void {for (const handler of this.listeners.get(name) ?? []) handler({target});}
  querySelector(tag: string): Node | null {for (const child of this.children) {if (child.tagName === tag) return child; const nested = child.querySelector(tag); if (nested) return nested;} return null;}
  closest(tag: string): Node | null {return this.tagName === tag ? this : this.parentElement?.closest(tag) ?? null;}
  focus(): void {this.owner.activeElement = this;}
  showModal(): void {this.open = true; this.querySelector('button')?.focus();}
  close(): void {this.open = false; this.fire('close');}
  cancel(): void {this.fire('cancel'); this.close();} // Native Escape default of <dialog>.
}
class FakeDocument {
  readonly body = new Node('body', this); activeElement: Node | null = null;
  createElement(tag: string): Node {return new Node(tag, this);}
  querySelectorAll(_selector: string): Node[] {
    const result: Node[] = [];
    const visit = (node: Node): void => {if (node.tagName === 'button' && node.attributes.has('data-message-image')) result.push(node); for (const child of node.children) visit(child);};
    visit(this.body); return result;
  }
}
afterEach(() => vi.unstubAllGlobals());

function bubble(): {doc: FakeDocument; body: Node; original: Node} {
  const doc = new FakeDocument(); vi.stubGlobal('document', doc); vi.stubGlobal('IntersectionObserver', undefined);
  const li = doc.createElement('li'), meta = doc.createElement('small'), body = doc.createElement('div'), original = doc.createElement('p');
  meta.textContent = 'Reçu · Auroracle · fil thread-1'; original.textContent = 'Texte original'; body.append(original); li.append(meta, body); doc.body.append(li);
  return {doc, body, original};
}

it('uses the real preview renderer, retains text/provenance, and restores focus after enlarged-view close or Escape', () => {
  const {doc, body, original} = bubble();
  appendMessageImages(body as unknown as HTMLElement, '![<img onerror=attack()>](https://example.com/photo.png)', async () => {throw Error('No native request for remote image');});
  expect(original.textContent).toBe('Texte original');
  const image = body.querySelector('img')!, button = body.querySelector('button')!;
  expect(button.disabled).toBe(true); image.fire('load'); expect(button.disabled).toBe(false);
  button.fire('click');
  let dialog = doc.body.querySelector('dialog')!;
  expect(dialog.open).toBe(true); expect(dialog.textContent).toContain('Reçu · Auroracle · fil thread-1');
  expect(dialog.textContent).toContain('<img onerror=attack()>');
  dialog.querySelector('button')!.fire('click');
  expect(doc.body.querySelector('dialog')).toBeNull(); expect(doc.activeElement).toBe(button);
  button.fire('click'); dialog = doc.body.querySelector('dialog')!; dialog.cancel();
  expect(doc.body.querySelector('dialog')).toBeNull(); expect(doc.activeElement).toBe(button);
});

it('keeps unavailable/oversized images from opening and confines local requests to the native image command', async () => {
  const {doc, body} = bubble();
  const invoke = vi.fn(async () => ({dataUrl: 'data:image/png;base64,AAAA'}));
  appendMessageImages(body as unknown as HTMLElement, 'artifacts/example.png', invoke);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(invoke).toHaveBeenCalledWith('conversation_image', {reference: 'artifacts/example.png'});
  const image = body.querySelector('img')!, button = body.querySelector('button')!;
  expect(image.src).toBe('data:image/png;base64,AAAA');
  image.naturalWidth = 20000; image.fire('load'); button.fire('click');
  expect(body.textContent).toContain('Image indisponible'); expect(button.disabled).toBe(true);
  expect(doc.body.querySelector('dialog')).toBeNull();
});

it('renders an image failure without removing the original body', () => {
  const {body, original} = bubble();
  appendMessageImages(body as unknown as HTMLElement, 'https://example.com/missing.jpg', async () => null);
  body.querySelector('img')!.fire('error');
  expect(original.textContent).toBe('Texte original'); expect(body.textContent).toContain('Image indisponible');
});

it('restores focus to the equivalent preview if a received message replaced the thread DOM', () => {
  const {doc, body} = bubble();
  body.closest('li')!.setAttribute('data-message-id', 'msg-1');
  appendMessageImages(body as unknown as HTMLElement, 'https://example.com/photo.png', async () => null);
  body.querySelector('img')!.fire('load'); body.querySelector('button')!.fire('click');
  const dialog = doc.body.querySelector('dialog')!;
  body.closest('li')!.remove();
  const replacement = doc.createElement('li'), newBody = doc.createElement('div');
  replacement.setAttribute('data-message-id', 'msg-1'); replacement.append(newBody); doc.body.append(replacement);
  appendMessageImages(newBody as unknown as HTMLElement, 'https://example.com/photo.png', async () => null);
  newBody.querySelector('img')!.fire('load'); dialog.cancel();
  expect(doc.activeElement).toBe(newBody.querySelector('button'));
});
