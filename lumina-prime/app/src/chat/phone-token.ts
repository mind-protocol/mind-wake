export async function phoneToken(): Promise<string | null> { return null; }

export async function phoneRingtoneKeys(): Promise<string[]> {
  if(typeof window==='undefined'||window.parent===window||window.location.pathname!=='/desktop-call')return [];
  return new Promise(resolve=>{
    const request=String(Date.now())+Math.random();
    const finish=(keys:string[])=>{clearTimeout(timer);window.removeEventListener('message',receive);resolve(keys);};
    const receive=(event:MessageEvent)=>{if(event.source===window.parent&&event.data?.type==='mind.phone.ringtone-capabilities'&&event.data.request===request){
      const keys:unknown=event.data.keys;
      finish(Array.isArray(keys)?keys.filter((k):k is string=>typeof k==='string' && ["marco","vox","equerre","rose_des_vents","medicis"].includes(k)):[]);
    }};
    const timer=setTimeout(()=>finish([]),1200);window.addEventListener('message',receive);
    window.parent.postMessage({type:'mind.phone.ringtone-capabilities',request},'*');
  });
}
