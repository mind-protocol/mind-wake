import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import http from 'node:http';
import {AuroreGitSync,AURORE_ORIGIN,AURORE_SYNC_INTERVAL,runAuroreGit} from '../../src/daemon/aurore-git-sync.ts';
import {browseGitDocuments} from '../../services/shared-workspace/git-document-reader.mjs';
import {visibleDocuments,modificationAge,auroreDocumentStatus} from '../../desktop/ui/document-library.ts';
import {refreshAuroreCatalog} from '../../desktop/ui/document-refresh.ts';

const parent=path.resolve('output/aurore-reader-sync-date/fixtures');fs.mkdirSync(parent,{recursive:true});
const raw=(cwd,...args)=>execFileSync('git',['-c','core.hooksPath=','-c','commit.gpgsign=false','-C',cwd,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
function fixture(){
  const base=fs.mkdtempSync(path.join(parent,'sync-')),remote=path.join(base,'remote.git'),source=path.join(base,'source'),dir=path.join(base,'profile'),clone=path.join(dir,'linked-workspaces/aurore-mind-protocol');
  fs.mkdirSync(source);fs.mkdirSync(path.dirname(clone),{recursive:true});
  raw(base,'init','--bare','--initial-branch=main',remote);raw(source,'init','--initial-branch=main');
  raw(source,'config','user.name','Synthetic fixture');raw(source,'config','user.email','fixture@example.invalid');
  const commit=(relative,text,date='2026-10-01T10:00:00+02:00')=>{
    fs.writeFileSync(path.join(source,relative),text);raw(source,'add','--all');
    execFileSync('git',['-c','core.hooksPath=','-c','commit.gpgsign=false','-C',source,'commit','-m','Synthetic fixture'],{env:{...process.env,GIT_AUTHOR_DATE:date,GIT_COMMITTER_DATE:date},stdio:'pipe',windowsHide:true});
    raw(source,'push',remote,'main');return raw(source,'rev-parse','HEAD');
  };
  commit('old.md','old');raw(base,'clone','--no-hardlinks',remote,clone);raw(clone,'remote','set-url','origin',AURORE_ORIGIN);
  fs.writeFileSync(path.join(dir,'atelier-aurore.json'),JSON.stringify({enabled:true,origin:AURORE_ORIGIN}));
  let now=Date.parse('2026-10-31T00:00:00Z'),allowed=true,mode='',calls=0,fetchStarted=false,fetchImplementation;
  const execute=async(cwd,args,signal)=>{
    calls++;
    if(args.includes('fetch')){
      fetchStarted=true;
      assert.equal(args.at(-2),AURORE_ORIGIN);assert.equal(args.at(-1),'refs/heads/main');
      if(fetchImplementation)return fetchImplementation(cwd,args,signal);
      if(mode==='network')throw Error('Synthetic network unavailable');
      if(mode==='pause'||mode==='forceoff'||mode==='disable'){
        if(mode==='disable')fs.writeFileSync(path.join(dir,'atelier-aurore.json'),'{"enabled":false}');else allowed=false;
        await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
        assert(signal.aborted);throw Error('Synthetic supervised fetch cancelled');
      }
    }
    // Code-only seam: production still accepts exactly one fixed HTTPS origin.
    return runAuroreGit(cwd,['-c','protocol.file.allow=always',...args.map(v=>v===AURORE_ORIGIN&&args.includes('fetch')?remote:v)],signal);
  };
  const sync=new AuroreGitSync(dir,()=>allowed,()=>now,execute);
  return {base,dir,clone,source,remote,commit,sync,execute,
    state:()=>JSON.parse(fs.readFileSync(path.join(dir,'aurore-sync-state.json'),'utf8')),
    browse:(r={relative:'',read:false})=>browseGitDocuments(dir,r),
    next:()=>{now+=AURORE_SYNC_INTERVAL;},setMode:v=>{mode=v;},allow:v=>{allowed=v;},calls:()=>calls,atFetch:()=>fetchStarted,
    setFetch:v=>{fetchImplementation=v;}};
}

test('real supervised local fetch: new/update/rename, content dates and UI ordering at same SHA', {timeout:120000},async()=>{
  const f=fixture();try{
    const first=raw(f.clone,'rev-parse','HEAD');
    fs.writeFileSync(path.join(f.clone,'.git/hooks/post-merge'),'#!/bin/sh\nprintf unsafe > SHOULD_NOT_RUN\n');
    await f.sync.tick();assert.equal(f.state().status,'ok');assert.equal(f.state().version,first);
    const calls=f.calls();await f.sync.tick();assert.equal(f.calls(),calls,'poll before due must neither fetch nor postpone due');
    f.commit('new.md','new','2026-10-02T10:00:00+02:00');f.next();await f.sync.tick();assert.equal(f.state().status,'ok');
    const current=f.commit('old.md','updated','2026-10-03T10:00:00+02:00');f.next();await f.sync.tick();
    const catalog=f.browse();assert.equal(catalog.version,current);assert.equal(catalog.origin,AURORE_ORIGIN);
    assert.equal(fs.existsSync(path.join(f.clone,'SHOULD_NOT_RUN')),false,'replica hooks never run');
    assert.equal(f.browse({relative:'',read:false,version:current}).state,'unchanged');
    assert.equal(catalog.entries.find(e=>e.relative==='old.md').modifiedAt,Date.parse('2026-10-03T08:00:00Z'));
    assert.equal(catalog.entries.find(e=>e.relative==='new.md').modifiedAt,Date.parse('2026-10-02T08:00:00Z'));
    assert(catalog.entries.every(e=>e.modifiedAtSource==='git-path-commit'));
    assert.deepEqual(visibleDocuments(catalog.entries,'','','').map(e=>e.relative),['old.md','new.md']);
    assert.equal(modificationAge(catalog.entries[0].modifiedAt,Date.parse('2026-10-04T08:00:00Z')).date,'2026-10-03T08:00:00.000Z');
    assert.match(auroreDocumentStatus(catalog.version,catalog.sync),/révision chargée/);
    assert.equal(f.browse({relative:'old.md',read:true,version:current}).text,'updated');
    assert.equal(f.browse({relative:'old.md',read:true,version:first}).state,'version-changed');
    raw(f.source,'mv','new.md','renamed.md');f.commit('old.md','updated','2026-10-04T10:00:00+02:00');f.next();await f.sync.tick();
    const renamed=f.browse();assert.equal(renamed.entries.find(e=>e.relative==='renamed.md').modifiedAt,Date.parse('2026-10-04T08:00:00Z'));
    assert.equal(renamed.entries.find(e=>e.relative==='old.md').modifiedAt,Date.parse('2026-10-03T08:00:00Z'),'unmodified file never inherits HEAD date');
    assert(!renamed.entries.some(e=>e.relative==='new.md'));
  }finally{await f.sync.close();}
});
test('dirty, divergence and lock preserve the previous committed documents', {timeout:120000},async()=>{
  const f=fixture();try{
    const before=raw(f.clone,'rev-parse','HEAD');f.commit('old.md','remote');
    fs.writeFileSync(path.join(f.clone,'old.md'),'dirty');await f.sync.tick();assert.match(f.state().error,/dirty/);assert.equal(raw(f.clone,'rev-parse','HEAD'),before);assert.equal(f.browse({relative:'old.md',read:true,version:before}).text,'old');
    fs.writeFileSync(path.join(f.clone,'old.md'),'old');fs.writeFileSync(path.join(f.clone,'.git/info/exclude'),'ignored.md\n');fs.writeFileSync(path.join(f.clone,'ignored.md'),'ignored local work');
    f.next();await f.sync.tick();assert.match(f.state().error,/dirty/);assert.equal(raw(f.clone,'rev-parse','HEAD'),before);fs.unlinkSync(path.join(f.clone,'ignored.md'));
    fs.writeFileSync(path.join(f.clone,'old.md'),'local');raw(f.clone,'add','old.md');raw(f.clone,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Synthetic divergence');
    const local=raw(f.clone,'rev-parse','HEAD');f.next();await f.sync.tick();assert.match(f.state().error,/diverged/);assert.equal(raw(f.clone,'rev-parse','HEAD'),local);
    const lock=path.join(f.clone,'.git/mind-wake-workspace-sync.lock');fs.writeFileSync(lock,'synthetic-owner');f.next();await f.sync.tick();assert.match(f.state().error,/lock held/);assert.equal(fs.readFileSync(lock,'utf8'),'synthetic-owner');assert.equal(f.browse().state,'syncing');
  }finally{await f.sync.close();}
});
test('network error retries only when due, preserving documents and persisted next deadline', {timeout:120000},async()=>{
  const f=fixture();try{
    const before=raw(f.clone,'rev-parse','HEAD');f.commit('old.md','remote');f.setMode('network');await f.sync.tick();
    assert.equal(f.state().status,'error');assert.match(f.state().error,/network/);assert.equal(raw(f.clone,'rev-parse','HEAD'),before);
    const calls=f.calls();await f.sync.tick();assert.equal(f.calls(),calls);
    f.setMode('');f.next();await f.sync.tick();assert.equal(f.state().status,'ok');assert.equal(f.browse({relative:'old.md',read:true}).text,'remote');
  }finally{await f.sync.close();}
});
for(const control of ['pause','forceoff','disable'])test(`${control} before/during fetch cancels retry and preserves HEAD`,{timeout:120000},async()=>{
  const f=fixture();try{
    const before=raw(f.clone,'rev-parse','HEAD');f.allow(false);await f.sync.tick();assert.equal(f.state().status,'paused');assert.equal(f.calls(),0);
    f.allow(true);f.setMode(control);await f.sync.tick();assert.equal(f.state().status,'paused');assert.equal(f.state().nextRunAt,null);assert.equal(raw(f.clone,'rev-parse','HEAD'),before);
    const calls=f.calls();f.next();await f.sync.tick();assert.equal(f.calls(),calls);assert.equal(f.state().status,control==='disable'?'disabled':'paused');
  }finally{await f.sync.close();}
});
test('close aborts supervised in-flight work and permanently prevents later ticks',{timeout:120000},async()=>{
  const f=fixture();f.setMode('pause');const flight=f.sync.tick();
  // Wait for real validations to reach the injected pending fetch, not a wall-clock race.
  const deadline=Date.now()+30000;
  while(!f.atFetch() && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  await f.sync.close();await flight;const calls=f.calls();await f.sync.tick();assert.equal(f.calls(),calls);assert.equal(f.state().nextRunAt,null);
});
for(const control of ['Pause','Force-off'])test(`${control} kills an actual supervised Git fetch waiting on a loopback fixture`,{timeout:120000},async()=>{
  const f=fixture(),before=raw(f.clone,'rev-parse','HEAD');let requested=false;
  const server=http.createServer((_request,_response)=>{requested=true;f.allow(false);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/synthetic.git`;
  f.setFetch((cwd,args,signal)=>runAuroreGit(cwd,['-c','protocol.http.allow=always',...args.map(v=>v===AURORE_ORIGIN?url:v)],signal));
  try{
    await f.sync.tick();assert.equal(requested,true,'real Git reached local HTTP and waited');
    assert.equal(f.state().status,'paused');assert.equal(f.state().nextRunAt,null);
    assert.equal(raw(f.clone,'rev-parse','HEAD'),before);assert.equal(fs.existsSync(path.join(f.clone,'.git/mind-wake-workspace-sync.lock')),false);
    const calls=f.calls();f.next();await f.sync.tick();assert.equal(f.calls(),calls);
  }finally{await f.sync.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('wrong origin/config, branch and junction do not allow a fetch',{timeout:120000},async()=>{
  const f=fixture();try{
    raw(f.clone,'config','filter.evil.smudge','should-never-run');await f.sync.tick();assert.match(f.state().error,/Unsupported/);
    raw(f.clone,'config','--remove-section','filter.evil');raw(f.clone,'remote','set-url','origin','https://example.invalid/other');f.next();await f.sync.tick();assert.match(f.state().error,/origin/);
    raw(f.clone,'config','remote.origin.url',AURORE_ORIGIN+'\nhttps://example.invalid/other');f.next();await f.sync.tick();assert.match(f.state().error,/origin/);
    raw(f.clone,'remote','set-url','origin',AURORE_ORIGIN);raw(f.clone,'checkout','-b','other');f.next();await f.sync.tick();assert.match(f.state().error,/branch main/);
    raw(f.clone,'checkout','main');const outside=path.join(f.base,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(f.clone,'alias'),'junction');f.next();await f.sync.tick();assert.match(f.state().error,/Linked/);
  }finally{await f.sync.close();}
});
test('shallow boundary dates are unavailable with a reason, rather than HEAD or checkout time',()=>{
  const f=fixture();f.commit('new.md','new','2026-10-02T10:00:00Z');
  const shallow=path.join(f.base,'shallow');raw(f.base,'clone','--depth=1',new URL('file:///'+f.remote.replaceAll('\\','/')).href,shallow);
  raw(shallow,'remote','set-url','origin',AURORE_ORIGIN);
  const config=path.join(f.base,'shallow-profile');fs.mkdirSync(path.join(config,'linked-workspaces'),{recursive:true});fs.renameSync(shallow,path.join(config,'linked-workspaces/aurore-mind-protocol'));
  fs.writeFileSync(path.join(config,'atelier-aurore.json'),JSON.stringify({enabled:true,origin:AURORE_ORIGIN}));
  const catalog=browseGitDocuments(config,{relative:'',read:false});assert.equal(catalog.state,'available');
  assert(catalog.entries.every(e=>e.modifiedAt===null&&e.dateUnavailableReason==='shallow-history-boundary'));
});

test('existing scheduler maintenance -> supervised FF -> local catalogue -> active view refresh',{timeout:120000},async()=>{
  const {openStore}=await import('../../src/store/index.ts');
  const {bench,seedProfile}=await import('../fixtures/scheduler/setup.ts');
  const f=fixture(),store=openStore(path.join(f.base,'scheduler.sqlite'));
  seedProfile(store.uow,{state:'blocked'}); // No model session; maintenance is independent of wake eligibility.
  const abort=new AbortController();let flight=Promise.resolve(),cycles=0,view={version:null,text:null,entries:[]};
  const b=bench(store,path.join(f.base,'scheduler.lock'),{overrides:{
    maintenance:()=>{cycles++;flight=f.sync.tick();},
    sleep:async ms=>{
      assert.equal(ms,60000);await flight;
      await refreshAuroreCatalog(async()=>f.browse(),()=>true,async catalog=>{
        view={version:catalog.version,entries:visibleDocuments(catalog.entries,'','',''),text:f.browse({relative:'old.md',read:true,version:catalog.version}).text};
      });
      if(cycles===1){f.commit('new.md','new','2026-10-03T10:00:00Z');f.commit('old.md','updated via scheduler','2026-10-04T10:00:00Z');f.next();b.clock.advance(ms);}
      else abort.abort();
    },
  }});
  try {
    await b.scheduler.run(abort.signal);
    assert.equal(cycles,2);assert.equal(f.state().status,'ok');
    assert.equal(view.version,raw(f.remote,'rev-parse','main'));assert.equal(view.text,'updated via scheduler');
    assert.deepEqual(view.entries.map(e=>e.relative),['old.md','new.md']);assert.equal(view.entries[0].modifiedAt,Date.parse('2026-10-04T10:00:00Z'));
    let finish;const stale=refreshAuroreCatalog(()=>new Promise(resolve=>{finish=resolve;}),()=>false,async()=>{throw Error('stale view applied');});finish(f.browse());await stale;
    assert.equal(b.launcher.tickets.length,0);
  }finally{await f.sync.close();b.close();store.close();}
});
