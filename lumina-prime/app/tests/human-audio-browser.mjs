import {createHumanAudio} from '/human-audio.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const contexts=[],hubs=[],received=[],states=[];
const pcs=[];const NativePC=globalThis.RTCPeerConnection;
globalThis.RTCPeerConnection=class extends NativePC{constructor(...args){super(...args);pcs.push(this);}};
function source(hz) {
  const context=new AudioContext();contexts.push(context);
  const oscillator=context.createOscillator();oscillator.frequency.value=hz;
  const mic=context.createMediaStreamDestination();oscillator.connect(mic);oscillator.start();
  const mixes=[],original=context.createMediaStreamDestination.bind(context);
  context.createMediaStreamDestination=()=>{const m=original();mixes.push(m);return m;};
  return {context,stream:mic.stream,mixes};
}
function hub(s,label) {
  const h=createHumanAudio(s.context,s.stream,{onMessage:(peer,message)=>received.push({label,peer,message}),onState:(peer,state)=>states.push({label,peer,state})});hubs.push(h);return h;
}
function assert(value,message){if(!value)throw Error(message);}
async function until(f){for(let n=0;n<100;n++){if(f())return;await wait(100);}throw Error('Timed out: '+JSON.stringify(states));}
function meter(context,mix){const a=context.createAnalyser();a.fftSize=8192;a.smoothingTimeConstant=0;context.createMediaStreamSource(mix.stream).connect(a);return hz=>{const bins=new Float32Array(a.frequencyBinCount);a.getFloatFrequencyData(bins);const i=Math.round(hz*a.fftSize/context.sampleRate);return Math.max(...bins.slice(i-2,i+3));};}
try {
  const a=source(440),b=source(880),c=source(1320);
  await Promise.all(contexts.map(c=>c.resume()));
  const A=hub(a,'A'),B=hub(b,'B'),C=hub(c,'C');
  await A.accept('B',await B.answer('A',await A.offer('B')));
  await A.accept('C',await C.answer('A',await A.offer('C')));
  await until(()=>states.filter(s=>s.state==='connected').length===4);
  await until(()=>B.send('A',{type:'utterance',id:'11111111-1111-4111-a111-111111111111',text:'Remote speech'}));
  await until(()=>received.some(r=>r.label==='A'&&r.message.text==='Remote speech'));
  A.broadcast({type:'line',key:'reply',who:'them',text:'Agent reply',speaker:'Agent'});
  await until(()=>received.filter(r=>r.message.key==='reply').length===2);
  const toB=meter(a.context,a.mixes[0]),toC=meter(a.context,a.mixes[1]);
  await until(()=>toB(1320)>-50&&toC(880)>-50);
  const bMeter=meter(b.context,b.mixes[0]),cMeter=meter(c.context,c.mixes[0]);await wait(200);
  const levels={toB:[toB(440),toB(880),toB(1320)],toC:[toC(440),toC(880),toC(1320)],bMic:bMeter(880),cMic:cMeter(1320),stats:await Promise.all(pcs.map(async pc=>[...(await pc.getStats()).values()].filter(v=>['inbound-rtp','outbound-rtp'].includes(v.type)).map(v=>({type:v.type,energy:v.totalAudioEnergy,bytes:v.bytesReceived??v.bytesSent,packets:v.packetsReceived??v.packetsSent}))))};
  assert(levels.toB[0]>-50&&levels.toB[2]>-50&&levels.toB[1]<-55,'B mix includes A+C and excludes B: '+JSON.stringify(levels));
  assert(levels.toC[0]>-50&&levels.toC[1]>-50&&levels.toC[2]<-55,'C mix includes A+B and excludes C: '+JSON.stringify(levels));
  b.stream.getAudioTracks()[0].enabled=false;await wait(1200);
  assert(toC(880)<-55,'Muting B removes B voice from C');
  A.remove('B');B.close();
  assert(A.send('C',{type:'line',key:'still-here',who:'me',text:'Still here'}),'C survives B hangup');
  await until(()=>received.some(r=>r.label==='C'&&r.message.key==='still-here'));
  await fetch('/result',{method:'POST',body:JSON.stringify({ok:true,levels,checks:['real WebRTC connections','bidirectional data channels','three-person mix-minus','individual microphone mute','individual hangup']})});
}catch(error){await fetch('/result',{method:'POST',body:JSON.stringify({ok:false,error:String(error.stack??error)})});}
finally{hubs.forEach(h=>h.close());await Promise.all(contexts.map(c=>c.close()));}
