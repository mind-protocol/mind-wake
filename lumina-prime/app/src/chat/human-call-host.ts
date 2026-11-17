import { createHumanAudio, type HumanWire } from './human-audio.ts';
import { humanRequest, type HumanState } from './human-call-client.ts';
import type { CallSession } from './call-client.ts';
import type { ChatSession } from './client.ts';
import type { CallLine } from './call-engine.web.ts';

export function createHumanHost({session,scope,context,stream,audio,onLine}:{session:ChatSession;scope:CallSession;context:AudioContext;stream:MediaStream;audio:HTMLAudioElement;onLine:(line:CallLine)=>void}) {
  const abort=new AbortController(),states=new Map<string,HumanState>(),offers=new Set<string>();let timer:ReturnType<typeof setTimeout>|undefined;
  let stopped=false,failures=0;
  const seen=new Map<string,Promise<void>>();
  const note=(id:string,text:string,error=false)=>onLine({key:`human-status:${id}`,who:'info',text,detail:'',error});
  const hub=createHumanAudio(context,stream,{agentAudio:audio,onMessage:(peer,message)=>{
    if(message.type!=='utterance'||stopped)return;
    const key=`${peer}:${message.id}`;if(seen.has(key))return;
    const pending=(async()=>{
      try {
        const result=await humanRequest(session,scope,'text',{peerId:peer,message:message.id,text:message.text},abort.signal);
        if(stopped)return;const speaker=result.humans[0]?.label??states.get(peer)?.label;
        const value:CallLine={key:message.id,who:'them',text:message.text,speaker,detail:''};onLine(value);
        broadcast(value);
      }catch(error){if(!stopped){seen.delete(key);note(peer,`Paroles non transmises aux agents : ${String((error as Error).message)}`,true);}}
    })();seen.set(key,pending);
  },onState:(peer,state)=>{
    if(state==='connected')note(peer,`${states.get(peer)?.label??'Participant'} a rejoint l’appel.`);
    if(state==='failed'){hub.remove(peer);void humanRequest(session,scope,'leave',{peerId:peer}).catch(()=>{});note(peer,'La liaison audio avec ce participant a été interrompue.',true);}
  }});
  const labels={ringing:'sonne…',accepted:'connexion audio…',declined:'a refusé',expired:'n’a pas répondu',left:'a quitté l’appel',ended:'a quitté l’appel'};
  async function poll() {
    if(stopped)return;
    try {
      const {humans}=await humanRequest(session,scope,'poll',{},abort.signal);failures=0;
      for(const id of states.keys())if(!humans.some(h=>h.peerId===id)){hub.remove(id);states.delete(id);}
      for(const h of humans) {
        const old=states.get(h.peerId);states.set(h.peerId,h);
        if(old?.status!==h.status)note(h.peerId,`${h.label} ${labels[h.status]}`);
        if(h.status!=='accepted'){if(h.status!=='ringing')hub.remove(h.peerId);continue;}
        if(!offers.has(h.peerId)) {
          offers.add(h.peerId);const description=await hub.offer(h.peerId);if(stopped)return;
          await humanRequest(session,scope,'signal',{peerId:h.peerId,description},abort.signal);
        }
        if(h.answer)await hub.accept(h.peerId,h.answer);
      }
    }catch(error){if(!stopped){note('network',`Liaison avec les humains interrompue : ${String((error as Error).message)}`,true);if(++failures>=3)stop();}}
    if(!stopped)timer=setTimeout(()=>void poll(),1000);
  }
  function broadcast(line:CallLine) {
    if(stopped||!['me','them'].includes(line.who)||line.error)return;
    const value:HumanWire={type:'line',key:line.key,who:line.who as 'me'|'them',text:line.text.slice(0,12_000),speaker:line.speaker,drop:line.drop};hub.broadcast(value);
  }
  function stop(){if(stopped)return;stopped=true;abort.abort();clearTimeout(timer);hub.close();void humanRequest(session,scope,'leave').catch(()=>{});}
  return {broadcast,async start(){try{await humanRequest(session,scope,'invite',{},abort.signal);}finally{if(!stopped)void poll();}},
    stop,
  };
}
