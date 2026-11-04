import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalSpeech} from './local-speech.ts';
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture({availability='available',segmentMs=15}={}) {
  const instances=[];const transcripts=[];const states=[];let visible=true;let checks=0;let installs=0;
  class Recognition {
    static async available(options) {assert.equal(options.processLocally,true);checks++;return availability;}
    static async install() {installs++;availability='available';return true;}
    processLocally=false;onresult=null;onend=null;onerror=null;onstart=null;
    constructor(){instances.push(this);}
    start(){assert.equal(this.processLocally,true);this.started=true;this.onstart?.();}
    stop(){this.stopped=true;this.onend?.();}
    abort(){this.aborted=true;this.onend?.();}
  }
  const control=createLocalSpeech({constructor:Recognition,secure:true,visible:()=>visible,onState:value=>states.push(value),onTranscript:value=>transcripts.push(value),segmentMs});
  return {control,instances,transcripts,states,setVisible:value=>visible=value,get checks(){return checks;},get installs(){return installs;}};
}
test('local required, repeated final events exactly once and automatic next segment',async()=>{
  const f=fixture();await f.control.start();await f.control.start();assert.equal(f.instances.length,1);
  const event={resultIndex:0,results:[{isFinal:true,0:{transcript:'Bonjour Marco'}}]};
  f.instances[0].onresult(event);f.instances[0].onresult(event);assert.deepEqual(f.transcripts,['Bonjour Marco']);
  // Simulate browser ending the timed segment; wait generously under concurrent builds.
  f.instances[0].stop();await tick(500);const count=f.instances.length;f.control.pause();
  assert.ok(count>=2);await tick(190);assert.equal(f.instances.length,count);
});
test('permission denial stops chaining, late results and restart are ignored',async()=>{
  const f=fixture();await f.control.start();const old=f.instances[0];old.onerror({error:'not-allowed'});
  old.onresult({resultIndex:0,results:[{isFinal:true,0:{transcript:'ignored'}}]});
  await tick(180);assert.equal(f.instances.length,1);assert.deepEqual(f.transcripts,[]);assert.match(f.states.at(-1).message,/refusé/);
});
test('model download is explicit, no recognition before local model available',async()=>{
  const f=fixture({availability:'downloadable'});await f.control.start();assert.equal(f.instances.length,0);assert.equal(f.installs,0);assert.equal(f.states.at(-1).phase,'download');
  await f.control.start(true);assert.equal(f.installs,1);assert.equal(f.instances.length,1);f.control.dispose();
});
test('unsupported engine and hidden app never start recognition',async()=>{
  const states=[];let count=0;
  const unavailable=createLocalSpeech({constructor:undefined,secure:true,visible:()=>true,onState:value=>states.push(value),onTranscript:()=>count++});
  await unavailable.start();assert.equal(states.at(-1).phase,'unsupported');assert.equal(count,0);
  const f=fixture();f.setVisible(false);await f.control.start();assert.equal(f.instances.length,0);assert.match(f.states.at(-1).message,/masquée/);
});
