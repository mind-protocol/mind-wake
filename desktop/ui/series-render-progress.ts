type Invoke=(command:string,args:Record<string,unknown>)=>Promise<unknown>;
type Progress={stage:string;version?:string;completedPlans?:number;totalPlans?:number;completedChapters?:number;totalChapters?:number;chapter?:string;error?:string;updatedAt?:string};
export function renderProgressScope(version:string|undefined,displayedVideoKey:string,chapters:number|undefined):string{
 const same=!!version&&displayedVideoKey.replaceAll('\\','/').includes('/'+version+'/');
 return same?'Vidéo affichée':`Candidat ${chapters??'…'} chapitres · ${version??'version non renseignée'}`;
}
export function initRenderProgress(host:HTMLElement,invoke:Invoke,displayedVideoKey:()=>string=()=>''):()=>void{
 const box=document.createElement('section'),label=document.createElement('p'),bar=document.createElement('progress');
 box.className='series-render-progress';box.setAttribute('aria-label','Compilation vidéo');bar.max=100;box.append(label,bar);host.append(box);let stopped=false;
 async function load():Promise<void>{
  try{
   const value=await invoke('series_assembly',{operation:'text',relative:'montage/render-progress.json'}) as {text:string};if(stopped)return;
   const data=JSON.parse(value.text.replace(/^\uFEFF/,'')) as Progress;
   const total=data.totalPlans??0,done=data.completedPlans??0,percent=total>0?Math.floor(Math.min(done,total)/total*100):undefined;
   const chapter=data.completedChapters!==undefined?` · ${data.completedChapters}/${data.totalChapters??12} chapitres`:'';
   label.textContent=data.stage==='failed'?`Compilation interrompue : ${data.error??'voir le contrôle'}`:data.stage==='published'?`Compilation publiée · ${done}/${total} plans${chapter}`:data.stage==='ready-for-visual-review'?`Encodage et décodage terminés · contrôle visuel en cours${chapter}`:data.stage==='checking'?`Plans encodés · décodage intégral et contrôles${chapter}`:`Compilation vidéo${data.chapter?' · '+data.chapter:''}${total?` · ${done}/${total} plans`:''}${chapter}`;
   label.textContent=renderProgressScope(data.version,displayedVideoKey(),data.totalChapters)+' — '+label.textContent;
   if(percent!==undefined)bar.value=percent;else bar.removeAttribute('value');box.hidden=false;
  }catch{if(!stopped){label.textContent='État de compilation indisponible.';bar.removeAttribute('value');}}
 }
 void load();const timer=window.setInterval(()=>void load(),2000);return()=>{stopped=true;clearInterval(timer);box.remove();};
}
