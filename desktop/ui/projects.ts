type Invoke=(command:string,args:Record<string,unknown>)=>Promise<unknown>;
export function initProjects(invoke:Invoke):void{
 const frame=document.getElementById('projects-frame') as HTMLIFrameElement,status=document.getElementById('projects-status')!;
 async function load():Promise<void>{
  status.textContent='Chargement des projets…';
  try{
   const data=await invoke('document_browse',{scope:'agent',relative:'artifacts/projets.html',read:true}) as {text:string};
   const doc=new DOMParser().parseFromString(data.text,'text/html');
   doc.querySelectorAll('script,iframe,object,embed,base,meta,link,form').forEach(el=>el.remove());
   for(const el of doc.querySelectorAll('*'))for(const attr of [...el.attributes])if(/^on/i.test(attr.name)||['src','srcset','srcdoc','action','formaction'].includes(attr.name))el.removeAttribute(attr.name);
   const policy=document.createElement('meta');policy.httpEquiv='Content-Security-Policy';policy.content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'";doc.head.prepend(policy);
   frame.onload=()=>{frame.contentDocument?.addEventListener('click',event=>{
    const link=(event.target as Element|null)?.closest('a');if(!link)return;event.preventDefault();const href=link.getAttribute('href')??'';
    if(href.startsWith('#')){frame.contentDocument?.getElementById(href.slice(1))?.scrollIntoView();return;}
    if(/^[a-z][a-z\d+.-]*:|^[/\\]/i.test(href))return;
    try{const url=new URL(href,'https://projects.invalid/artifacts/projets.html');const relative=decodeURIComponent(url.pathname.slice(1));if(!/\.(md|html?)$/i.test(relative))return;
     document.getElementById('tab-documents')?.click();window.dispatchEvent(new CustomEvent('wake-open-document',{detail:{scope:'agent',relative}}));
    }catch{/* Invalid links remain inert. */}
   });};
   frame.srcdoc='<!doctype html>'+doc.documentElement.outerHTML;status.textContent='État éditorial local · Actualiser après une mise à jour des tâches.';
  }catch(error){status.textContent='Projets indisponibles : '+String(error);}
 }
 document.getElementById('tab-projects')?.addEventListener('click',()=>{void load()});
 document.getElementById('projects-refresh')?.addEventListener('click',()=>{void load()});
 if(!document.getElementById('view-projects')?.hidden)void load();
}
