import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {deliver,replyText} from './postit-reply.mjs';
const selection={schema:'mind.postit.selection.v1',question_id:'coach-v1',question:"Tu veux l'explication ? Écran 🧩",option_id:'yes',option:'Oui, bientôt',message_id:'postit:'+'a'.repeat(64)};
test('Unicode and apostrophes reach stdin; retry is idempotent',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'postit-contract-'));
 try {
  const cli=path.join(dir,'cli.mjs');
  fs.writeFileSync(cli,`import fs from 'node:fs';import path from 'node:path';let text='';for await(const c of process.stdin)text+=c;const a=process.argv.slice(2);const file=path.join(a[a.indexOf('--data-dir')+1],'fixture.json');const id=a[a.indexOf('--idempotency-key')+1];const prior=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;const reply={id,text};fs.writeFileSync(file,JSON.stringify(reply));console.log(JSON.stringify({schema:'mind-wake.cli',command:'reply',ok:true,data:{status:prior?'duplicate':'recorded',reply,mirrored:false}}));`);
  assert.equal((await deliver(selection,cli,dir)).status,'queued');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'fixture.json'))),{id:selection.message_id,text:replyText(selection)});
  assert.equal((await deliver(selection,cli,dir)).status,'queued');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Failure, wrong identity and invalid selection never report queued',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'postit-contract-'));
 try{
  const cli=path.join(dir,'cli.mjs');
  fs.writeFileSync(cli,"process.exit(1)");await assert.rejects(deliver(selection,cli,dir));
  fs.writeFileSync(cli,`console.log(JSON.stringify({schema:'mind-wake.cli',command:'reply',ok:true,data:{status:'recorded',reply:{id:'other',text:'bad'}}}))`);
  await assert.rejects(deliver(selection,cli,dir));
  await assert.rejects(deliver({...selection,question_id:'invalid /'},cli,dir));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('UTF8 receipt split inside a multibyte character remains exact',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'postit-contract-'));
 try{
  const cli=path.join(dir,'cli.mjs');
  fs.writeFileSync(cli,`let text='';for await(const c of process.stdin)text+=c;const a=process.argv;const id=a[a.indexOf('--idempotency-key')+1];const b=Buffer.from(JSON.stringify({schema:'mind-wake.cli',command:'reply',ok:true,data:{status:'recorded',reply:{id,text}}}));const i=b.indexOf(Buffer.from('É'))+1;process.stdout.write(b.subarray(0,i));setTimeout(()=>process.stdout.end(b.subarray(i)),30);`);
  assert.equal((await deliver(selection,cli,dir)).status,'queued');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Freeform and emote preserve source reference; no capture unless explicitly selected',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'postit-contract-'));
 try{
  const cli=path.join(dir,'cli.mjs');
  fs.writeFileSync(cli,`import fs from 'node:fs';let text='';for await(const c of process.stdin)text+=c;const a=process.argv;const id=a[a.indexOf('--idempotency-key')+1];fs.writeFileSync(${JSON.stringify(path.join(dir,'call.json'))},JSON.stringify({args:a,text,point:process.env.MIND_WAKE_CAPTURE_CLICK_X}));console.log(JSON.stringify({schema:'mind-wake.cli',command:'reply',ok:true,data:{status:'recorded',reply:{id,text,...(a.includes('--capture-screen')?{screenshotAt:new Date().toISOString()}:{} )}}}));`);
  const message={schema:'mind.postit.message.v1',text:'Réponse au post-it [own_fixture] :\n❤️ J’adore',message_id:'postit:'+'b'.repeat(64),capture:false};
  assert.equal((await deliver(message,cli,dir)).status,'queued');
  let call=JSON.parse(fs.readFileSync(path.join(dir,'call.json')));
  assert.equal(call.text,message.text);assert.equal(call.args.includes('--capture-screen'),false);assert.equal(call.point,undefined);
  const capture={...message,capture:true,point:{x:-200,y:10,at_ms:Date.now(),root_window:'42'}};
  assert.equal((await deliver(capture,cli,dir)).status,'queued');
  call=JSON.parse(fs.readFileSync(path.join(dir,'call.json')));
  assert.equal(call.point,'-200');assert.equal(call.args.includes('--capture-screen'),true);
  await assert.rejects(deliver({...capture,point:null},cli,dir));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
