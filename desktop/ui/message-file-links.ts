/// <reference lib="dom" />
import { findFileMentions, type FileCatalog, type KnownFile } from './file-reference-core.js';

export interface FileMessage { readonly id?:string|undefined; readonly at:string; readonly text:string }
const fileKey=(file:KnownFile):string=>file.scope+':'+file.relative.toLowerCase();

/** Poll snapshots and historical pagination must never replay document openings. */
export class MessageFileQueue {
  private readonly seen=new Set<string>();
  private readonly waiting:FileMessage[]=[];
  private readonly queued=new Set<string>();
  private initialized=false;
  readonly entries:KnownFile[]=[];
  constructor(private readonly startedAt=Date.now()){}
  observe(messages:readonly FileMessage[],historical=false,live=false):FileMessage[]{
    const baseline=historical||(!this.initialized&&!live);
    const fresh:FileMessage[]=[];
    this.initialized=true;
    for(const message of messages){
      if(!message.id||this.seen.has(message.id))continue;
      this.seen.add(message.id);
      if(!baseline&&(live||Date.parse(message.at)>=this.startedAt)){this.waiting.push(message);fresh.push(message);}
    }
    return fresh;
  }
  append(file:KnownFile):void{
    const key=fileKey(file);if(this.queued.has(key))return;
    this.queued.add(key);this.entries.push(file);
  }
  resolve(catalogs:readonly FileCatalog[]):KnownFile[]{
    const opens:KnownFile[]=[];
    for(const message of this.waiting.splice(0)){
      const recognized=findFileMentions(message.text,catalogs).filter(m=>m.files.length===1);
      for(const mention of recognized){const file=mention.files[0];if(file)this.append(file);}
      const first=recognized[0]?.files[0];if(first)opens.push(first);
    }
    return opens;
  }
}

/** Coalesce catalogue reads, including one more pass when messages arrive mid-read. */
export class CatalogRefreshGate {
  private running:Promise<void>|undefined;
  private again=false;
  constructor(private readonly read:()=>Promise<void>,private readonly settled:()=>void){}
  get busy():boolean{return Boolean(this.running);}
  request():Promise<void>{
    if(this.running){this.again=true;return this.running;}
    this.running=Promise.resolve().then(async()=>{do{this.again=false;await this.read();}while(this.again);})
      .finally(()=>{this.running=undefined;this.settled();});
    return this.running;
  }
}

type Invoke=(command:string,args:Record<string,unknown>)=>Promise<unknown>;
export interface MessageFileLinks {
  observe(messages:readonly FileMessage[],historical?:boolean,live?:boolean):void;
}

