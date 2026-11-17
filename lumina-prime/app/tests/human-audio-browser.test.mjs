import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import ts from 'typescript';

const browser=process.env.MIND_TEST_BROWSER??'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
test('real browser audio: three synthetic humans, mixing, mute, hangup and text', {skip:!fs.existsSync(browser),timeout:45000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mind-human-audio-'));
  const module=ts.transpileModule(fs.readFileSync(new URL('../src/chat/human-audio.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
  let resolve;const result=new Promise(r=>{resolve=r;});
  const server=createServer(async(req,res)=>{
    if(req.url==='/result'){let body='';for await(const chunk of req)body+=chunk;resolve(JSON.parse(body));res.end('ok');return;}
    res.setHeader('Content-Type',req.url==='/'?'text/html':'application/javascript');
    res.end(req.url==='/'?'<script type="module" src="/test.js"></script>':req.url==='/human-audio.js'?module:fs.readFileSync(new URL('./human-audio-browser.mjs',import.meta.url)));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const child=spawn(browser,['--headless=new','--disable-gpu','--no-first-run','--autoplay-policy=no-user-gesture-required',`--user-data-dir=${dir}`,`http://127.0.0.1:${server.address().port}/`],{windowsHide:true,stdio:'ignore'});
  t.after(async()=>{if(process.platform==='win32')spawnSync('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore',timeout:3000});else child.kill();child.unref();await new Promise(r=>{server.close(r);server.closeAllConnections();});try{fs.rmSync(dir,{recursive:true,force:true});}catch{/* Browser may finish profile cleanup asynchronously. */}});
  let timer;
  try{const value=await Promise.race([result,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Browser test timed out')),35000);})]);assert.equal(value.ok,true,value.error);t.diagnostic(JSON.stringify(value));}
  finally{clearTimeout(timer);}
});
