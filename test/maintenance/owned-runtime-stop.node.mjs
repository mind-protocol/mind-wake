import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {OwnedRuntime,ownedComponents} from "../../scripts/owned-runtime.mjs";

test("the authenticated engine owner stops its child under Force-off without launching a replacement",async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"wake-owned-stop-"));
  const manifest=path.join(dir,"manifest.json"),entry=path.join(dir,"engine.cjs");
  fs.writeFileSync(manifest,JSON.stringify({version:1,dataDir:dir,repoDir:dir}));
  fs.writeFileSync(path.join(dir,"keys.json"),JSON.stringify({owner:"fixture-owner-key"}));
  fs.writeFileSync(entry,`const fs=require('node:fs'),crypto=require('node:crypto');fs.writeFileSync(process.env.MIND_WAKE_OWNED_RECEIPT,JSON.stringify({role:'daemon',pid:process.pid,instance:process.env.MIND_WAKE_OWNED_INSTANCE,entry:__filename,loadedRevision:'${"a".repeat(40)}',artifactSha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')}));process.on('message',()=>process.exit(0));setInterval(()=>{},1000);`);
  let launches=0,child;
  const owner=new OwnedRuntime(manifest,"daemon",async({file,instance})=>{
    launches++;
    child=spawn(process.execPath,[entry],{windowsHide:true,stdio:["ignore","ignore","ignore","ipc"],env:{...process.env,MIND_WAKE_OWNED_RECEIPT:file,MIND_WAKE_OWNED_INSTANCE:instance}});
    return {entry,child};
  },{guard:()=>{throw Error("Force-off forbids restart");},readyTimeout:3000});
  try {
    await owner.start();
    const result=await ownedComponents(manifest,"daemon","stop",new AbortController().signal);
    assert.equal(result.component.state,"stopped");
    assert.equal(launches,1);
    assert.notEqual(child.exitCode,null);
    assert.equal((await owner.observe()).state,"stopped");
  } finally {await owner.close();fs.rmSync(dir,{recursive:true,force:true});}
});
