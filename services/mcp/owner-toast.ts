/** Optional local toast. Queuing is deliberately distinct from confirmed visibility. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { artifactsDirFor } from '../../src/daemon/paths.js';
export interface OwnerToast { readonly text:string; readonly duration_ms?:number | undefined }
export function queueOwnerToast(dataDir:string,messageId:string,toast:OwnerToast,now=Date.now()):{queued:boolean;displayConfirmed:false;duplicate?:boolean;expires?:number;error?:string}{
  const text=toast.text.trim(),duration=toast.duration_ms??6000;
  if(!/^own_[0-9a-f-]{36}$/.test(messageId)||!text||text.length>240||!Number.isInteger(duration)||duration<3000||duration>30000)return {queued:false,displayConfirmed:false,error:'invalid_toast'};
  const receipts=path.join(dataDir,'owner-toast-receipts'),receipt=path.join(receipts,messageId+'.json');
  try{
    if(fs.existsSync(receipt))return {queued:false,displayConfirmed:false,duplicate:true};
    const target=path.join(artifactsDirFor(dataDir),'.desktop-overlay.json');fs.mkdirSync(path.dirname(target),{recursive:true});
    const request={revision:messageId,text,expires:now+duration};const temp=target+'.'+randomUUID()+'.tmp';
    fs.writeFileSync(temp,JSON.stringify(request),'utf8');fs.renameSync(temp,target);
    fs.mkdirSync(receipts,{recursive:true});fs.writeFileSync(receipt,JSON.stringify({expires:request.expires}),'utf8');
    return {queued:true,displayConfirmed:false,expires:request.expires};
  }catch{return {queued:false,displayConfirmed:false,error:'overlay_queue_failed'};}
}
