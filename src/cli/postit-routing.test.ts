import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {seedSimulatedProfile} from '../../test/demo/harness.js';
import {SecondThreadStore} from '../daemon/second-thread.js';
import {forkDir, forkEnabled, sendToFork} from '../daemon/forks.js';
import {readOwnerInboxHistory} from '../communication/owner-inbox.js';
import {processContext, DEFAULT_PROFILE_ID} from './context.js';
import {runCli} from './run.js';
// @ts-expect-error Standalone overlay transport is deliberately plain JavaScript.
import {deliver, replyText} from '../../tools/postit/postit-reply.mjs';

let dir:string, cli:string;
vi.setConfig({testTimeout:60000});
const root=fileURLToPath(new URL('../../',import.meta.url));
beforeEach(()=>{
 dir=fs.mkdtempSync(path.join(os.tmpdir(),'postit-route-offline-'));
 seedSimulatedProfile(dir,{runtimeAdapterId:'codex',hostUnsandboxed:true,runtime:{nativeCapabilities:true}});
 cli=path.join(dir,'source-cli.mjs');
 // Run the actual candidate CLI in a child process, with native TS execution. No build/runtime.
 fs.writeFileSync(cli,`import {spawnSync} from 'node:child_process';import fs from 'node:fs';
 const r=spawnSync(process.execPath,['--experimental-transform-types','--disable-warning=ExperimentalWarning','--import',${JSON.stringify(pathToFileURL(path.join(root,'test/fixtures/store-ledger/ts-hooks.ts')).href)},${JSON.stringify(path.join(root,'src/cli/main.ts'))},...process.argv.slice(2)],{input:fs.readFileSync(0),encoding:'utf8',windowsHide:true});process.stdout.write(r.stdout??'');fs.writeFileSync(${JSON.stringify(path.join(dir,'fixture-stderr.txt'))},String(r.error??r.stderr));process.exitCode=r.status??1;`);
});
afterEach(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
const source=(destination='fork:8')=>({schema:'mind.postit.question.v1',question_id:'same-card',question:'Question exacte\nÉcran 🧩 ?',destination,cli,data_dir:dir,response_dir:dir});
const selection=(destination='fork:8')=>({schema:'mind.postit.selection.v1',question_id:'same-card',question:source().question,option_id:'other',option:'Écouter, puis essayer.',message_id:'postit:'+'a'.repeat(64),destination,source_receipt:source(destination),clicked_at:'2026-11-05T15:24:28.000Z'});
function entries(id=8){const store=new SecondThreadStore(forkDir(dir,id));try{return store.entries();}finally{store.close();}}
async function command(args:string[],input=''){
 const out:string[]=[];
 const code=await runCli([...args,'--data-dir',dir,'--json'],{...processContext(),stdout:s=>out.push(s),stderr:()=>{},readStdin:async()=>input});
 return {code,json:JSON.parse(out.join(''))};
}

it('real source CLI: explicit route survives tab change, double click and restart/retry; no main fanout',async()=>{
 const card=selection();
 process.env['MIND_WAKE_CURRENT_TAB']='principal';
 const results=await Promise.all([deliver(card,cli,dir),deliver(card,cli,dir)]);
 expect(results.map((r:{destination:string})=>r.destination)).toEqual(['fork:8','fork:8']);
 process.env['MIND_WAKE_CURRENT_TAB']='fork:2';
 expect((await deliver(JSON.parse(JSON.stringify(card)),cli,dir)).status).toBe('queued');
 delete process.env['MIND_WAKE_CURRENT_TAB'];
 expect(entries().map(e=>e.text)).toEqual([replyText(card)]);
 expect(readOwnerInboxHistory(dir)).toEqual([]);
 expect(forkEnabled(dir,8)).toBe(false);
 const store=new SecondThreadStore(forkDir(dir,8));
 try{store.markDelivered(store.pendingHuman().map(e=>e.id));}finally{store.close();}
 await deliver(card,cli,dir);
 expect(entries()).toHaveLength(1); // Dedup is retained after consumption, not just while pending.
 await expect(deliver({...card,option:'Deuxième réponse'},cli,dir)).rejects.toThrow();
 expect(entries()).toHaveLength(1);
});

it('lost acknowledgement after actual commit retries the same saved key without a second entry',async()=>{
 const card=selection();
 const wrapper=fs.readFileSync(cli,'utf8');
 fs.writeFileSync(cli,wrapper.replace("process.exitCode=r.status??1;","process.exitCode=1;"));
 await expect(deliver(card,cli,dir)).rejects.toThrow();
 expect(entries()).toHaveLength(1);
 fs.writeFileSync(cli,wrapper);
 await deliver(card,cli,dir);
 expect(entries()).toHaveLength(1);
});

it('reference reactions preserve exact source and provenance through the official CLI',async()=>{
 const card={schema:'mind.postit.message.v1',message_id:'postit:'+'b'.repeat(64),text:'Reponse au post-it [same-card] :\nReaction : Merci',reply_to:'same-card',capture:false,destination:'fork:8',source_receipt:source()};
 await deliver(card,cli,dir);
 const store=new SecondThreadStore(forkDir(dir,8));
 try{const receipt=JSON.parse(store.get('human-receipt:'+card.message_id)!);expect(JSON.parse(receipt.provenance)).toEqual(card);}finally{store.close();}
 expect(entries()[0]?.text).toBe(card.text);
 expect(readOwnerInboxHistory(dir)).toEqual([]);
});

it('Pause and Force-off accept only queued messages and never change the profile or fork switch',async()=>{
 for(const control of ['pause','stop']){
  expect((await command([control])).code).toBe(0);
  const before=(await command(['status'])).json;
  const card=selection();card.message_id='postit:'+(control==='pause'?'c':'d').repeat(64);
  await deliver(card,cli,dir);
  expect((await command(['status'])).json).toEqual(before);
  expect(forkEnabled(dir,8)).toBe(false);
 }
 expect(entries()).toHaveLength(2);
});

it('invalid/mismatched destination and revoked native consent fail without fallback',async()=>{
 await expect(deliver(selection('fork:9'),cli,dir)).rejects.toThrow();
 await expect(deliver({...selection(),destination:'fork:2'},cli,dir)).rejects.toThrow();
 expect(fs.existsSync(forkDir(dir,8))).toBe(false);
 expect(readOwnerInboxHistory(dir)).toEqual([]);
 const other=path.join(dir,'unconsented');fs.mkdirSync(other);
 seedSimulatedProfile(other);
 const card=selection();card.source_receipt.data_dir=other;
 await expect(deliver(card,cli,other)).rejects.toThrow();
 expect(readOwnerInboxHistory(other)).toEqual([]);
 expect(fs.existsSync(forkDir(other,8))).toBe(false);
});

it('historical cards without route still use principal; exact retry remains single queued message',async()=>{
 const {destination:_,source_receipt:__,...card}=selection();
 await deliver(card,cli,dir);await deliver(card,cli,dir);
 expect(readOwnerInboxHistory(dir).map(e=>e.text)).toEqual([replyText(card)]);
 expect(fs.existsSync(forkDir(dir,8))).toBe(false);
});

it('an actual policy revocation refuses even a retry and leaves the destination inbox unchanged',async()=>{
 const card=selection();await deliver(card,cli,dir);
 const store=processContext().openStore(dir,'write');
 try{
  const revisionId=store.uow.profiles.get(DEFAULT_PROFILE_ID)!.activePolicyRevisionId!;
  store.uow.policies.recordRevocation({revisionId,revokedAt:new Date().toISOString() as never,reason:'offline fixture revocation'});
 }finally{store.close();}
 await expect(deliver(card,cli,dir)).rejects.toThrow();
 expect(entries()).toHaveLength(1);expect(readOwnerInboxHistory(dir)).toEqual([]);
});

it('store rolls entry and durable receipt back together if commit preparation fails',()=>{
 fs.mkdirSync(forkDir(dir,8),{recursive:true});
 const store=new SecondThreadStore(forkDir(dir,8));
 try{
  const original=store.set.bind(store);store.set=()=>{throw Error('simulated crash before commit');};
  expect(()=>store.addHumanOnce('crash-key', 'exact', '{}')).toThrow();
  expect(store.entries()).toEqual([]);
  store.set=original;
 }finally{store.close();}
 sendToFork(dir,8,'exact','crash-key','{}');
 expect(entries()).toHaveLength(1);
});
