import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {expect,it} from 'vitest';
import {openStore} from '../src/store/index.js';
import {createProfile,policyGroups,PROFILE,ts} from './fixtures/store-ledger/setup.js';
import type {PolicyRevisionId,ConsentId} from '../src/contracts/index.js';

it('configures an existing profile only after real trusted HTTPS whoami; dry run, profile/identity/stop checks and secrets stay local',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wake-inbox-setup-'));
 const state=path.join(dir,'private'),data=path.join(dir,'data');fs.mkdirSync(state);fs.mkdirSync(data);
 const key='A'.repeat(43),agent='agent-dckgeedfrm';
 fs.writeFileSync(path.join(state,'.mind-shared-messages'),'mind.shared/local-state.v1\n');
 fs.writeFileSync(path.join(state,'agent.key'),key);
 const cert=path.join(dir,'cert.pem'),tlsKey=path.join(dir,'tls.key');
 const openssl=process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl';
 execFileSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',tlsKey,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
 const store=openStore(path.join(data,'control.sqlite'));createProfile(store.uow);
 const defaults=policyGroups();const groups:ReturnType<typeof policyGroups>={...defaults,runtime:{...defaults.runtime,adapterId:'codex' as typeof defaults.runtime.adapterId,provider:'openai',model:'gpt-5',authMode:'subscription',hostUnsandboxedAcknowledged:true}};
 const rev='rev-helper' as PolicyRevisionId;
 store.uow.policies.appendRevision({schemaVersion:1,id:rev,profileId:PROFILE,previousRevisionId:null,createdAt:ts('2026-10-31T00:00:00Z'),groups});
 store.uow.policies.recordConsent({id:'consent-helper' as ConsentId,revisionId:rev,grantedAt:ts('2026-10-31T00:00:00Z'),channel:'local_cli',proof:'test'});
 store.db.prepare("UPDATE profiles SET state='paused',active_policy_revision_id=? WHERE id=?").run(rev,PROFILE);
 let identity:{kind:string;ref:string}={kind:'agent',ref:agent};let calls=0;
 const server=https.createServer({key:fs.readFileSync(tlsKey),cert:fs.readFileSync(cert)},async(req,res)=>{
  calls++;expect(req.headers.authorization).toBe(`Bearer ${key}`);let text='';for await(const chunk of req)text+=chunk;
  const body=JSON.parse(text);expect(body.op).toBe('whoami');res.setHeader('content-type','application/json');res.end(JSON.stringify({id:body.id,ok:true,result:identity}));
 });
 await new Promise<void>(resolve=>server.listen(0,'localhost',resolve));
 const port=(server.address() as {port:number}).port;
 fs.writeFileSync(path.join(state,'endpoint.json'),JSON.stringify({endpoint:`https://localhost:${port}/v1/messages`}));
 const args=['scripts/setup-shared-inbox.mjs','--data-dir',data,'--state-dir',state,'--profile',PROFILE,'--agent-ref',agent];
 const run=(mode:string,extra:string[]=[])=>promisify(execFile)(process.execPath,[...args,...extra,`--${mode}`],{cwd:process.cwd(),env:{...process.env,NODE_EXTRA_CA_CERTS:cert},timeout:10000});
 try {
  await expect(promisify(execFile)(process.execPath,[...args,'--dry-run'],{cwd:process.cwd(),env:{...process.env,NODE_EXTRA_CA_CERTS:''},timeout:10000})).rejects.toThrow();
  expect(calls).toBe(0); // self-signed server is refused without the explicitly trusted CA
  const dry=await run('dry-run');expect(dry.stdout).not.toContain(key);expect(fs.existsSync(path.join(data,'shared-inbox.json'))).toBe(false);
  identity={kind:'human',ref:'human-mkcv2hapch'};await expect(run('enable')).rejects.toThrow();expect(fs.existsSync(path.join(data,'shared-inbox.json'))).toBe(false);
  identity={kind:'agent',ref:agent};await expect(run('enable',['--profile','missing'])).rejects.toThrow();
  const enabled=await run('enable');expect(enabled.stdout).not.toContain(key);expect(enabled.stderr).not.toContain(key);
  expect(JSON.parse(fs.readFileSync(path.join(data,'shared-inbox.json'),'utf8'))).toMatchObject({enabled:true,agentRef:agent,profileId:PROFILE,keyFile:path.join(state,'agent.key')});
  await run('check');expect(store.uow.profiles.get(PROFILE)?.state).toBe('paused');
  fs.writeFileSync(path.join(data,'emergency-stop.flag'),'stop');const before=calls;await expect(run('enable')).rejects.toThrow();expect(calls).toBe(before);
  expect(fs.readdirSync(data)).not.toContain('human-wake.json');
 } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();fs.rmSync(dir,{recursive:true,force:true});}
},30000);
