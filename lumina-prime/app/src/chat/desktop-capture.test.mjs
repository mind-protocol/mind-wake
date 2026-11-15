import test from 'node:test';import assert from 'node:assert/strict';
import {createDesktopCapture} from './desktop-capture.ts';
test('desktop clips repeat sequentially and a human pause discards in-flight transcription',async()=>{
  let active=0,max=0,starts=0,transcriptions=0,resolve;const texts=[];
  const control=createDesktopCapture({maxDurationMs:50,onState:()=>{},onTranscript:text=>texts.push(text),
    begin:async()=>{starts++;return{stop:async()=>({audio:new ArrayBuffer(4),mime:'audio/webm'}),cancel:async()=>{}};},
    transcribe:async()=>{active++;max=Math.max(max,active);if(++transcriptions===1){active--;return 'bonjour';}return new Promise(r=>{resolve=()=>{active--;r('late cancelled');};});}});
  await control.start();const deadline=Date.now()+3000;
  while(!resolve&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
  assert.equal(typeof resolve,'function');
  assert.equal(max,1);assert.ok(starts>=3);const beforePause=starts;control.pause();resolve();
  await new Promise(r=>setTimeout(r,180));assert.deepEqual(texts,['bonjour']);assert.equal(starts,beforePause);control.dispose();
});
