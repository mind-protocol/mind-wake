import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import Database from 'better-sqlite3';

const tableTargets = ['tech','ops'].flatMap(t => ['main','super','sub1','sub2'].map(r => `${t}.${r}`));
const sha = text => createHash('sha256').update(text).digest('hex');
const jobId = output => typeof output === 'string' ? output.replaceAll('\\','/').split('/').at(-1) : null;

// A persisted status or a queued file alone is never evidence of consumption.
export function assessConnections({proxy, jobs, superStatus, superCheckpoint, contractSha, tables, publications, inbox}) {
  const superJob = jobId(superStatus?.jobOutput);
  const loaded = superStatus?.loadedPublicModules;
  const superReady = jobs[superJob] === 'running' && loaded?.consumerJobId === superJob && loaded?.publicIngestSha256 === contractSha;
  const turns = (proxy?.queue ?? []).filter(q => q.ownerId).map(q => {
    const principalId = `alignment-proxy229:${q.id}:principal`;
    const copy = inbox[principalId];
    const principal = copy?.text === q.text && copy.origin?.senderRef === 'alignment.proxy' && copy.origin?.messageId === q.ownerId;
    const sourceId = `reply:${sha(q.id)}`;
    const eventId = `internal-actor:alignment.proxy:${sourceId}`;
    const superIngested = (superCheckpoint?.publicHistory ?? []).some(m => m.id === eventId && m.content === q.text && m.author === 'Simulation NLR — hypothèse');
    const tableIngested = tableTargets.filter(target => (tables?.proxyReceipts ?? []).some(r =>
      r.sourceOwnerId === q.ownerId && (tables.messages ?? []).some(m =>
        m.id === r.id && m.to === target && m.author === 'alignment.proxy' && m.body === q.text && m.delivery === 'persisted_context')));
    const publication = publications[q.ownerId] === q.text;
    const complete = publication && principal && superIngested && tableIngested.length === tableTargets.length;
    return {id:q.id, phase:q.phase, publication, principal, superIngested,
      tableIngested, missingTables:tableTargets.filter(t => !tableIngested.includes(t)), complete,
      overstated:q.phase === 'distributed' && !complete};
  });
  const queue=proxy?.queue ?? [];
  return {proxy:{job:proxy?.job ?? null, status:jobs[proxy?.job] ?? 'unknown',
    queued:queue.filter(q=>q.phase==='queued').length,
    generating:queue.filter(q=>q.phase==='generating').length,
    hold:proxy?.providerHold ?? null,
    failed:queue.filter(q=>['failed','uncertain'].includes(q.phase)).map(q=>({id:q.id,phase:q.phase,error:q.error ?? null}))},
    super:{job:superJob, status:jobs[superJob] ?? 'unknown', contractLoaded:superReady,
      sourceSha:contractSha, loadedSha:loaded?.publicIngestSha256 ?? null},
    tables:{job:tables?.host?.job ?? null, status:jobs[tables?.host?.job] ?? 'unknown'}, turns};
}

function json(file) {
  try {return JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(e) {if(e.code === 'ENOENT')return null;throw e;}
}
function readonly(file, use) {
  const db = new Database(file,{readonly:true,fileMustExist:true});
  try {return use(db);} finally {db.close();}
}
export function audit(dataDir) {
  const root = path.join(dataDir,'workspace/artifacts/projets/ui-app');
  const proxy = json(path.join(root,'alignment-proxy229/runtime-checkpoint.json'));
  const jobs = readonly(path.join(dataDir,'background-jobs.sqlite'),db => Object.fromEntries(
    db.prepare('SELECT id,payload FROM jobs').all().map(r => [r.id,JSON.parse(r.payload).status])));
  const publications = readonly(path.join(dataDir,'owner-messages.sqlite'),db => Object.fromEntries(
    (proxy?.queue ?? []).filter(q=>q.ownerId).map(q=>[q.ownerId,db.prepare('SELECT text FROM messages WHERE id=? AND deleted=0').get(q.ownerId)?.text])));
  const inbox = readonly(path.join(dataDir,'owner-inbox.sqlite'),db => Object.fromEntries(
    (proxy?.queue ?? []).filter(q=>q.ownerId).map(q=>{
      const id=`alignment-proxy229:${q.id}:principal`;
      const r=db.prepare('SELECT text,origin_json FROM inbox WHERE id=?').get(id);
      return [id,r ? {text:r.text,origin:r.origin_json ? JSON.parse(r.origin_json) : null} : null];
    })));
  const contract=path.join(root,'superthread-plain227/public-ingest.mjs');
  const report=assessConnections({proxy,jobs,publications,inbox,
    contractSha:sha(fs.readFileSync(contract)),
    superStatus:json(path.join(root,'superthread-plain227/auto-runtime/status.json')),
    superCheckpoint:json(path.join(root,'superthread-plain227/auto-runtime/checkpoint.json')),
    tables:json(path.join(root,'three-tables229/checkpoint.json'))});
  return {at:new Date().toISOString(),...report,limitations:'Read-only non-atomic observations. Context ingestion does not prove model reading, audio playback or human hearing.'};
}
if(process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if(process.argv.length!==4 || process.argv[2]!=='--data-dir')throw Error('Usage: node scripts/nlr-integration-audit.mjs --data-dir ABSOLUTE_DATA_DIR');
  if(!path.isAbsolute(process.argv[3]))throw Error('Absolute data directory required');
  console.log(JSON.stringify(audit(process.argv[3]),null,2));
}
