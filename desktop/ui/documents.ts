import { collectionKey, documentLabel, libraryLabel, modificationAge, visibleDocuments, type LibraryEntry } from './document-library.js';
type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
export function initialDocument(entries: readonly LibraryEntry[], saved?: string): string | undefined {
  if (saved) return saved;
  const pages = entries.filter(entry => !entry.directory);
  for (const name of ['index.html', 'objectifs.html', 'README.md', 'index.md', 'objectifs.md']) {
    const entry = pages.find(item => item.name.toLowerCase() === name.toLowerCase());
    if (entry) return entry.relative;
  }
  return pages.find(entry => entry.name.toLowerCase() !== 'agents.md')?.relative;
}
const escape = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// Small, escaped Markdown renderer. Raw HTML is text, never executable markup.
export function markdownHtml(source: string): string {
  const inline = (text: string): string => escape(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, '<a href="$2">$1</a>');
  const lines = source.replaceAll('\r', '').split('\n');
  const result: string[] = [];
  let code: string[] | null = null;
  let list = '';
  const closeList = (): void => { if (list) { result.push(`</${list}>`); list = ''; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*```/.test(line)) {
      closeList();
      if (code) { result.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`); code = null; }
      else code = [];
      continue;
    }
    if (code) { code.push(line); continue; }
    const item = /^\s*(?:([-*+])|\d+\.)\s+(.+)$/.exec(line);
    if (item) {
      const tag = item[1] ? 'ul' : 'ol';
      if (list !== tag) { closeList(); result.push(`<${tag}>`); list = tag; }
      result.push(`<li>${inline(item[2] ?? '')}</li>`); continue;
    }
    closeList();
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = String(heading[1]?.length ?? 1), title = heading[2] ?? '';
      result.push(`<h${level} id="${escape(title.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-'))}">${inline(title)}</h${level}>`);
    } else if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
      const cells = (row: string): string[] => row.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
      result.push(`<table><thead><tr>${cells(line).map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>`);
      i += 2;
      while (i < lines.length && lines[i]?.includes('|')) { result.push(`<tr>${cells(lines[i] ?? '').map(c => `<td>${c}</td>`).join('')}</tr>`); i++; }
      i--; result.push('</tbody></table>');
    } else if (/^>\s?/.test(line)) result.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
    else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) result.push('<hr>');
    else if (line.trim()) result.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (code) result.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
  return result.join('\n');
}

