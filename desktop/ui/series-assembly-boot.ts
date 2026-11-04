import {initSeriesAssembly} from './series-assembly.js';
// The assembly player can mount even if another atelier section fails at startup.
const native=(window as unknown as {__TAURI__?:{core:{invoke:(command:string,args:Record<string,unknown>)=>Promise<unknown>}}}).__TAURI__;
if(native){
 const report=(message:string):void=>{void native.core.invoke('series_assembly',{operation:'receipt',relative:'montage/premier-apercu/le-conseil-premier-apercu.mp4',event:'frontend-error',details:{message:message.slice(0,300)}}).catch(()=>{});};
 window.addEventListener('error',event=>{if(event.filename&&new URL(event.filename,location.href).origin===location.origin)report(event.message);});
 try{initSeriesAssembly((command,args)=>native.core.invoke(command,args));}catch(error){report(String(error));}
}
