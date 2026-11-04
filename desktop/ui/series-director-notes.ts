type RecordValue=Record<string,unknown>;
type Invoke=(command:string,args:Record<string,unknown>)=>Promise<unknown>;
export interface DirectorPlan {id:string;title:string;start:number;end:number;notes:{label:string;text:string}[]}
export interface DirectorNotes {plans:DirectorPlan[];warning:string;source:string}
const record=(v:unknown):RecordValue=>v&&typeof v==='object'&&!Array.isArray(v)?v as RecordValue:{};
const text=(v:unknown):string=>typeof v==='string'?v:'';
const finite=(v:unknown):number|undefined=>typeof v==='number'&&Number.isFinite(v)?v:undefined;
/** Timeline timing is authoritative; notes from a different cut revision never attach. */
export function directorPlans(timelineValue:unknown,cutsValue?:unknown):DirectorNotes {
 const timeline=record(timelineValue),cuts=record(cutsValue),settings=record(timeline['settings']),fpsValue=settings['fps']??timeline['fps'];
 const ratio=record(fpsValue),fps=finite(fpsValue)??((finite(ratio['numerator'])??0)/(finite(ratio['denominator'])??1));
 const source=text(timeline['source_response_id']),response=text(cuts['response_id']);
 const linked=!!source&&source===response;
 const warning=cutsValue!==undefined&&!linked?'Le paquet de cuts ne correspond pas à cette timeline ; seules ses notes embarquées sont affichées.':'';
 const sourceCuts=Array.isArray(cuts['cuts'])?cuts['cuts'].map(record):[];
 const clips=Array.isArray(timeline['clips'])?timeline['clips'].map(record):[];
 const plans:DirectorPlan[]=[];
 for(const clip of clips){
  if(clip['track']!==undefined&&clip['track']!=='image'&&clip['track']!=='video')continue;
  const id=text(clip['id'])||text(clip['cut_id']);if(!id)continue;
  const startFrame=finite(clip['start_frame'])??finite(clip['startFrame']);
  const endFrame=finite(clip['end_frame'])??finite(clip['endFrameExclusive']);
  const start=finite(clip['start_seconds'])??(fps>0&&startFrame!==undefined?startFrame/fps:undefined);
  const end=finite(clip['end_seconds'])??(fps>0&&endFrame!==undefined?endFrame/fps:undefined);
  if(start===undefined||end===undefined||start<0||end<=start)continue;
  const cut=linked?sourceCuts.find(c=>c['cut_id']===id)??{}:{};
  const merged={...cut,...clip},notes:{label:string;text:string}[]=[];
  const add=(label:string,value:unknown):void=>{const body=text(value);if(body)notes.push({label,text:body});};
  add('Intention',merged['editorial_intention']??merged['intention']);
  add('Jeu',merged['visible_action']);add('Cadrage',merged['framing']);add('Mouvement',merged['movement_intent']);
  const dialogue=Array.isArray(merged['dialogue'])?merged['dialogue'].map(record):[];
  for(const line of dialogue){const intention=text(line['intention']);if(intention)add('Direction de voix'+(text(line['speaker'])?' · '+text(line['speaker']):''),intention);}
  add('Raccord d’entrée',merged['continuity_in']);add('Raccord de sortie',merged['continuity_out']);
  plans.push({id,title:text(merged['title'])||id,start,end,notes});
 }
 plans.sort((a,b)=>a.start-b.start||a.id.localeCompare(b.id));
 return {plans,warning,source:source||text(timeline['id'])};
}
/** End-exclusive cuts: the boundary belongs to the following plan. */
export function directorPlanAt(plans:readonly DirectorPlan[],time:number):DirectorPlan|undefined {
 if(!Number.isFinite(time))return undefined;
 return plans.find(p=>time>=p.start&&time<p.end);
}
const stamp=(value:number):string=>`${Math.floor(value/60)}:${String(Math.floor(value%60)).padStart(2,'0')}`;
export interface DirectorNotesOptions {
 host:HTMLElement;video:HTMLVideoElement;invoke:Invoke;
 publication?:{video?:string;timeline?:string;cuts?:string;[key:string]:unknown}|null;
 timelineRelative?:string;cutsRelative?:string;
}
/** Mount below the video; dispose before replacing its media element. No overlay. */
export function initDirectorNotes(options:DirectorNotesOptions):()=>void {
 const {host,video,invoke}=options;
 const section=document.createElement('section');section.className='series-director-notes';section.setAttribute('aria-label','Commentaires de réalisation');
 const heading=document.createElement('h3');heading.textContent='Commentaires de réalisation';
 const status=document.createElement('p'),current=document.createElement('article'),all=document.createElement('details'),summary=document.createElement('summary'),list=document.createElement('ol');
 summary.textContent='Tous les plans';all.append(summary,list);section.append(heading,status,current,all);host.append(section);
 let disposed=false,plans:DirectorPlan[]=[],currentId='';
 const show=(plan:DirectorPlan|undefined):void=>{
  const key=plan?.id??'';if(key===currentId&&current.childNodes.length)return;currentId=key;current.replaceChildren();
  const title=document.createElement('h4');title.textContent=plan?`${plan.id} · ${plan.title} · ${stamp(plan.start)}–${stamp(plan.end)}`:'Aucun plan associé à cet instant.';current.append(title);
  if(!plan)return;
  if(!plan.notes.length){const empty=document.createElement('p');empty.textContent='Aucune note de réalisation fournie pour ce plan.';current.append(empty);return;}
  const dl=document.createElement('dl');for(const note of plan.notes){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=note.label;dd.textContent=note.text;dl.append(dt,dd);}current.append(dl);
 };
 const sync=():void=>{const selected=directorPlanAt(plans,video.ended&&Number.isFinite(video.duration)?Math.max(0,video.duration-0.001):video.currentTime);show(selected);for(const button of list.querySelectorAll('button')){if(button.dataset['plan']===selected?.id)button.setAttribute('aria-current','true');else button.removeAttribute('aria-current');}};
 for(const event of ['timeupdate','seeked','loadedmetadata','ended'])video.addEventListener(event,sync);
 const read=async(relative:string):Promise<unknown>=>{const data=record(await invoke('series_assembly',{operation:'text',relative}));if(typeof data['text']!=='string')throw Error('Texte de timeline indisponible');return JSON.parse(data['text'].replace(/^\uFEFF/,''));};
 const publication=options.publication;
 const timelineRelative=options.timelineRelative??publication?.timeline??(publication?.video?.replace(/[^/\\]+$/,'timeline.json'));
 const cutsRelative=options.cutsRelative??publication?.cuts;
 status.textContent='Lecture des notes du montage…';
 void(async()=>{
  try{
   if(!timelineRelative)throw Error('Aucune timeline reliée à cette vidéo.');
   const timeline=await read(timelineRelative);let cuts:unknown,cutWarning='';
   if(cutsRelative)try{cuts=await read(cutsRelative);}catch{cutWarning='Paquet de cuts indisponible ; seules les notes de la timeline sont affichées.';}
   if(disposed)return;const result=directorPlans(timeline,cuts);plans=result.plans;
   status.textContent=[`${plans.length} plans · ${result.source||'timeline locale'}`,result.warning||cutWarning,!plans.some(p=>p.notes.length)?'Aucune note de réalisation fournie dans ce montage.':''].filter(Boolean).join(' — ');
   for(const plan of plans){const item=document.createElement('li'),button=document.createElement('button');button.type='button';button.dataset['plan']=plan.id;button.textContent=`${stamp(plan.start)} · ${plan.id} · ${plan.title}`;button.addEventListener('click',()=>{video.currentTime=plan.start;sync();});item.append(button);list.append(item);}
   sync();
  }catch(error){if(!disposed){status.textContent='Notes indisponibles : '+(error instanceof Error?error.message:String(error));show(undefined);}}
 })();
 return ()=>{disposed=true;for(const event of ['timeupdate','seeked','loadedmetadata','ended'])video.removeEventListener(event,sync);section.remove();};
}
