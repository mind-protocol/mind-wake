import { afterEach, expect, it, vi } from 'vitest';
import { initDocuments } from './documents.js';

// Narrow inert DOM surface: exercises actual initDocuments handlers without a browser dependency.
class Element {
  id='';hidden=false;disabled=false;className='';type='';title='';srcdoc='';clientWidth=1000;
  dataset:Record<string,string>={};style={cssText:'',display:''};
  children:Element[]=[];private text='';private chosen:string|undefined;
  onload:(()=>void)|null=null;contentDocument=null;
  contentWindow={scrollY:0,scrollTo:()=>{}};
  readonly attributes:Record<string,string>={};
  readonly listeners=new Map<string,((event:unknown)=>void)[]>();
  get textContent():string{return this.text+this.children.map(child=>child.textContent).join('');}
  set textContent(value:string){this.text=value;this.children=[];}
  get value():string{return this.chosen??this.children[0]?.value??'';}
  set value(value:string){this.chosen=value;}
  get options():Element[]{return this.children;}
  append(...children:Element[]):void{this.children.push(...children);}
  replaceChildren(...children:Element[]):void{this.text='';this.chosen=undefined;this.children=[...children];}
  add(child:Element):void{this.append(child);}
  insertBefore(child:Element):void{this.append(child);}
  setAttribute(name:string,value:string):void{this.attributes[name]=value;}
  querySelector():null{return null;}
  querySelectorAll():Element[]{return [];}
  addEventListener(name:string,callback:(event:unknown)=>void):void{this.listeners.set(name,[...(this.listeners.get(name)??[]),callback]);}
  dispatchEvent(event:{type:string}):boolean{for(const listener of this.listeners.get(event.type)??[])listener(event);return true;}
}
class Option extends Element {constructor(text:string,value:string){super();this.textContent=text;this.value=value;}}
function fixture(savedScope='agent') {
  vi.useFakeTimers();
  const nodes=new Map<string,Element>();
  const node=(id:string):Element=>{let found=nodes.get(id);if(!found){found=new Element();found.id=id;nodes.set(id,found);}return found;};
  node('document-scope').value='agent';
  const window=new Element(),storage=new Map([['mind-wake.reader-scope',savedScope]]);
  vi.stubGlobal('document',{getElementById:node,createElement:()=>new Element()});
  vi.stubGlobal('window',window);vi.stubGlobal('Option',Option);
  vi.stubGlobal('CustomEvent',class {readonly detail:unknown;constructor(readonly type:string,options:{detail:unknown}){this.detail=options.detail;}});
  vi.stubGlobal('localStorage',{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)});
  const parse=vi.fn(()=>{throw Error('A stale local document must not reach the renderer');});
  vi.stubGlobal('DOMParser',class {parseFromString=parse;});
  const requests:{args:Record<string,unknown>;resolve:(value:unknown)=>void;reject:(reason:unknown)=>void}[]=[];
  const invoke=vi.fn((_command:string,args:Record<string,unknown>)=>new Promise((resolve,reject)=>{requests.push({args,resolve,reject});}));
  initDocuments(invoke);
  const select=(value:string):void=>{node('document-scope').value=value;node('document-scope').dispatchEvent({type:'change'});};
  const event=(name:string,detail:unknown):void=>{window.dispatchEvent({type:name,detail} as {type:string});};
  return {node,storage,requests,invoke,select,event,parse};
}
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
const tick=async():Promise<void>=>{await Promise.resolve();await Promise.resolve();};

it('restores Aurore as a selectable pending view with no backend request or local file fallback',()=>{
  const f=fixture('aurore');
  expect(f.node('document-scope').value).toBe('aurore');expect(f.invoke).not.toHaveBeenCalled();
  expect(f.node('document-title').textContent).toBe('Atelier d’Aurore');
  expect(f.node('document-status').textContent).toBe('Pas encore connecté à son dépôt.');
  expect(f.node('document-frame').srcdoc).toBe('');expect(f.node('document-back').disabled).toBe(true);
  expect(f.node('document-next').disabled).toBe(true);expect(f.node('document-sections').disabled).toBe(true);
  expect(f.storage.has('mind-wake.reader-current.aurore')).toBe(false);
});

it('drops late catalogues and document responses after selection, and returns to both local scopes',async()=>{
  const f=fixture();expect(f.requests[0]?.args['scope']).toBe('agent');
  f.event('wake-open-document',{scope:'agent',relative:'private-local.md'});
  expect(f.requests[1]?.args).toMatchObject({scope:'agent',relative:'private-local.md',read:true});
  f.select('aurore');
  f.requests[0]!.resolve({entries:[{name:'Private local',relative:'private-local.md',directory:false}]});
  f.requests[1]!.resolve({text:'<h1>Private local</h1>',format:'html'});await tick();
  expect(f.parse).not.toHaveBeenCalled();expect(f.node('document-frame').srcdoc).toBe('');
  expect(f.node('document-title').textContent).toBe('Atelier d’Aurore');
  expect(f.node('document-files').textContent).not.toContain('private-local');
  expect(f.node('document-back').disabled).toBe(true);expect(f.node('document-forward').disabled).toBe(true);
  expect(f.node('document-next').dataset['relative']).toBe('');
  f.select('project');expect(f.requests.at(-1)?.args['scope']).toBe('project');
  expect(f.node('document-search').disabled).toBe(false);f.requests.at(-1)!.resolve({entries:[]});await tick();
  f.select('agent');expect(f.requests.at(-1)?.args['scope']).toBe('agent');
  expect(f.storage.get('mind-wake.reader-scope')).toBe('agent');
});

it('keeps local context queue navigation out of Aurore and explicitly selects its real scope on open',()=>{
  const f=fixture('aurore');
  f.event('wake-document-queue',{entries:[{scope:'agent',relative:'local.md',name:'local.md'}]});
  const queue=f.node('view-documents').children.find(child=>child.id==='document-context-queue');
  expect(queue?.hidden).toBe(true);expect(f.node('document-next').disabled).toBe(true);
  f.event('wake-open-document',{scope:'agent',relative:'local.md'});
  expect(f.node('document-scope').value).toBe('agent');
  expect(f.requests.map(request=>request.args['scope'])).toEqual(['agent','agent']);
  expect(f.requests[1]?.args).toMatchObject({read:true,relative:'local.md'});
  expect(f.storage.get('mind-wake.reader-scope')).toBe('agent');
  f.select('aurore');
  expect(f.storage.get('mind-wake.reader-scope')).toBe('aurore');expect(f.storage.has('mind-wake.reader-current.aurore')).toBe(false);
});

it('does not replace the pending notice with an error from a departed local scope',async()=>{
  const f=fixture();f.select('aurore');
  f.requests[0]!.reject(Error('old local catalogue'));await tick();
  expect(f.node('document-status').textContent).toBe('Pas encore connecté à son dépôt.');
  expect(f.node('document-refresh').disabled).toBe(true);
  expect(f.node('document-latest').disabled).toBe(true);
});