export function initDocuments(invoke: Invoke): void {
  const byId=<T extends HTMLElement>(id:string):T=>document.getElementById(id) as T;
  const host=byId<HTMLElement>('view-documents'),frame=byId<HTMLIFrameElement>('document-frame');
  const scope=byId<HTMLSelectElement>('document-scope'),collection=byId<HTMLSelectElement>('document-collection');
  const search=byId<HTMLInputElement>('document-search'),format=byId<HTMLSelectElement>('document-format');
  const files=byId<HTMLElement>('document-files'),status=byId<HTMLElement>('document-status');
  const location=byId<HTMLElement>('document-location'),title=byId<HTMLElement>('document-title');
  const outline=byId<HTMLSelectElement>('document-sections'),library=byId<HTMLElement>('document-library');
  const explore=byId<HTMLButtonElement>('document-explore');
  const back=byId<HTMLButtonElement>('document-back'),forward=byId<HTMLButtonElement>('document-forward');
  const previous=byId<HTMLButtonElement>('document-previous'),next=byId<HTMLButtonElement>('document-next');
  let entries:LibraryEntry[]=[],current='',documentScope='agent',generation=0,catalogGeneration=0,pendingOpen=false;
  let renderedRelative='',renderedScope='agent';
  let history:string[]=[],position=-1,truncated=false;
  type ContextFile={scope:'agent'|'project';relative:string;name:string};
  let contextQueue:ContextFile[]=[],contextMode=false;
  const queueHost=document.createElement('div');queueHost.id='document-context-queue';queueHost.hidden=true;queueHost.style.cssText='flex:0 0 auto;display:none;gap:10px;align-items:start;font-size:11px;';
  const queueDetails=document.createElement('details'),queueSummary=document.createElement('summary'),queueList=document.createElement('ol'),recent=document.createElement('button');
  queueList.style.cssText='max-height:130px;overflow:auto;margin:7px 0;padding-left:20px;';queueDetails.append(queueSummary,queueList);recent.type='button';recent.textContent='Revenir aux récents';recent.style.cssText='font:inherit;padding:5px 8px;margin-left:auto;';queueHost.append(queueDetails,recent);host.insertBefore(queueHost,host.querySelector('.document-workspace'));
  const requestFile=(file:ContextFile):void=>{window.dispatchEvent(new CustomEvent('wake-open-document',{detail:{scope:file.scope,relative:file.relative}}));};
  function renderQueue():void{
    queueHost.hidden=!contextQueue.length;queueHost.style.display=contextQueue.length?'flex':'none';queueSummary.textContent='Fichiers évoqués · '+contextQueue.length;recent.hidden=!contextMode;queueList.replaceChildren();
    for(const file of contextQueue){const item=document.createElement('li'),button=document.createElement('button');button.type='button';button.textContent=(file.scope==='agent'?'Atelier':'Projet Wake')+' / '+file.relative;button.style.cssText='font:inherit;text-align:left;padding:4px;';button.addEventListener('click',()=>{contextMode=true;renderQueue();requestFile(file);});item.append(button);queueList.append(item);}
  }
  recent.addEventListener('click',()=>{contextMode=false;renderQueue();pagination();});
  let positions:Record<string,number>={};
  try{
    const saved:unknown=JSON.parse(localStorage.getItem('mind-wake.reader-positions')??'{}');
    if(saved&&typeof saved==='object'&&!Array.isArray(saved))positions=Object.fromEntries(Object.entries(saved).filter(([,value])=>typeof value==='number'&&Number.isFinite(value)&&value>=0));
  }catch{/* Storage is optional. */}
  const stateKey=():string=>'mind-wake.reader-current.'+scope.value;
  const feedback=(error:unknown):void=>{status.textContent='Lecture indisponible : '+String(error);};
  const shown=():LibraryEntry[]=>visibleDocuments(entries,collection.value,search.value,format.value);
  const remember=():void=>{
    if(renderedRelative&&frame.contentWindow)positions[renderedScope+':'+renderedRelative]=frame.contentWindow.scrollY;
    try{localStorage.setItem('mind-wake.reader-positions',JSON.stringify(positions));if(current)localStorage.setItem('mind-wake.reader-current.'+documentScope,current);}catch{/* Keep working without storage. */}
  };
  function setLibrary(open:boolean):void{
    library.hidden=!open;host.dataset['library']=open?'open':'closed';explore.setAttribute('aria-expanded',String(open));
  }
  function pagination():void{
    const list=contextMode?contextQueue:shown().map(entry=>({...entry,scope:scope.value}));
    const index=list.findIndex(e=>e.relative===current&&e.scope===scope.value);
    const before=index>0?list[index-1]:undefined,after=index<0?list[0]:list[index+1];
    previous.dataset['scope']=before?.scope??scope.value;next.dataset['scope']=after?.scope??scope.value;
    previous.disabled=!before;next.disabled=!after;
    byId('document-previous-title').textContent=before?documentLabel(before):'Début de la liste';
    byId('document-next-title').textContent=after?documentLabel(after):'Fin de la liste';
    previous.dataset['relative']=before?.relative??'';next.dataset['relative']=after?.relative??'';
    back.disabled=position<=0;forward.disabled=position>=history.length-1;
  }
  function refreshFileAges():void {
    const now=Date.now();
    for(const time of files.querySelectorAll<HTMLTimeElement>('time[data-modified-at]')) {
      const age=modificationAge(Number(time.dataset['modifiedAt']),now);
      time.textContent=age.label;
      time.setAttribute('aria-label','Dernière modification : '+age.label);
      if(age.date){time.dateTime=age.date;time.title='Modifié le '+new Date(age.date).toLocaleString('fr-FR');}
      else {time.removeAttribute('datetime');time.title='Date de modification indisponible';}
    }
  }
  setInterval(refreshFileAges,60_000);
  function renderFiles():void{
    const list=shown();files.replaceChildren();
    byId('document-count').textContent=list.length+' document'+(list.length===1?'':'s')+' · plus récents en premier'+(truncated?' · catalogue partiel':'');
    if(!list.length){const empty=document.createElement('p');empty.className='reader-empty';empty.textContent='Aucun document ne correspond. Essayez un autre projet ou une autre recherche.';files.append(empty);}
    for(const entry of list){
      const button=document.createElement('button');button.type='button';button.className='reader-file';button.title=entry.relative;
      button.setAttribute('aria-current',String(entry.relative===current));
      const name=document.createElement('strong');name.textContent=documentLabel(entry);
      const meta=document.createElement('small');const ext=/\.html?$/i.test(entry.relative)?'HTML':'MD';
      meta.textContent=ext+' · '+entry.relative.split('/').slice(0,-1).join('/');
      const age=document.createElement('time');age.dataset['modifiedAt']=String(entry.modifiedAt??0);age.className='reader-file-age';
      button.append(name,meta,age);button.addEventListener('click',()=>{contextMode=false;renderQueue();void open(entry.relative);if(host.clientWidth<720)setLibrary(false);});files.append(button);
    }
    refreshFileAges();
    pagination();
  }
  function breadcrumbs():void{
    location.replaceChildren();
    const home=document.createElement('button');home.type='button';home.textContent=scope.value==='agent'?'Mon atelier':'Projet Wake';
    home.addEventListener('click',()=>{collection.value='';search.value='';renderFiles();setLibrary(true);});location.append(home);
    if(!current)return;
    const key=collectionKey(current),part=document.createElement('button');part.type='button';part.textContent=libraryLabel(key);
    part.addEventListener('click',()=>{collection.value=key;search.value='';renderFiles();setLibrary(true);});
    const separator=document.createElement('span');separator.textContent='›';location.append(separator,part);
    const leaf=document.createElement('span');leaf.textContent=current.split('/').at(-1)??current;leaf.setAttribute('aria-current','page');
    const separator2=document.createElement('span');separator2.textContent='›';location.append(separator2,leaf);
  }
  async function loadCatalog(restore=false):Promise<void>{
    const ticket=++catalogGeneration,targetScope=scope.value;status.textContent='Ouverture de la bibliothèque…';
    try{
      const data=await invoke('document_browse',{scope:targetScope,relative:'',read:false,recursive:true}) as {entries:LibraryEntry[];truncated?:boolean};
      if(ticket!==catalogGeneration||targetScope!==scope.value)return;
      entries=data.entries;truncated=Boolean(data.truncated);
      window.dispatchEvent(new CustomEvent('wake-document-catalog',{detail:{scope:targetScope,entries,truncated}}));
      const selected=collection.value;collection.replaceChildren(new Option('Tous les projets',''));
      for(const key of [...new Set(entries.map(e=>collectionKey(e.relative)))].sort((a,b)=>libraryLabel(a).localeCompare(libraryLabel(b))))collection.add(new Option(libraryLabel(key),key));
      if([...collection.options].some(o=>o.value===selected))collection.value=selected;
      renderFiles();breadcrumbs();status.textContent=truncated?'Une partie du catalogue est affichée.':'';
      if(restore&&!current&&!pendingOpen){
        let saved='';try{saved=localStorage.getItem(stateKey())??'';}catch{/* No saved document. */}
        const initial=entries.find(e=>e.relative===saved)??entries.find(e=>e.relative==='artifacts/projets.html')??shown()[0];
        if(initial)await open(initial.relative);else setLibrary(true);
      }
    }catch(error){if(ticket===catalogGeneration)feedback(error);}
  }
  async function open(relative:string,record=true,anchor='',historyIndex?:number):Promise<void>{
    remember();const ticket=++generation,targetScope=scope.value;pendingOpen=true;status.textContent='Ouverture du document…';
    try{
      const data=await invoke('document_browse',{scope:targetScope,relative,read:true}) as {text:string;format:string};
      if(ticket!==generation||targetScope!==scope.value)return;
      current=relative;documentScope=targetScope;
      if(record){history=history.slice(0,position+1);if(history.at(-1)!==relative)history.push(relative);position=history.length-1;}
      else if(historyIndex!==undefined)position=historyIndex;
      const key=collectionKey(relative);
      if(collection.value&&collection.value!==key)collection.value='';
      const parsed=new DOMParser().parseFromString(data.format==='markdown'?markdownHtml(data.text):data.text,'text/html');
      parsed.querySelectorAll('script,iframe,object,embed,base,meta,link,form').forEach(el=>el.remove());
      for(const el of parsed.querySelectorAll('*'))for(const attr of [...el.attributes])if(/^on/i.test(attr.name)||['src','srcset','action','formaction','srcdoc'].includes(attr.name))el.removeAttribute(attr.name);
      const policy=document.createElement('meta');policy.httpEquiv='Content-Security-Policy';policy.content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; form-action 'none'; base-uri 'none'";parsed.head.prepend(policy);
      const style=document.createElement('style');style.textContent='html{color-scheme:light;scroll-padding-top:20px}body{font:15px/1.75 system-ui;margin:28px;color:#203f34;overflow-wrap:anywhere}pre{overflow:auto;padding:16px;background:#8882}table{border-collapse:collapse}td,th{border:1px solid #8886;padding:8px}a{color:#238967}img{max-width:100%}';parsed.head.prepend(style);
      title.textContent=parsed.querySelector('h1')?.textContent??documentLabel(entries.find(e=>e.relative===relative)??{name:relative.split('/').at(-1)??relative,relative});
      frame.onload=()=>{
        if(ticket!==generation)return;
        const doc=frame.contentDocument;if(!doc)return;
        renderedRelative=relative;renderedScope=targetScope;
        outline.replaceChildren(new Option('Aller à une section…',''));
        const usedHeadingIds=new Set<string>();
        let n=0;for(const heading of doc.querySelectorAll('h1,h2,h3')){
          if(!heading.id||usedHeadingIds.has(heading.id)){do{n++;}while(doc.getElementById('wake-section-'+n));heading.id='wake-section-'+n;}
          usedHeadingIds.add(heading.id);
          outline.add(new Option((heading.tagName==='H3'?'↳ ':'')+(heading.textContent??'Section'),heading.id));
        }
        outline.disabled=outline.options.length<=1;
        const stored=positions[targetScope+':'+relative];
        if(anchor)doc.getElementById(anchor)?.scrollIntoView();else if(typeof stored==='number'&&Number.isFinite(stored))frame.contentWindow?.scrollTo(0,stored);
        doc.addEventListener('scroll',()=>{positions[targetScope+':'+relative]=doc.defaultView?.scrollY??0;},{passive:true});
        doc.addEventListener('click',event=>{
          const link=(event.target as Element|null)?.closest('a');if(!link)return;event.preventDefault();const href=link.getAttribute('href')??'';
          try{
            if(href.startsWith('#')){doc.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView();return;}
            if(/^[a-z][a-z0-9+.-]*:/i.test(href)||href.startsWith('/')||href.startsWith(String.fromCharCode(92))){status.textContent='Ce lecteur ouvre les documents locaux HTML et Markdown.';return;}
            const url=new URL(href,'https://documents.invalid/'+relative),path=decodeURIComponent(url.pathname.slice(1));
            if(!/\.(md|markdown|html?|htm)$/i.test(path)){status.textContent='Ce lien ne pointe pas vers un document HTML ou Markdown.';return;}
            void open(path,true,decodeURIComponent(url.hash.slice(1)));
          }catch(error){feedback(error);}
        });
      };
      frame.srcdoc='<!doctype html>'+parsed.documentElement.outerHTML;
      breadcrumbs();renderFiles();try{localStorage.setItem(stateKey(),current);}catch{/* Storage is optional. */}
      status.textContent=data.format==='html'?'Page HTML · lecture seule':'';
    }catch(error){if(ticket===generation)feedback(error);}
    finally{if(ticket===generation)pendingOpen=false;}
  }
  explore.addEventListener('click',()=>setLibrary(Boolean(library.hidden)));
  collection.addEventListener('change',()=>{contextMode=false;renderQueue();search.value='';renderFiles();const first=shown()[0];if(first)void open(first.relative);});
  search.addEventListener('input',renderFiles);format.addEventListener('change',renderFiles);
  outline.addEventListener('change',()=>{if(outline.value)frame.contentDocument?.getElementById(outline.value)?.scrollIntoView();});
  back.addEventListener('click',()=>{if(position>0){const index=position-1;void open(history[index]??'',false,'',index);}});
  forward.addEventListener('click',()=>{if(position+1<history.length){const index=position+1;void open(history[index]??'',false,'',index);}});
  const pageClick=(button:HTMLButtonElement):void=>{const relative=button.dataset['relative'];if(!relative)return;if(contextMode)requestFile({scope:button.dataset['scope']==='project'?'project':'agent',relative,name:relative.split('/').at(-1)??relative});else void open(relative);};
  previous.addEventListener('click',()=>pageClick(previous));
  next.addEventListener('click',()=>pageClick(next));
  byId('document-latest').addEventListener('click',()=>{contextMode=false;renderQueue();const first=shown()[0];if(first)void open(first.relative);});
  scope.addEventListener('change',()=>{remember();generation++;catalogGeneration++;pendingOpen=false;current='';renderedRelative='';entries=[];history=[];position=-1;collection.value='';search.value='';frame.srcdoc='';outline.replaceChildren(new Option('Sommaire indisponible',''));outline.disabled=true;void loadCatalog(true);});
  byId('document-refresh').addEventListener('click',()=>{void (async()=>{await loadCatalog();if(current)await open(current,false);})().catch(feedback);});
  byId('tab-documents').addEventListener('click',()=>{if(!entries.length)void loadCatalog(true);else setLibrary(Boolean(library.hidden));});
  window.addEventListener('beforeunload',remember);
  window.addEventListener('wake-open-document',event=>{
    const data=(event as CustomEvent<{scope?:string;relative?:string}>).detail;
    if(!data||!['agent','project'].includes(data.scope??'')||typeof data.relative!=='string')return;
    setLibrary(false);
    if(scope.value!==data.scope){remember();scope.value=data.scope!;current='';renderedRelative='';history=[];position=-1;void loadCatalog();}
    void open(data.relative);
  });
  window.addEventListener('wake-document-queue',event=>{
    const data=(event as CustomEvent<{entries:ContextFile[]}>).detail;if(!Array.isArray(data?.entries))return;
    const seen=new Set<string>();contextQueue=data.entries.filter(file=>{if(!file||!['agent','project'].includes(file.scope)||typeof file.relative!=='string'||typeof file.name!=='string')return false;const key=file.scope+':'+file.relative.toLowerCase();if(seen.has(key))return false;seen.add(key);return true;});
    contextMode=Boolean(contextQueue.length);renderQueue();pagination();
  });
  setLibrary(false);void loadCatalog(true);
}
