import { afterEach, expect, it, vi } from 'vitest';
import { asciiBlock, hasAsciiBlock, isAsciiLine, messageSegments } from './message-ascii.js';

const grid = [
  '┌──────────────────────────────────────────────┐',
  '│ Nicolas Lester Reynolds · Mind Protocol       │',
  '│ [ Modifier le profil ]        [ Plus ]        │',
  '└──────────────────────────────────────────────┘',
].join('\n');

it('detects a desktop_ascii grid between prose and keeps its exact spacing', () => {
  const segments = messageSegments(`Capture de ta fenêtre LinkedIn :\n${grid}\nÇa marche maintenant.`);
  expect(segments.map(s => s.kind)).toEqual(['text', 'ascii', 'text']);
  expect(segments[1]!.text).toBe(grid);
  expect(segments[0]!.text).toBe('Capture de ta fenêtre LinkedIn :');
});

it('always renders fenced blocks as monospace, without the fence lines', () => {
  const segments = messageSegments('Avant\n```text\n  a    b\n  c    d\n```\nAprès');
  expect(segments).toEqual([{kind: 'text', text: 'Avant'}, {kind: 'ascii', text: '  a    b\n  c    d'}, {kind: 'text', text: 'Après'}]);
});

it('leaves ordinary prose, lists and short art alone', () => {
  expect(hasAsciiBlock('Bonjour.\n- un point\n- un autre point\nMerci, à demain.')).toBe(false);
  expect(hasAsciiBlock('┌──┐\n└──┘\nfin')).toBe(false); // two lines only
  expect(isAsciiLine('Une phrase normale, assez longue pour dépasser trente caractères.')).toBe(false);
  expect(isAsciiLine('Nom            Statut          Date')).toBe(true);
});

// Minimal DOM: the block is a real <pre> with text only (no HTML), clicking opens a full-size dialog that any click/Escape closes.
class El {
  children: El[] = []; parent: El | null = null; className = ''; title = ''; tabIndex = -1; open = false; text = '';
  attrs = new Map<string, string>(); listeners = new Map<string, ((e: {key?: string}) => void)[]>();
  constructor(readonly tagName: string) {}
  get textContent(): string { return this.text + this.children.map(c => c.textContent).join(''); }
  set textContent(v: string) { this.text = v; this.children = []; }
  set innerHTML(_v: string) { throw Error('HTML interpolation forbidden'); }
  get isConnected(): boolean { return this === body || Boolean(this.parent?.isConnected); }
  append(...c: El[]): void { for (const x of c) { x.parent = this; this.children.push(x); } }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  addEventListener(n: string, h: (e: {key?: string}) => void): void { this.listeners.set(n, [...(this.listeners.get(n) ?? []), h]); }
  fire(n: string, e: {key?: string} = {}): void { for (const h of this.listeners.get(n) ?? []) h(e); }
  focus(): void { focused = this; }
  showModal(): void { this.open = true; }
  close(): void { if (!this.open) return; this.open = false; this.fire('close'); }
}
let body = new El('body'), focused: El | null = null, selection = '';
afterEach(() => vi.unstubAllGlobals());
function dom(): void {
  body = new El('body'); focused = null; selection = '';
  vi.stubGlobal('document', {body, createElement: (t: string) => new El(t)});
  vi.stubGlobal('getSelection', () => selection);
}

it('inline block opens a full-size, scrollable monospace view; any click or Escape closes it', () => {
  dom();
  const pre = asciiBlock(grid) as unknown as El;
  body.append(pre);
  expect(pre.tagName).toBe('pre'); expect(pre.className).toBe('message-ascii'); expect(pre.textContent).toBe(grid);
  pre.fire('click');
  const dialog = body.children.find(c => c.tagName === 'dialog')!;
  expect(dialog.open).toBe(true); expect(dialog.className).toBe('message-lightbox');
  expect(dialog.children[0]!.className).toBe('message-lightbox-ascii'); expect(dialog.children[0]!.textContent).toBe(grid);
  dialog.fire('click');
  expect(body.children.includes(dialog)).toBe(false); expect(focused).toBe(pre);
  pre.fire('keydown', {key: 'Enter'});
  const again = body.children.find(c => c.tagName === 'dialog')!;
  again.close(); // native Escape
  expect(body.children.includes(again)).toBe(false);
});

it('selecting text inside the capture does not open or close the viewer', () => {
  dom();
  const pre = asciiBlock(grid) as unknown as El;
  body.append(pre);
  selection = 'Reynolds'; pre.fire('click');
  expect(body.children.some(c => c.tagName === 'dialog')).toBe(false);
});
