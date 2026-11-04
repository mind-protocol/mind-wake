import test from 'node:test';import assert from 'node:assert/strict';
import {createVoiceIntent,setCaptureSpeaking,subscribeCaptureSpeaking} from './voice-intent.ts';
test('speech pauses capture synchronously, resumes desired ON, human pause wins',async()=>{
 const calls=[];const intent=createVoiceIntent({async start(){calls.push('start');},pause(){calls.push('pause');}});
 const unsubscribe=subscribeCaptureSpeaking(value=>intent.setSpeaking(value));
 await intent.start();setCaptureSpeaking(true);assert.equal(calls.at(-1),'pause');
 setCaptureSpeaking(false);assert.equal(calls.at(-1),'start');
 setCaptureSpeaking(true);intent.pause();const size=calls.length;
 setCaptureSpeaking(false);assert.equal(calls.length,size);unsubscribe();
});
