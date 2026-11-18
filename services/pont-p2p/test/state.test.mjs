import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {writeJson,readJson} from '../state.mjs';

test('an atomic Windows state write retries a transient reader lock without losing the receipt',{skip:process.platform!=='win32'},()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pont-write-'));const file=path.join(dir,'status.json');
 const rename=fs.renameSync;let attempts=0;
 try{
  writeJson(file,{status:'pending'});
  fs.renameSync=(from,to)=>{if(attempts++<2){assert.equal(readJson(file,null).status,'pending');throw Object.assign(Error('busy'),{code:'EPERM'});}return rename(from,to);};
  writeJson(file,{status:'delivered'});assert.equal(attempts,3);assert.equal(readJson(file,null).status,'delivered');assert.deepEqual(fs.readdirSync(dir),['status.json']);
 }finally{fs.renameSync=rename;fs.rmSync(dir,{recursive:true,force:true});}
});
test('a permanent state write failure leaves the previous valid file intact',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pont-write-'));const file=path.join(dir,'status.json');const rename=fs.renameSync;
 try{
  writeJson(file,{status:'pending'});fs.renameSync=()=>{throw Object.assign(Error('disk'),{code:'EIO'});};
  assert.throws(()=>writeJson(file,{status:'delivered'}),/disk/);assert.equal(readJson(file,null).status,'pending');assert.deepEqual(fs.readdirSync(dir),['status.json']);
 }finally{fs.renameSync=rename;fs.rmSync(dir,{recursive:true,force:true});}
});