export function initMessageFileLinks(invoke:Invoke):MessageFileLinks {
  const catalogs=new Map<'agent'|'project',FileCatalog>();
  const complete=new Map<'agent'|'project',boolean>();
  const state=new MessageFileQueue();
  let catalogsReady=false,scheduled=false,deferred:KnownFile|undefined;
  const roots='#chat,#messages,#agent-thread-messages,#wake-history-messages';
  const catalogValues=():FileCatalog[]=>catalogsReady?[...catalogs.values()]:[];
  const refreshReadiness=():void=>{catalogsReady=!refreshGate.busy&&complete.get('agent')===true&&complete.get('project')===true;};
  const dispatchQueue=():void=>{window.dispatchEvent(new CustomEvent('wake-document-queue',{detail:{entries:[...state.entries]}}));};
  const open=(file:KnownFile):void=>{window.dispatchEvent(new CustomEvent('wake-open-document',{detail:{scope:file.scope,relative:file.relative}}));};
  const draftBusy=():boolean=>{
    const panel=document.getElementById('view-documents');if(!panel)return false;
    const focus=document.activeElement;
    return Boolean(focus&&panel.contains(focus)&&focus.matches('textarea,input,select,[contenteditable="true"]'))
      ||[...panel.querySelectorAll<HTMLTextAreaElement>('textarea')].some(input=>Boolean(input.value.trim()));
  };
  const notice=document.createElement('p');notice.id='document-autoopen-status';notice.setAttribute('role','status');notice.hidden=true;
  notice.style.cssText='flex:0 0 auto;margin:0;font-size:11px;color:#6b765b;';
  const noticeText=document.createElement('span'),resume=document.createElement('button');
  resume.type='button';resume.textContent='Ouvrir maintenant';resume.style.cssText='margin-left:8px;padding:4px 8px;font:inherit;';notice.append(noticeText,resume);
  document.getElementById('view-documents')?.insertBefore(notice,document.getElementById('document-status'));
  function flushDeferred(force=false):void{
    if(!deferred||(!force&&draftBusy()))return;
    const file=deferred;deferred=undefined;notice.hidden=true;open(file);
  }
  function autoOpen(file:KnownFile):void{
    if(draftBusy()){
      deferred=file;noticeText.textContent='Fichier proposé : '+file.name+' · ouverture différée pendant la rédaction du fil.';notice.hidden=false;
    }else{deferred=undefined;notice.hidden=true;open(file);}
  }
  resume.addEventListener('click',()=>flushDeferred(true));
  document.addEventListener('focusout',()=>queueMicrotask(()=>flushDeferred()));
  document.addEventListener('input',event=>{if((event.target as Element|null)?.closest('#view-documents'))flushDeferred();});
  function settleNewMessages():void{
    if(!catalogsReady)return;
    const opens=state.resolve(catalogValues());
    if(opens.length){dispatchQueue();for(const file of opens)autoOpen(file);}
  }
  function choose(file:KnownFile):void{state.append(file);dispatchQueue();deferred=undefined;notice.hidden=true;open(file);}
  function link(mention:{text:string;files:KnownFile[]}):HTMLElement{
    const wrapper=document.createElement('span');wrapper.dataset['fileReference']='true';
    const button=document.createElement('button');button.type='button';button.textContent=mention.text;
    button.className='message-file-link';button.style.cssText='font:inherit;line-height:inherit;padding:0 3px;border:0;border-radius:3px;background:#fff0df;color:#99500d;font-weight:700;text-decoration:underline;text-underline-offset:3px;cursor:pointer;';
    button.title=mention.files.length===1?'Ouvrir dans le lecteur : '+mention.files[0]!.relative:'Plusieurs fichiers correspondent ; choisir le bon document';
    const label=document.createElement('span');
    if(mention.files.length>1){label.textContent=' ('+mention.files.length+' fichiers)';label.style.fontSize='.8em';}
    button.addEventListener('click',()=>{
      // Resolve again: a refreshed catalogue may reveal an ambiguity.
      const current=findFileMentions(mention.text,catalogValues()).find(m=>m.start===0&&m.end===mention.text.length);
      if(!current)return;
      if(current.files.length===1){choose(current.files[0]!);return;}
      let select=wrapper.querySelector('select');
      if(!select){select=document.createElement('select');select.setAttribute('aria-label','Choisir le fichier '+mention.text);select.style.cssText='max-width:100%;font:inherit;margin:0 5px;';wrapper.append(select);}
      select.replaceChildren(new Option('Choisir parmi '+current.files.length+' fichiers…',''));
      current.files.forEach((file,index)=>select!.add(new Option((file.scope==='agent'?'Atelier':'Projet Wake')+' / '+file.relative,String(index))));
      select.onchange=()=>{const file=current.files[Number(select!.value)];if(select!.value!==''&&file)choose(file);};
      select.hidden=false;
    });
    wrapper.append(button,label);return wrapper;
  }
  function decorate(root:HTMLElement):void{
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),nodes:Text[]=[];
    let item:Node|null;
    while((item=walker.nextNode())){
      const parent=item.parentElement;if(!parent||parent.closest('a,button,select,option,textarea,input,pre,script,style,[contenteditable="true"],[data-file-reference]'))continue;
      nodes.push(item as Text);
    }
    for(const node of nodes){
      const text=node.textContent??'',mentions=findFileMentions(text,catalogValues());if(!mentions.length)continue;
      const code=node.parentElement?.closest('code');
      if(code&&(mentions.length!==1||mentions[0]?.text.trim()!==text.trim()||code.textContent?.trim()!==text.trim()))continue;
      const fragment=document.createDocumentFragment();let offset=0;
      for(const mention of mentions){fragment.append(document.createTextNode(text.slice(offset,mention.start)),link(mention));offset=mention.end;}
      fragment.append(document.createTextNode(text.slice(offset)));node.replaceWith(fragment);
    }
  }
  const observer=new MutationObserver(records=>{
    if(!records.some(record=>record.target instanceof Element&&record.target.closest(roots)
      ||record.target.parentElement?.closest(roots)
      ||[...record.addedNodes].some(node=>node instanceof Element&&(node.matches(roots)||node.querySelector(roots)))))return;
    scheduleDecoration();
  });
  function scheduleDecoration():void{
    if(scheduled)return;scheduled=true;
    queueMicrotask(()=>{
      scheduled=false;observer.disconnect();
      for(const root of document.querySelectorAll<HTMLElement>(roots))decorate(root);
      observer.observe(document.body,{childList:true,subtree:true,characterData:true});
    });
  }
  window.addEventListener('wake-document-catalog',event=>{
    const data=(event as CustomEvent<{scope:'agent'|'project';entries:{name:string;relative:string}[];truncated?:boolean}>).detail;
    if(!data||!['agent','project'].includes(data.scope)||!Array.isArray(data.entries))return;
    catalogs.set(data.scope,{scope:data.scope,entries:data.entries});complete.set(data.scope,!data.truncated);refreshReadiness();scheduleDecoration();settleNewMessages();
  });
  observer.observe(document.body,{childList:true,subtree:true,characterData:true});
  const refreshGate=new CatalogRefreshGate(async()=>{
    catalogsReady=false;complete.set('agent',false);complete.set('project',false);
    await Promise.allSettled((['agent','project'] as const).map(async scope=>{
      const data=await invoke('document_browse',{scope,relative:'',read:false,recursive:true}) as {entries:{name:string;relative:string}[];truncated?:boolean};
      catalogs.set(scope,{scope,entries:data.entries});complete.set(scope,!data.truncated);
    }));
  },()=>{refreshReadiness();scheduleDecoration();settleNewMessages();});
  const accept=(messages:readonly FileMessage[],historical=false,live=false):void=>{
    const fresh=state.observe(messages,historical,live);
    if(fresh.some(message=>/\.(?:md|markdown|html?|htm)\b/i.test(message.text))){catalogsReady=false;void refreshGate.request();}
    else settleNewMessages();
    scheduleDecoration();
  };
  window.addEventListener('wake-message-files',event=>{const messages=(event as CustomEvent<{messages:FileMessage[]}>).detail?.messages;if(Array.isArray(messages))accept(messages);});
  void refreshGate.request();
  return {observe:accept};
}
