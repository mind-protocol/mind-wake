import {afterEach, expect, it, vi} from 'vitest';
import {bindChatImages, composeWithImages, supportedImageFile} from './chat-images.js';
import {messageImages} from './message-images.js';

class Node {
  value = ''; required = true; hidden = false; textContent = ''; src = ''; alt = ''; type = ''; isConnected = true;
  files: File[] = []; children: Node[] = [];
  handlers = new Map<string, (event: any) => void>();
  classList = {add: vi.fn(), remove: vi.fn()};
  addEventListener(name: string, handler: (event: any) => void): void {this.handlers.set(name, handler);}
  setAttribute(): void {}
  append(...nodes: Node[]): void {this.children.push(...nodes);}
  replaceChildren(...nodes: Node[]): void {this.children = nodes;}
}
afterEach(() => vi.unstubAllGlobals());
function setup(invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> = vi.fn(async () => ({reference:'artifacts/conversation-images/image-1.png',dataUrl:'data:image/png;base64,AAAA'})), saved?: unknown) {
  vi.stubGlobal('document', {createElement: () => new Node()});
  const zone = new Node(), field = new Node(), preview = new Node(), picker = new Node(), status = new Node();
  const store = new Map<string, string>();
  if(saved)store.set('mind-wake.chat-images',JSON.stringify(saved));
  const controller = bindChatImages({zone:zone as unknown as HTMLElement,field:field as unknown as HTMLTextAreaElement,
    preview:preview as unknown as HTMLElement,picker:picker as unknown as HTMLInputElement,status:status as unknown as HTMLElement,
    invoke,storage:{getItem:key=>store.get(key)??null,setItem:(key,value)=>{store.set(key,value);},removeItem:key=>{store.delete(key);}}});
  const drop = (files: File[]) => {const preventDefault = vi.fn(); zone.handlers.get('drop')!({dataTransfer:{types:['Files'],files},preventDefault});return preventDefault;};
  return {zone,field,preview,picker,status,controller,invoke,drop,store};
}

it('imports Explorer-style file drops into the draft without sending or changing its text', async () => {
  const test = setup(); test.field.value = 'Regarde ce monde';
  expect(test.drop([new File([new Uint8Array([1,2,3])],'Mon monde.png',{type:'image/png'})])).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(test.controller.busy()).toBe(false));
  expect(test.invoke).toHaveBeenCalledExactlyOnceWith('conversation_image_import',{name:'Mon monde.png',bytes:[1,2,3]});
  expect(test.field.value).toBe('Regarde ce monde');
  expect(test.preview.hidden).toBe(false);
  expect(test.preview.children[0]!.children[0]!.src).toBe('data:image/png;base64,AAAA');
  expect(messageImages(test.controller.text()).map(image=>image.reference)).toEqual(['artifacts/conversation-images/image-1.png']);
  expect([...test.store.values()][0]).toContain('Mon monde.png');
  test.preview.children[0]!.children[2]!.handlers.get('click')!({});
  expect(test.controller.count()).toBe(0);expect(test.field.required).toBe(true);
  expect(test.field.value).toBe('Regarde ce monde');
});

it('rejects non-raster files before import and leaves a failed image draft unsent', async () => {
  const invoke = vi.fn(async () => {throw Error('Contenu invalide');});
  const test = setup(invoke);
  test.drop([new File(['<svg/>'],'active.svg'),new File(['fake'],'fake.png')]);
  await vi.waitFor(() => expect(test.controller.busy()).toBe(false));
  expect(invoke).toHaveBeenCalledOnce();expect(test.controller.count()).toBe(0);
  expect(test.status.textContent).toContain('active.svg');expect(test.status.textContent).toContain('Contenu invalide');
});

it('ignores text drags and preserves image-only messages with safe Markdown labels', () => {
  const test = setup(), preventDefault = vi.fn();
  test.zone.handlers.get('drop')!({dataTransfer:{types:['text/plain'],files:[]},preventDefault});
  expect(preventDefault).not.toHaveBeenCalled();expect(test.invoke).not.toHaveBeenCalled();
  expect(supportedImageFile('large.png',8_000_001)).toBe(false);
  const text = composeWithImages('',[{name:'Vue (2) ]\n[.png',reference:'artifacts/conversation-images/image-1.png'}]);
  expect(messageImages(text)).toHaveLength(1);
});

it('restores only imported local images after reload, keeping them visible until removed or sent', async () => {
  const test=setup(undefined,[{name:'Vue (2).png',reference:'artifacts/conversation-images/image-1.png'},
    {name:'Remote',reference:'https://example.com/remote.png'}, {name:'Outside',reference:'../private.png'}]);
  await vi.waitFor(()=>expect(test.preview.children[0]!.children[0]!.src).toContain('data:image/png;'));
  expect(test.controller.count()).toBe(1);expect(test.field.required).toBe(false);
  expect(test.preview.children[0]!.children[1]!.textContent).toBe('Vue (2).png');
  expect(test.invoke).toHaveBeenCalledExactlyOnceWith('conversation_image',{reference:'artifacts/conversation-images/image-1.png'});
  test.controller.clear();expect(test.preview.hidden).toBe(true);expect(test.field.required).toBe(true);
});
