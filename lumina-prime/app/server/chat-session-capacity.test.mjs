import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createChatServer} from './chat-server.mjs';
import {ChatClientError,needsNewChatSession} from '../src/chat/client.ts';

const token=i=>i.toString(16).padStart(64,'0');
const key=i=>createHash('sha256').update(token(i)).digest('hex');
async function fixture(t,rows,now=10_000_000) {
 let saved=rows;const service=createChatServer({bridge:{snapshot:()=>[],send:()=>({})},privateNetworkConnect:true,now:()=>now,sessionTtlMs:12*60*60_000,sessionStore:{load:()=>saved,save:v=>{saved=v;}}});
 await new Promise(r=>service.server.listen(0,'127.0.0.1',r));t.after(()=>service.close());
 const base=`http://127.0.0.1:${service.server.address().port}`;
 return {saved:()=>saved,read:i=>fetch(base+'/chat/messages?cursor=&wait=0',{headers:{Authorization:'Bearer '+token(i)}}),connect:()=>fetch(base+'/chat/connect-local',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})};
}
test('a full legacy store recovers by replacing just the oldest idle session, preserving a recently used token',async t=>{
 const rows=Array.from({length:100},(_,i)=>[key(i),{expiresAt:10_000_000+1000+i,human:'nlr'}]);const f=await fixture(t,rows);
 assert.equal((await f.read(0)).status,200);
 assert.equal((await f.connect()).status,200);assert.equal(f.saved().length,100);
 assert.ok(f.saved().some(([k])=>k===key(0)));assert.ok(!f.saved().some(([k])=>k===key(1)));assert.equal((await f.read(0)).status,200);
});
test('the cap still refuses a 101st connection when every session is active',async t=>{
 const f=await fixture(t,Array.from({length:100},(_,i)=>[key(i),{expiresAt:20_000_000,lastSeenAt:10_000_000,human:'nlr'}]));
 assert.equal((await f.connect()).status,429);assert.equal(f.saved().length,100);
});
test('expired sessions are removed before enforcing the cap',async t=>{
 const f=await fixture(t,Array.from({length:100},(_,i)=>[key(i),{expiresAt:1,human:'nlr'}]));
 assert.equal((await f.connect()).status,200);assert.equal(f.saved().length,1);
});
test('only an unauthorized response replaces the saved client token',()=>{
 for(const e of [new ChatClientError('connection_lost'),new ChatClientError('connection_timeout'),new ChatClientError('wake_unavailable',503),new ChatClientError('too_many_connections',429)])assert.equal(needsNewChatSession(e),false);
 assert.equal(needsNewChatSession(new ChatClientError('unauthorized',401)),true);
});
