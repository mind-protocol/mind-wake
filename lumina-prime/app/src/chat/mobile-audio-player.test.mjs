import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createMobilePlayer } from './mobile-audio-player.mjs';
import { createHash } from 'node:crypto';
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const turn=()=>new Promise(resolve=>setTimeout(resolve,10));
async function until(predicate) { for(let i=0;i<100 && !predicate();i++) await turn(); assert.ok(predicate(),'expected player event within one second'); }
function harness({blocked=false,recovered=false}={}) {
 const bytes=Buffer.from('ID3fixture'), calls=[], states=[];
 let plays=0,activation='one';
 const clip={deliveryId:'fixture',state:recovered?'started':'offered',size:bytes.length,sha256:sha256(bytes),mime:'audio/mpeg'};
 const audio={pause(){},removeAttribute(){},load(){},async play(){plays++;if(blocked)throw Error('blocked');this.onplaying?.();}};
 const request=async(suffix,opts)=>{calls.push([suffix,opts]);if(suffix==='/activate')return{activationId:activation};if(suffix==='/status')return{activationId:activation};if(suffix==='/next')return{clip};if(suffix.startsWith('/clip/'))return new Response(bytes);return{};};
 const player=createMobilePlayer({request,audio,onState:s=>states.push(s),intervalMs:10000});
 return{player,audio,calls,states,get plays(){return plays;}};
}
test('received, started and ended are distinct; Stop halts locally and disables server delivery',async t=>{
 const h=harness();t.after(()=>h.player.stop());await h.player.enable();await until(()=>h.plays===1);assert.deepEqual(h.calls.filter(c=>c[0]==='/receipt').map(c=>c[1].body.state),['received','started']);h.audio.onended();await until(()=>h.states.includes('ended'));assert.deepEqual(h.calls.filter(c=>c[0]==='/receipt').map(c=>c[1].body.state),['received','started','ended']);await h.player.stop();assert.equal(h.calls.at(-1)[0],'/pause');
});
test('browser autoplay failure is explicit failure, never ended/started receipt',async()=>{const h=harness({blocked:true});await h.player.enable();await turn();assert.deepEqual(h.calls.filter(c=>c[0]==='/receipt').map(c=>c[1].body.state),['received','failed']);assert.ok(h.states.includes('playback_blocked'));await h.player.stop();});
test('recovered started clip is stopped rather than replayed',async()=>{const h=harness({recovered:true});await h.player.enable();await turn();assert.equal(h.plays,0);assert.equal(h.calls.find(c=>c[0]==='/receipt')[1].body.state,'stopped');await h.player.stop();});

test('double activation shares one request; Stop cancels a late activation without playback',async()=>{
 let resolve,activations=0,plays=0;const states=[];
 const request=async route=>{if(route==='/activate'){activations++;return new Promise(r=>{resolve=r;});}return{};};
 const player=createMobilePlayer({request,audio:{pause(){},removeAttribute(){},load(){},async play(){plays++;}},onState:s=>states.push(s)});
 const first=player.enable(),second=player.enable();assert.equal(first,second);assert.equal(activations,1);
 await player.stop();resolve({activationId:'late'});await first;
 assert.equal(plays,0);assert.equal(states.includes('enabled'),false);
});

test('capture is suspended before play starts, then released when autoplay fails',async()=>{
 const bytes=Buffer.from('ID3fixture');const events=[];let offered=false;
 const request=async route=>{
  if(route==='/activate'||route==='/status')return{activationId:'one'};
  if(route==='/next'){if(offered)return{clip:null};offered=true;return{clip:{deliveryId:'clip',state:'offered',size:bytes.length,sha256:sha256(bytes),mime:'audio/mpeg'}};}
  if(route.startsWith('/clip/'))return new Response(bytes);return{};
 };
 const player=createMobilePlayer({request,onSpeaking:value=>events.push(value?'mic-paused':'mic-released'),
  audio:{pause(){},removeAttribute(){},load(){},async play(){events.push('play');throw Error('blocked');}},intervalMs:10000});
 await player.enable();await until(()=>events.includes('play'));await turn();
 const play=events.indexOf('play');assert.equal(events[play-1],'mic-paused');assert.ok(events.slice(play+1).includes('mic-released'));await player.stop();
});

test('a rejected old request cannot halt a newer activation',async()=>{
 let rejectOld,attempt=0,statusCalls=0;const states=[];
 const request=async route=>{
  if(route==='/activate')return{activationId:String(++attempt)};
  if(route==='/status'){statusCalls++;if(statusCalls===1)return new Promise((r,j)=>{rejectOld=j;});return{activationId:String(attempt)};}
  if(route==='/next')return{clip:null};return{};
 };
 const player=createMobilePlayer({request,audio:{pause(){},removeAttribute(){},load(){},async play(){}},onState:s=>states.push(s),intervalMs:10000});
 await player.enable();await player.stop();await player.enable();
 rejectOld(Error('old connection failed'));await turn();
 assert.equal(states.at(-1),'enabled');await player.stop();
});
