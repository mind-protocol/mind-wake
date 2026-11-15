import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {assessConnections} from './nlr-integration-audit.mjs';

function fixture(){
  const q={id:'turn-1',ownerId:'own-1',text:'Simulation — hypothèse',phase:'distributed'};
  const eventId='internal-actor:alignment.proxy:reply:'+createHash('sha256').update(q.id).digest('hex');
  const targets=['tech','ops'].flatMap(t=>['main','super','sub1','sub2'].map(r=>`${t}.${r}`));
  return {proxy:{job:'proxy-job',queue:[q]},jobs:{'proxy-job':'running','super-job':'running','tables-job':'running'},
    superStatus:{jobOutput:'C:\\jobs\\super-job',loadedPublicModules:{consumerJobId:'super-job',publicIngestSha256:'current'}},
    contractSha:'current',superCheckpoint:{publicHistory:[{id:eventId,author:'Simulation NLR — hypothèse',content:q.text}]},
    tables:{host:{job:'tables-job'},proxyReceipts:targets.map(to=>({id:to,sourceOwnerId:q.ownerId})),
      messages:targets.map(to=>({id:to,to,author:'alignment.proxy',body:q.text,delivery:'persisted_context'}))},
    publications:{[q.ownerId]:q.text},inbox:{[`alignment-proxy229:${q.id}:principal`]:{text:q.text,origin:{senderRef:'alignment.proxy',messageId:q.ownerId}}}};
}
test('complete requires exact publication and all distinct consumer receipts',()=>{
  const f=fixture();assert.equal(assessConnections(f).turns[0].complete,true);
  f.tables.messages.forEach(m=>m.to='tech.main');
  const r=assessConnections(f).turns[0];assert.equal(r.complete,false);assert.equal(r.tableIngested.length,1);assert.equal(r.overstated,true);
});
test('cancelled consumer and changed module cannot be reported as live',()=>{
  const f=fixture();f.jobs['proxy-job']='cancelled';f.jobs['super-job']='cancelled';
  assert.equal(assessConnections(f).proxy.status,'cancelled');assert.equal(assessConnections(f).super.contractLoaded,false);
  f.jobs['super-job']='running';f.contractSha='changed';assert.equal(assessConnections(f).super.contractLoaded,false);
});
test('queued delivery and a forged principal source do not prove ingestion',()=>{
  const f=fixture();f.inbox['alignment-proxy229:turn-1:principal'].origin.senderRef='other';f.superCheckpoint.publicHistory=[];
  f.tables.messages.forEach(m=>m.delivery='queued');const r=assessConnections(f).turns[0];
  assert.equal(r.principal,false);assert.equal(r.superIngested,false);assert.equal(r.tableIngested.length,0);assert.equal(r.complete,false);
});
test('a running watcher does not hide a failed generation or provider hold',()=>{
  const f=fixture();f.proxy.providerHold={reason:'provider refused'};
  f.proxy.queue.push({id:'failed-turn',phase:'failed',error:{code:'Error',message:'Missing simulation label'}});
  const r=assessConnections(f);assert.equal(r.proxy.status,'running');assert.equal(r.proxy.failed.length,1);
  assert.equal(r.proxy.failed[0].error.message,'Missing simulation label');assert.deepEqual(r.proxy.hold,f.proxy.providerHold);
});
