import {renderMarkdown} from './markdown.js';
import {initDirectorNotes} from './series-director-notes.js';
import {initRenderProgress} from './series-render-progress.js';
import {SERIES_STAGES,stageFiles,isSeriesMedia,type SeriesFile,type SeriesStage} from './series-assembly-model.js';
import {latestPublishedVideo,seriesVideoKey,videoUpdateAction,type SeriesPublication} from './series-video-updates.js';
type Invoke=(command:string,args:Record<string,unknown>)=>Promise<unknown>;
type Inventory={state:string;root?:string;project?:{id?:string;title?:string;targetDurationSeconds?:number};files:SeriesFile[];publication?:SeriesPublication|null;readerRequest?:{revision:string;document:string}|null};
/** The player follows completed cutter publications, preserving the current viewing. */
export function initSeriesAssembly(invoke:Invoke):void {
 const target=document.getElementById('view-documents');if(!target||target.dataset['seriesMounted'])return;
 const host:HTMLElement=target;host.dataset['seriesMounted']='true';
 const tabbar=document.createElement('nav');tabbar.className='series-assembly-tabs';tabbar.setAttribute('aria-label','Atelier');
 const docs=document.createElement('button'),assembly=document.createElement('button');docs.type=assembly.type='button';docs.textContent='Documents';assembly.textContent='Séries';tabbar.append(docs,assembly);
 const panel=document.createElement('section');panel.className='series-assembly';panel.hidden=true;
 const viewer=document.createElement('article');viewer.className='series-assembly-viewer';
 const pendingHost=document.createElement('div');pendingHost.className='series-assembly-pending';pendingHost.hidden=true;
 const pendingText=document.createElement('span'),switchNow=document.createElement('button');switchNow.type='button';switchNow.textContent='Voir maintenant';pendingHost.append(pendingText,switchNow);
 const library=document.createElement('details'),summary=document.createElement('summary');summary.textContent='Versions et assemblage';library.append(summary);
 const followLabel=document.createElement('label'),follow=document.createElement('input');follow.type='checkbox';follow.checked=true;followLabel.append(follow,document.createTextNode(' Suivre les nouveaux montages'));
 const refresh=document.createElement('button');refresh.type='button';refresh.textContent='Actualiser';
 const status=document.createElement('p');status.setAttribute('role','status');
 const stages=document.createElement('nav');stages.className='series-assembly-stages';stages.setAttribute('aria-label','Étapes de l’assemblage');
 const filesHost=document.createElement('div');library.append(followLabel,refresh,status,stages,filesHost);
 const renderProgressHost=document.createElement('div');
 panel.append(viewer,renderProgressHost,pendingHost,library);host.prepend(tabbar);host.append(panel);
 const disposeRenderProgress=initRenderProgress(renderProgressHost,invoke,()=>currentKey);
 window.addEventListener('beforeunload',disposeRenderProgress,{once:true});
 let preferred='documents',lastReaderRequest='';try{preferred=localStorage.getItem('mind-wake.series-panel')??'documents';lastReaderRequest=localStorage.getItem('mind-wake.series-reader-request')??'';}catch{}
 let inventory:Inventory={state:'missing',files:[]},selected:SeriesStage='video',visible=false,busy=false,generation=0,userInteracted=false,currentKey='',currentVideo:HTMLVideoElement|null=null,pending:SeriesFile|undefined,pendingKey='',observedCandidate='',stableObservations=0,unloaded=false,disposeNotes:()=>void=()=>{};
 const emit=(event:string,file:SeriesFile,details:Record<string,unknown>={}):void=>{
  void invoke('series_assembly',{operation:'receipt',relative:file.relative,event,details:{version:seriesVideoKey(file),publicationVersion:inventory.publication?.version??null,...details}}).catch(()=>{});
 };
 function pendingNotice(file?:SeriesFile):void {
  pending=file;pendingHost.hidden=!file;pendingText.textContent=file?'Nouvelle version prête. ':'';const label=inventory.project?.title?`Film · ${inventory.project.title}`:'Séries';assembly.textContent=file?`${label} · nouvelle version`:label;
 }
 const release=():void=>{disposeNotes();disposeNotes=()=>{};if(currentVideo){currentVideo.pause();currentVideo.removeAttribute('src');currentVideo.load();currentVideo=null;}};
 function showEmptyFilm():void {
  if(!visible||selected!=='video'||latestPublishedVideo(inventory.files,inventory.publication))return;
  release();currentKey='';pendingNotice();viewer.replaceChildren();
  const screen=document.createElement('div');screen.className='series-film-empty-screen';
  const title=document.createElement('h2');title.textContent=inventory.project?.title??'Montage';
  const state=document.createElement('p');state.textContent='Timeline vide · aucune scène montée';
  const time=document.createElement('p');time.textContent='00:00 · 0 plan · 0 média';screen.append(title,state,time);
  const rail=document.createElement('div');rail.className='series-film-empty-timeline';rail.setAttribute('aria-label','Timeline vide');
  const caption=document.createElement('p');caption.className='series-film-estimate';caption.textContent=inventory.project?.targetDurationSeconds?`Durée visée : ${Math.round(inventory.project.targetDurationSeconds/60)} min. Aucun export vidéo pour le moment.`:'Aucun export vidéo pour le moment.';
  viewer.append(screen,rail,caption);
  const root=inventory.root??'';if(viewer.dataset['emptyFilmRoot']!==root){viewer.dataset['emptyFilmRoot']=root;const file=inventory.files.find(item=>item.relative==='series.json');if(file)emit('mounted',file,{message:'empty-film',panelVisible:host.getBoundingClientRect().width>0&&host.getBoundingClientRect().height>0&&!host.hidden,documentHidden:document.hidden,duration:0,currentTime:0});}
 }
 const show=(value:boolean,reload=true):void=>{
  visible=value;preferred=value?'video':'documents';try{localStorage.setItem('mind-wake.series-panel',preferred);}catch{}host.dataset['seriesAssembly']=String(value);panel.hidden=!value;docs.setAttribute('aria-pressed',String(!value));assembly.setAttribute('aria-pressed',String(value));
  if(value){if(reload)void load(true);}else{generation++;release();viewer.replaceChildren();currentKey='';}
 };
 async function open(file:SeriesFile,automatic=false):Promise<void>{
  const ticket=++generation;release();viewer.replaceChildren();currentKey=seriesVideoKey(file);pendingNotice();pendingKey='';
  const note=document.createElement('p');note.textContent='Chargement…';viewer.append(note);
  try{
   const media=isSeriesMedia(file.relative),data=await invoke('series_assembly',{operation:media?'media':'text',relative:file.relative}) as {path?:string;mime?:string;text?:string;format?:string};
   if(ticket!==generation||!visible)return;note.remove();
   if(media&&data.path&&data.mime){
    const core=(window as unknown as {__TAURI__:{core:{convertFileSrc:(path:string)=>string}}}).__TAURI__.core;
    const mediaUrl=core.convertFileSrc(data.path);
    const element=document.createElement(data.mime.startsWith('video/')?'video':data.mime.startsWith('audio/')?'audio':'img');
    if(element instanceof HTMLMediaElement){element.controls=true;element.preload='metadata';
     if(element instanceof HTMLVideoElement){
      currentVideo=element;element.muted=true;element.autoplay=true;element.playsInline=true;element.setAttribute('aria-label','Montage de la série');
      const version=seriesVideoKey(file),publicationVersion=inventory.publication?.video.replaceAll('\\','/')===file.relative?inventory.publication.version:null;
      const report=(event:string):void=>emit(event,file,{version,publicationVersion,panelVisible:host.getBoundingClientRect().width>0&&host.getBoundingClientRect().height>0&&!host.hidden,documentHidden:document.hidden,duration:Number.isFinite(element.duration)?element.duration:null,width:element.videoWidth,height:element.videoHeight,currentTime:element.currentTime,readyState:element.readyState,errorCode:element.error?.code??null});
      let reportedPlaying=false;element.addEventListener('loadedmetadata',()=>report('loadedmetadata'));
      element.addEventListener('playing',()=>{if(!reportedPlaying){reportedPlaying=true;report('playing');window.dispatchEvent(new Event('wake-interface-ready'));}});
      element.addEventListener('ended',()=>{report('ended');if(pending&&follow.checked&&visible&&selected==='video')void open(pending,true);});
      element.addEventListener('error',()=>report('error'));
      if(automatic)emit('version-switch',file,{version,publicationVersion});
     }
    }else element.setAttribute('alt',file.relative);
    element.addEventListener('error',()=>{note.textContent='Lecture de ce fichier indisponible.';viewer.append(note);});viewer.append(element);element.setAttribute('src',mediaUrl);if(element instanceof HTMLVideoElement){const filmStatus=document.createElement('p'),filmEstimate=document.createElement('p');filmStatus.className='series-film-status';filmEstimate.className='series-film-estimate';viewer.append(filmStatus,filmEstimate);const shownPublication=inventory.publication?.video.replaceAll('\\','/')===file.relative?inventory.publication:null;const updateFilmLabel=():void=>{const count=shownPublication?.plans,total=shownPublication?.totalPlans,duration=Number.isFinite(element.duration)?Math.round(element.duration):shownPublication?.duration;filmStatus.textContent=`Extrait en construction · ${count!==undefined&&total!==undefined?`${count} plan${count>1?'s':''}/${total} · `:''}${duration!==undefined?`${duration} s disponibles`:'chargement de la durée'}`;};element.addEventListener('loadedmetadata',updateFilmLabel);updateFilmLabel();filmEstimate.textContent='Durée de l’épisode complet : à déterminer.';if(shownPublication?.cuts)void invoke('series_assembly',{operation:'text',relative:shownPublication.cuts}).then(value=>{if(ticket!==generation)return;const source=JSON.parse((value as {text:string}).text.replace(/^\uFEFF/,'')) as {scene_title?:string;total_duration_seconds?:number};if(typeof source.total_duration_seconds==='number')filmEstimate.textContent=`Séquence ${source.scene_title??''} : ${source.total_duration_seconds} s estimées. Durée de l’épisode complet : à déterminer.`;}).catch(()=>{});const publication=inventory.publication?.video.replaceAll('\\','/')===file.relative?inventory.publication:{video:file.relative};disposeNotes=initDirectorNotes({host:viewer,video:element,publication,invoke});}
   }else if(data.text!==undefined){if(data.format==='md'||data.format==='markdown')viewer.append(renderMarkdown(data.text));else{const pre=document.createElement('pre');pre.textContent=data.text;viewer.append(pre);}}
  }catch(error){if(ticket===generation){note.textContent='Lecture indisponible : '+String(error);currentKey='';}}
 }
 function applyReaderRequest():boolean {
  const request=inventory.readerRequest;if(!request||request.revision===lastReaderRequest||host.dataset['documentsReady']!=='true'||!inventory.files.some(file=>file.relative===request.document))return false;
  userInteracted=true;lastReaderRequest=request.revision;try{localStorage.setItem('mind-wake.series-reader-request',request.revision);}catch{}show(false);
  document.getElementById('tab-documents')?.click();window.dispatchEvent(new CustomEvent('wake-open-document',{detail:{scope:'agent',relative:(inventory.root??'artifacts/projets/mode-series/serie')+'/'+request.document}}));return true;
 }
 function considerUpdate():void{
  const candidate=latestPublishedVideo(inventory.files,inventory.publication);if(!candidate){showEmptyFilm();return;}
  const key=seriesVideoKey(candidate);if(key===currentKey){pendingNotice();pendingKey='';return;}if(key===observedCandidate)stableObservations++;else{observedCandidate=key;stableObservations=1;}
  // Explicit ready publications were decoded by cutter; fallback files need two stable observations.
  if(!inventory.publication&&stableObservations<2)return;
  const active=!!currentVideo&&!currentVideo.paused&&!currentVideo.ended;
  const pausedMidway=!!currentVideo&&currentVideo.paused&&!currentVideo.ended&&currentVideo.currentTime>0;
  const action=videoUpdateAction(currentKey,candidate,{enabled:follow.checked,visible:visible&&selected==='video',playing:active,pausedMidway});
  if(action==='switch'){void open(candidate,true);}
  else if(action==='queue'){pendingNotice(candidate);if(pendingKey!==key){pendingKey=key;emit('update-ready',candidate,{currentVersion:currentKey,playing:active,pausedMidway});}}
 }
 function render():void{
  stages.replaceChildren();filesHost.replaceChildren();
  for(const stage of SERIES_STAGES){const button=document.createElement('button'),label=document.createElement('strong'),count=document.createElement('small');button.type='button';button.setAttribute('aria-pressed',String(selected===stage.id));label.textContent=stage.label;count.textContent=`${stage.owner} · ${stageFiles(inventory.files,stage.id).length} fichier(s)`;button.append(label,count);button.addEventListener('click',()=>{selected=stage.id;generation++;release();viewer.replaceChildren();currentKey='';render();if(stage.id==='video'){const file=latestPublishedVideo(inventory.files,inventory.publication);if(file)void open(file);}});stages.append(button);}
  const files=stageFiles(inventory.files,selected).sort((a,b)=>(b.modifiedAt??0)-(a.modifiedAt??0));
  if(!files.length){const empty=document.createElement('p');empty.className='series-assembly-empty';empty.textContent=SERIES_STAGES.find(s=>s.id===selected)!.missing;filesHost.append(empty);}
  for(const file of files){const button=document.createElement('button');button.type='button';button.className='series-assembly-file';button.textContent=`${file.relative} · ${(file.bytes/1024).toLocaleString('fr-FR',{maximumFractionDigits:1})} Ko`;button.addEventListener('click',()=>void open(file));filesHost.append(button);}
 }
 async function load(preview=false):Promise<void>{
  if(busy||unloaded)return;busy=true;refresh.disabled=true;
  try{const next=await invoke('series_assembly',{operation:'inventory'}) as Inventory;if(inventory.root&&next.root!==inventory.root){generation++;release();viewer.replaceChildren();currentKey='';pendingNotice();}inventory=next;assembly.textContent=inventory.project?.title?`Film · ${inventory.project.title}`:'Séries';status.textContent=inventory.state==='missing'?'Dossier de série absent.':`${inventory.files.length} fichiers · ${new Date().toLocaleTimeString('fr-FR')}`;render();applyReaderRequest();
   if(preview){selected='video';show(true,false);considerUpdate();}else considerUpdate();
  }catch(error){status.textContent='Inventaire indisponible : '+String(error);}finally{busy=false;refresh.disabled=false;}
 }
 docs.addEventListener('click',()=>{userInteracted=true;show(false);});assembly.addEventListener('click',()=>{userInteracted=true;show(true);});refresh.addEventListener('click',()=>void load());follow.addEventListener('change',()=>considerUpdate());switchNow.addEventListener('click',()=>{if(pending){selected='video';show(true,false);void open(pending,true);}});
 window.addEventListener('wake-open-document',()=>{userInteracted=true;if(visible)show(false);});
 window.addEventListener('wake-documents-ready',()=>applyReaderRequest());
 window.addEventListener('wake-document-loaded',event=>{const data=(event as CustomEvent<{scope:string;relative:string;title:string;characters:number;visible:boolean}>).detail;const prefix=(inventory.root??'artifacts/projets/mode-series/serie')+'/';if(data?.scope==='agent'&&data.relative.startsWith(prefix))void invoke('series_assembly',{operation:'receipt',relative:data.relative.slice(prefix.length),event:'document-loaded',details:{message:data.title,characters:data.characters,panelVisible:data.visible,documentHidden:document.hidden}}).catch(()=>{});});
 // Documents are the default; a chosen video panel is restored explicitly. Production details and previous versions stay collapsed.
 void invoke('series_assembly',{operation:'inventory'}).then(value=>{if(userInteracted||unloaded)return;inventory=value as Inventory;if(applyReaderRequest()||preferred!=='video')return;selected='video';show(true,false);render();const file=latestPublishedVideo(inventory.files,inventory.publication);if(file)void open(file,true);else showEmptyFilm();}).catch(()=>{});
 const timer=setInterval(()=>{if(!document.hidden)void load();},5000);
 window.addEventListener('beforeunload',()=>{unloaded=true;clearInterval(timer);release();});docs.setAttribute('aria-pressed','true');assembly.setAttribute('aria-pressed','false');
}
