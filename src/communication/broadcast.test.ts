import {it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {broadcastHuman,broadcastTargets} from './broadcast.js';
it('snapshots active keepers, stores literal human provenance once and excludes stopped forks',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wake-broadcast-'));
 try{
  const keeper=path.join(dir,'workspace/artifacts/projets/test/keeper'),out=path.join(dir,'workspace/role');fs.mkdirSync(keeper,{recursive:true});fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(keeper,'config.json'),JSON.stringify({roles:{scenes:{outputRoot:out},stopped:{outputRoot:out}}}));
  fs.writeFileSync(path.join(keeper,'keeper.lock'),JSON.stringify({pid:process.pid}));
  fs.writeFileSync(path.join(keeper,'state.json'),JSON.stringify({roles:{scenes:{},stopped:{blocked:true}}}));
  expect(broadcastTargets(dir).map(t=>t.id)).toEqual(['owner','keeper:test:scenes']);
  let sent=0;const text='  mot exact\r\ncondition  ';
  await broadcastHuman(dir,'ui-all-fixture',text,async()=>{sent++;});
  // Retry after inventory change must keep the first recipient snapshot.
  fs.writeFileSync(path.join(keeper,'state.json'),JSON.stringify({roles:{}}));
  const receipt=await broadcastHuman(dir,'ui-all-fixture',text,async()=>{sent++;});
  expect(sent).toBe(1);expect(receipt.recipients).toHaveLength(2);
  const records=fs.readFileSync(path.join(out,'INBOX.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
  expect(records).toHaveLength(1);expect(records[0]).toMatchObject({text,author:'human',origin:'human_input',sourceHuman:'ui-all-fixture'});
  await expect(broadcastHuman(dir,'ui-all-fixture','different',async()=>{})).rejects.toThrow('autre texte');
  await expect(broadcastHuman(dir,'empty-fixture','   ',async()=>{})).rejects.toThrow('invalide');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
it('refuses a concurrent send with the same key, then recovers the persisted receipt',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wake-broadcast-race-'));
 try{
  let finish!:()=>void;const barrier=new Promise<void>(resolve=>{finish=resolve;});let calls=0;
  const first=broadcastHuman(dir,'ui-all-concurrent','Texte',async()=>{calls++;await barrier;});
  await expect(broadcastHuman(dir,'ui-all-concurrent','Texte',async()=>{calls++;})).rejects.toThrow('déjà en cours');
  finish();await first;
  const retry=await broadcastHuman(dir,'ui-all-concurrent','Texte',async()=>{calls++;});
  expect(calls).toBe(1);expect(retry.recipients[0]?.state).toBe('queued');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
