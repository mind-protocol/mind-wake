export interface VoiceScreenshots {enabled():boolean;revision():number;set(value:boolean):void;subscribe(listener:()=>void):()=>void}
const KEY='mind-wake.voice.screenshots.v1';
export function voiceScreenshotsPreference(storage?:Pick<Storage,'getItem'|'setItem'>,initialEnabled=true):VoiceScreenshots{
 let enabled=initialEnabled,revision=0;try{const saved=storage?.getItem(KEY);if(saved==='true'||saved==='false')enabled=saved==='true';}catch{}const listeners=new Set<()=>void>();
 return{enabled:()=>enabled,revision:()=>revision,set(value){if(enabled===value)return;enabled=value;revision++;try{storage?.setItem(KEY,String(value));}catch{}for(const listener of listeners)listener();},subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}};
}
/** Release pending screenshot work when its permission revision changes; never restart it. */
export async function screenshotWork<T>(work:Promise<T>,control:VoiceScreenshots,allowed:()=>boolean,fallback:T):Promise<T>{
 if(!allowed()){void work.catch(()=>{});return fallback;}let unsubscribe=()=>{};const disabled=new Promise<T>(resolve=>{unsubscribe=control.subscribe(()=>{if(!allowed())resolve(fallback);});});
 try{return await Promise.race([work,disabled]);}finally{unsubscribe();}
}
export async function voiceScreenshotAttachments(images:string[],options:{control:VoiceScreenshots;allowed:()=>boolean;cancelled:()=>boolean;composed?:boolean;importImage:(raw:string)=>Promise<{reference:string;capturedAt:string}>}):Promise<string>{
 let suffix='';const allowed=()=>options.allowed()&&!options.cancelled();
 for(const[index,raw]of images.entries()){
  if(!allowed())return'';const shot=await screenshotWork(options.importImage(raw),options.control,allowed,null);if(!shot||!allowed())return'';
  const label=options.composed?`Écran · planche ${index+1}`:index===0?'Début de la dictée':index===images.length-1?'Fin de la dictée':'Écran de la dictée';suffix+=`\n\n![${label} · ${shot.capturedAt}](<${shot.reference}>)`;
 }return allowed()?suffix:'';
}
