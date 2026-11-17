/** LAN WebRTC mesh through the caller. No external ICE service and no microphone acquisition here. */
export type HumanWire = {type:'utterance';id:string;text:string}|{type:'line';key:string;who:'me'|'them';text:string;speaker?:string;drop?:boolean};
export function parseHumanWire(value: unknown): HumanWire | null {
  if(typeof value!=='string'||value.length>16_000)return null;
  try {
    const v=JSON.parse(value);
    if(v.type==='utterance'&&typeof v.id==='string'&&/^[a-f0-9-]{36}$/.test(v.id)&&typeof v.text==='string'&&v.text.trim()&&v.text.length<=3900)return {type:'utterance',id:v.id,text:v.text};
    if(v.type==='line'&&typeof v.key==='string'&&v.key.length<=200&&['me','them'].includes(v.who)&&typeof v.text==='string'&&v.text.length<=12_000)
      return {type:'line',key:v.key,who:v.who,text:v.text,...(typeof v.speaker==='string'?{speaker:v.speaker.slice(0,160)}:{}),drop:v.drop===true};
  }catch{ /* An invalid data-channel frame is ignored. */ }return null;
}

export async function completeIce(pc: RTCPeerConnection): Promise<RTCSessionDescriptionInit> {
  if(pc.iceGatheringState!=='complete')await new Promise<void>((resolve,reject)=>{
    const finish=()=>{clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',changed);pc.removeEventListener('connectionstatechange',closed);resolve();};
    const changed=()=>{if(pc.iceGatheringState==='complete')finish();};
    const closed=()=>{if(pc.connectionState==='closed'){finish();reject(new Error('Appel terminé.'));}};
    const timer=setTimeout(finish,5000);
    pc.addEventListener('icegatheringstatechange',changed);pc.addEventListener('connectionstatechange',closed);changed();
  });
  if(pc.connectionState==='closed'||!pc.localDescription)throw new Error('Appel terminé.');
  return pc.localDescription.toJSON();
}

export function createHumanAudio(context:AudioContext, microphone:MediaStream, options:{
  agentAudio?:HTMLAudioElement; onMessage:(peer:string,message:HumanWire)=>void; onState:(peer:string,state:RTCPeerConnectionState)=>void;
}) {
  const mic=context.createMediaStreamSource(microphone);
  const agent=options.agentAudio?context.createMediaElementSource(options.agentAudio):null;
  agent?.connect(context.destination);
  type Link={pc:RTCPeerConnection;mix:MediaStreamAudioDestinationNode;source?:MediaStreamAudioSourceNode;playout?:HTMLAudioElement;channel?:RTCDataChannel;closed:boolean;timer?:ReturnType<typeof setTimeout>};
  const links=new Map<string,Link>();let stopped=false;
  function remove(id:string) {
    const link=links.get(id);if(!link)return;links.delete(id);link.closed=true;clearTimeout(link.timer);
    mic.disconnect(link.mix);agent?.disconnect(link.mix);link.source?.disconnect();
    if(link.playout){link.playout.pause();link.playout.srcObject=null;}
    for(const other of links.values())other.source?.disconnect(link.mix);
    link.channel?.close();link.pc.close();link.mix.stream.getTracks().forEach(t=>t.stop());
  }
  function make(id:string,initiator:boolean) {
    if(stopped)throw new Error('Appel terminé.');
    if(links.has(id))throw new Error('Participant déjà connecté.');
    const pc=new RTCPeerConnection({iceServers:[]}),mix=context.createMediaStreamDestination();
    const link:Link={pc,mix,closed:false};links.set(id,link);
    mic.connect(mix);agent?.connect(mix);
    for(const other of links.values())if(other!==link)other.source?.connect(mix);
    for(const track of mix.stream.getTracks())pc.addTrack(track,mix.stream);
    const channel=(dc:RTCDataChannel)=>{
      link.channel=dc;
      dc.onmessage=event=>{if(link.closed)return;const value=parseHumanWire(event.data);if(value)options.onMessage(id,value);};
    };
    if(initiator)channel(pc.createDataChannel('mind-call'));else pc.ondatachannel=event=>channel(event.channel);
    pc.ontrack=event=>{
      if(link.closed||link.source||event.track.kind!=='audio')return;
      const stream=event.streams[0]??new MediaStream([event.track]);
      // Chromium needs an active media sink to pull remote RTC audio into Web Audio.
      // This sink is silent; the audio graph owns playback and the mix-minus buses.
      link.playout=new Audio();link.playout.muted=true;link.playout.srcObject=stream;void link.playout.play().catch(()=>{});
      link.source=context.createMediaStreamSource(stream);link.source.connect(context.destination);
      // Everyone hears this person except the person themself.
      for(const other of links.values())if(other!==link)link.source.connect(other.mix);
    };
    pc.onconnectionstatechange=()=>{
      if(link.closed)return;clearTimeout(link.timer);
      if(pc.connectionState==='disconnected')link.timer=setTimeout(()=>options.onState(id,'failed'),10_000);
      options.onState(id,pc.connectionState);
    };
    return link;
  }
  return {
    async offer(id:string){const link=make(id,true);await link.pc.setLocalDescription(await link.pc.createOffer());return completeIce(link.pc);},
    async answer(id:string,offer:RTCSessionDescriptionInit){const link=make(id,false);await link.pc.setRemoteDescription(offer);await link.pc.setLocalDescription(await link.pc.createAnswer());return completeIce(link.pc);},
    async accept(id:string,answer:RTCSessionDescriptionInit){const link=links.get(id);if(!link||link.closed)throw new Error('Appel terminé.');if(!link.pc.remoteDescription)await link.pc.setRemoteDescription(answer);},
    send(id:string,message:HumanWire){const dc=links.get(id)?.channel;if(dc?.readyState!=='open'||dc.bufferedAmount>128_000)return false;dc.send(JSON.stringify(message));return true;},
    broadcast(message:HumanWire){for(const id of links.keys())this.send(id,message);},
    remove,
    close(){stopped=true;for(const id of [...links.keys()])remove(id);mic.disconnect();},
  };
}
