import test from 'node:test';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { createCallService } from './chat-call.mjs';
import { createCallPeers, peerAddress, sealPeer, openPeer } from './call-peers.mjs';
import { createChatServer } from './chat-server.mjs';
import { openCallControls } from '../../../services/mcp/call-control-store.mjs';
import { humanInvitation, expireHuman, decideHuman, requireHuman, humanDescription } from './call-human-state.mjs';

test('human invitation expires, binds one desktop, and never exposes signalling before acceptance',()=>{
  const h=humanInvitation('one','Caller',1000);
  assert.throws(()=>requireHuman(h,'owner',1001));
  decideHuman(h,'owner','accept',1002);
  assert.throws(()=>decideHuman(h,'other','accept',1003));
  assert.throws(()=>requireHuman(h,'other',1003));
  requireHuman(h,'owner',1003);
  assert.equal(expireHuman(h,47003).status,'left');
  const late=humanInvitation('two','Caller',1000);
  assert.throws(()=>decideHuman(late,'owner','accept',61000));
  assert.equal(late.status,'expired');
  assert.throws(()=>humanDescription({type:'answer',sdp:'v=0'},'offer'));
});

test('human invite, accept, SDP relay, attributed speech, and individual hangup across two installations',async t=>{
  const {a,b,scope,open,remote}=await fixture(t);
  await open(['mind',...remote.map(t=>t.handle)]);
  assert.equal(b.peers.humanPending(),null);
  const first=await a.peers.humanRequest(scope,{action:'invite'});
  const peerId=first.humans[0].peerId,invite=b.peers.humanPending();
  assert.equal(invite.kind,'peer-human');
  assert.match(invite.label,/NLR/);
  await a.peers.humanRequest(scope,{action:'invite'});
  assert.equal(b.peers.humanPending().id,invite.id);
  const offer={type:'offer',sdp:'v=0\r\n'},answer={type:'answer',sdp:'v=0\r\n'};
  await assert.rejects(a.peers.humanRequest(scope,{action:'signal',peerId,description:offer}));
  assert.throws(()=>b.peers.humanGuest('guest',{id:invite.id,action:'poll'}));
  b.peers.humanGuest('guest',{id:invite.id,action:'answer',decision:'accept'});
  assert.equal(b.peers.humanPending(),null);
  assert.throws(()=>b.peers.humanGuest('other',{id:invite.id,action:'poll'}));
  assert.throws(()=>b.peers.humanGuest('other',{id:invite.id,action:'answer',decision:'accept'}));
  await a.peers.humanRequest(scope,{action:'signal',peerId,description:offer});
  assert.deepEqual(b.peers.humanGuest('guest',{id:invite.id,action:'poll'}).offer,offer);
  b.peers.humanGuest('guest',{id:invite.id,action:'signal',description:answer});
  assert.deepEqual((await a.peers.humanRequest(scope,{action:'poll'})).humans[0].answer,answer);
  const input={action:'text',peerId,message:randomUUID(),text:'Hello from the remote human'};
  await a.peers.humanRequest(scope,input);await a.peers.humanRequest(scope,input);
  assert.equal(a.sent.filter(m=>m.text.includes(input.text)).length,1);
  assert.equal(b.sent.filter(m=>m.text.includes(input.text)).length,2);
  assert.ok(a.sent.some(m=>m.text.includes('[Aurore · PC B]')));
  assert.ok(b.sent.some(m=>m.text.includes('[Aurore · PC B]')));
  await assert.rejects(a.peers.humanRequest(scope,{...input,text:'Changed'}),e=>e.code==='message_conflict');
  b.peers.humanGuest('guest',{id:invite.id,action:'leave'});
  assert.equal((await a.peers.humanRequest(scope,{action:'poll'})).humans[0].status,'left');
  assert.equal(b.call.active().length,1);
  await assert.rejects(a.peers.humanRequest(scope,{...input,message:randomUUID()}));
});

test('human refusal and caller hangup leave no reusable invitation',async t=>{
  const {a,b,scope,open,remote}=await fixture(t);
  await open([remote[0].handle]);await a.peers.humanRequest(scope,{action:'invite'});
  const invite=b.peers.humanPending();
  b.peers.humanGuest('guest',{id:invite.id,action:'answer',decision:'decline'});
  assert.equal((await a.peers.humanRequest(scope,{action:'poll'})).humans[0].status,'declined');
  assert.equal(b.call.active().length,1);
  a.call.endSession(scope.owner,scope.id,1);
  await new Promise(r=>setTimeout(r,30));
  assert.throws(()=>b.peers.humanGuest('guest',{id:invite.id,action:'poll'}));
  assert.equal(b.peers.humanPending(),null);
});

test('human invitation HTTP is authenticated, desktop-only, and binds the accepting session',async t=>{
  const {a,b,open,scope,remote}=await fixture(t);
  await open([remote[0].handle]);await a.peers.humanRequest(scope,{action:'invite'});
  const gateway=createChatServer({bridge:{snapshot:()=>[],send:async()=>({})},call:b.call,controls:b.controls,peers:b.peers,privateNetworkConnect:true,pairingCode:'human-invitation-test-code'});
  await new Promise(r=>gateway.server.listen(0,'127.0.0.1',r));t.after(()=>gateway.close());
  const base=`http://127.0.0.1:${gateway.server.address().port}`;
  async function headers(){const pair=await (await fetch(base+'/chat/connect-local',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json();return {Authorization:`Bearer ${pair.token}`,'Content-Type':'application/json'};}
  assert.equal((await fetch(base+'/chat/phone/pending?desktop=1')).status,401);
  const first=await headers(),second=await headers();
  const {invite}=await (await fetch(base+'/chat/phone/pending?desktop=1',{headers:first})).json();assert.equal(invite.kind,'peer-human');
  const action=(h,action,extra={})=>fetch(base+'/chat/call/human-guest',{method:'POST',headers:h,body:JSON.stringify({action,id:invite.id,...extra})});
  assert.equal((await action(first,'poll')).status,410);
  assert.equal((await action(first,'answer',{decision:'accept'})).status,200);
  assert.equal((await action(second,'poll')).status,403);
  assert.equal((await action(first,'poll')).status,200);
  assert.equal((await action(first,'leave')).status,200);
  assert.equal(b.call.active().length,1);
});

async function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mind-call-peers-'));
  function install(label) {
    const main=[],room=[],notices=[],sent=[],handles=new Map([['room3',{room:3,agent:null,label:'Room 3'}]]);
    const call=createCallService({mainLabel:label,mainAgentId:'marco',mirrorIntervalMs:0,
      handleTable:()=>handles,
      mainReplies:()=>main,roomEntries:()=>room,sendMain:async(id,text)=>{sent.push({id,text});return {};},
      routeHandle:async(handle,text,id)=>{sent.push({id,text,handle});return {status:'routed'};},
      noticeMain:async(key,text)=>{if(!notices.some(n=>n.key===key))notices.push({key,text,channel:'main'});},
      noticeRoom:async(n,key,text)=>{if(!notices.some(n=>n.key===key))notices.push({key,text,channel:`room:${n}`});},
      speak:async text=>({bytes:Buffer.from(`RIFF${text}`),mime:'audio/wav',provider:'test'})});
    const data=path.join(dir,label);fs.mkdirSync(data);
    const controls=openCallControls(data);
    const file=path.join(dir,`${label}.json`), peers=createCallPeers({call,controls,file,port:0,host:'127.0.0.1'});
    return {call,peers,controls,main,room,notices,sent,file,handles};
  }
  const a=install('Alpha'),b=install('Beta');
  t.after(async()=>{await a.peers.close();await b.peers.close();a.call.stop();b.call.stop();a.controls.close();b.controls.close();fs.rmSync(dir,{recursive:true,force:true});});
  await a.peers.admin('profile',{label:'PC A',caller:'NLR'});
  await b.peers.admin('profile',{label:'PC B',caller:'Aurore'});
  const invite=await b.peers.admin('invite');
  const address=`http://127.0.0.1:${invite.port}`;
  await a.peers.admin('pair',{address,code:invite.code});
  const remote=a.call.targets().filter(t=>t.kind==='remote');
  const scope={owner:'desktop-owner',id:randomUUID(),epoch:1};
  const open=async handles=>{a.call.openSession(scope.owner,scope.id,1,handles);await a.call.syncRemote(scope);};
  return {a,b,address,invite,scope,open,remote};
}

test('all targets are shared, including future targets and formerly restricted associations',async t=>{
  const {a,b,open}=await fixture(t);
  assert.deepEqual(a.call.targets().filter(t=>t.kind==='remote').map(t=>t.remoteHandle).sort(),['mind','room3']);
  const port=b.peers.status().port;
  await b.peers.close();
  const legacy=JSON.parse(fs.readFileSync(b.file));legacy.peers[0].shared=['mind'];fs.writeFileSync(b.file,JSON.stringify(legacy));
  b.peers=createCallPeers({call:b.call,controls:b.controls,file:b.file,port,host:'127.0.0.1'});await b.peers.ready();
  b.handles.set('room4',{room:4,agent:null,label:'New room'});
  await a.peers.refresh();
  const targets=a.call.targets().filter(t=>t.kind==='remote');
  assert.deepEqual(targets.map(t=>t.remoteHandle).sort(),['mind','room3','room4']);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(b.file)).peers[0],'shared'),false);
  await open([targets.find(t=>t.remoteHandle==='room4').handle]);
  assert.equal(b.call.active().length,1);
});

test('two installations: pairing, pre-call notice, human delivery, all agent messages mirrored once and remote voice',async t=>{
  const {a,b,scope,open,remote}=await fixture(t);
  b.main.push({id:'old',role:'agent',at:'2020-01-01T00:00:00Z',text:'Private history'});
  await open(['mind',...remote.map(t=>t.handle)]);
  await new Promise(r=>setTimeout(r,5));
  assert.ok(b.notices.some(n=>n.text.includes("NLR · PC A t'appelle")));
  const c=a.call.assertSession(scope.owner,scope.id,1);
  await a.call.deliver([...c.targets.keys()],'chat-test','Bonjour',scope);
  await a.call.deliver([...c.targets.keys()],'chat-test','Bonjour',scope);
  assert.equal(b.sent.filter(n=>n.text.includes('Bonjour')).length,2); // one main + one room, no duplicate retry
  const at=new Date(Date.now()+20).toISOString();
  a.main.push({id:'same',role:'agent',at,text:'Alpha répond.'});
  b.main.push({id:'same',role:'agent',at,text:'Beta répond.'});
  b.room.push({id:1,role:'agent',at,text:'La room répond.'});
  await a.call.mirrorTick();await a.call.mirrorTick();await b.call.mirrorTick();
  assert.equal(a.notices.filter(n=>n.text.includes('Beta répond.')).length,1);
  assert.equal(a.notices.filter(n=>n.text.includes('La room répond.')).length,1);
  assert.equal(b.notices.filter(n=>n.text.includes('Alpha répond.')).length,2);
  assert.equal(b.notices.filter(n=>n.channel==='room:3'&&n.text.includes('Beta répond.')).length,1);
  assert.equal(b.notices.filter(n=>n.channel==='main'&&n.text.includes('La room répond.')).length,1);
  assert.ok(!a.notices.some(n=>n.text.includes('Private history')));
  const r=remote.find(t=>t.remoteHandle==='mind');
  const replies=await a.call.replies(r.handle,'2020-01-01T00:00:00Z',scope);
  assert.equal(replies.length,1);assert.equal(replies[0].speaker,'Beta · PC B');
  const audio=await a.call.speech(r.handle,replies[0].id,false,scope);
  assert.match(audio.bytes.toString(),/Beta répond/);
  a.call.endSession(scope.owner,scope.id,1);
  await new Promise(r=>setTimeout(r,30));
  assert.equal(b.call.active().length,0);
  assert.deepEqual(await a.call.replies(r.handle,'2020-01-01T00:00:00Z'),[]);
});

test('removed recipients stop receiving copies; revocation ends inbound call and access',async t=>{
  const {a,b,scope,open,remote}=await fixture(t);
  await open(['mind',...remote.map(t=>t.handle)]);
  const r=remote.find(t=>t.remoteHandle==='room3');
  a.call.removeSession(scope.owner,scope.id,1,[r.handle],1);await a.call.syncRemote(scope);
  a.main.push({id:'after',role:'agent',at:new Date(Date.now()+10).toISOString(),text:'Après retrait.'});
  await a.call.mirrorTick();
  assert.ok(!b.notices.some(n=>n.channel==='room:3'&&n.text.includes('Après retrait')));
  await b.peers.admin('revoke',{id:b.peers.status().peers[0].id});
  assert.equal(b.call.active().length,0);
  await assert.rejects(a.call.syncRemote(scope));
});

test('inbound credentials cannot read history or an unjoined target, forge speech, or replay requests',async t=>{
  const {a,address,scope,open,remote}=await fixture(t);
  await open([remote.find(t=>t.remoteHandle==='mind').handle]);
  const p=JSON.parse(fs.readFileSync(a.file)).peers[0];
  async function request(input,packet) {
    const nonce=randomBytes(16).toString('hex');
    const body=packet??sealPeer(p.secret,p.id,{...input,nonce,at:Date.now()});
    const res=await fetch(`${address}/mind-call/v1`,{method:'POST',body:JSON.stringify(body)});
    const json=await res.json();return {status:res.status,value:json.data?openPeer(p.secret,json):json,packet:body};
  }
  const forbidden=await request({op:'read',call:scope.id,target:'room3'});
  assert.equal(forbidden.value.error,'call_target_not_joined');
  const history=await request({op:'read',call:randomUUID(),target:'mind'});
  assert.equal(history.value.error,'call_ended');
  const speech=await request({op:'speech',call:scope.id,target:'mind',item:'m:old'});
  assert.equal(speech.value.error,'call_reply_unknown');
  const replay=await request({},forbidden.packet);assert.equal(replay.status,409);
  const owner=await fetch(`${address}/chat/messages`);assert.equal(owner.status,403);
  await request({op:'end',call:scope.id});
  const late=await request({op:'sync',call:scope.id,handles:['mind'],revision:2});assert.equal(late.value.error,'call_ended');
});

test('private addresses only; encryption authenticates content and identity',()=>{
  for(const address of ['http://example.com','http://8.8.8.8','http://127.0.0.1/a','http://u:p@192.168.1.2','http://0.0.0.0'])assert.throws(()=>peerAddress(address));
  assert.equal(peerAddress('http://192.168.1.2:8790'),'http://192.168.1.2:8790');
  const key=randomBytes(32).toString('hex'),packet=sealPeer(key,'one',{text:'Secret'});
  assert.ok(!JSON.stringify(packet).includes('Secret'));assert.deepEqual(openPeer(key,packet),{text:'Secret'});
  assert.throws(()=>openPeer(key,{...packet,id:'two'}));
});

test('desktop HTTP lifecycle forwards scoped replies and honors a remote agent hang-up',async t=>{
  const {a,b,remote}=await fixture(t);
  const code='desktop-test-pairing-code';
  const gateway=createChatServer({bridge:{snapshot:()=>[],send:async()=>({})},call:a.call,controls:a.controls,peers:a.peers,pairingCode:code});
  await new Promise(r=>gateway.server.listen(0,'127.0.0.1',r));
  t.after(()=>gateway.close());
  const base=`http://127.0.0.1:${gateway.server.address().port}`;
  const pair=await (await fetch(base+'/chat/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})})).json();
  const headers={Authorization:`Bearer ${pair.token}`,'Content-Type':'application/json'};
  const h=remote.find(t=>t.remoteHandle==='mind').handle,id=randomUUID(),query=`call=${id}&epoch=1`;
  const opened=await fetch(`${base}/chat/call/session?${query}&target=${h}`,{method:'POST',headers});assert.equal(opened.status,200);
  b.main.push({id:'http',role:'agent',at:new Date(Date.now()+5).toISOString(),text:'Réponse HTTP.'});
  const items=await (await fetch(`${base}/chat/call/replies?${query}&target=${h}&since=2020-01-01T00:00:00Z`,{headers})).json();
  assert.equal(items.items[0].text,'Réponse HTTP.');
  const noScope=await (await fetch(`${base}/chat/call/replies?target=${h}&since=2020-01-01T00:00:00Z`,{headers})).json();assert.deepEqual(noScope.items,[]);
  const remoteCall=b.controls.listForCaller('mind')[0];assert.ok(remoteCall);
  b.controls.requestHangup({id:remoteCall.id,epoch:1,caller:'mind'});
  const state=await fetch(`${base}/chat/call/session?${query}`,{headers});assert.equal(state.status,410);
  const denied=await fetch(`${base}/chat/call/peers`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'status'})});assert.equal(denied.status,401);
});

test('persistent association survives gateway restart; ended calls cannot resurrect',async t=>{
  const {a,b,remote,scope,open}=await fixture(t);
  await open([remote[0].handle]);
  const port=b.peers.status().port;
  await b.peers.close();
  b.peers=createCallPeers({call:b.call,controls:b.controls,file:b.file,port,host:'127.0.0.1'});
  await b.peers.ready();await a.peers.refresh();
  assert.equal(a.peers.status().peers[0].online,true);
  await assert.rejects(a.call.syncRemote(scope),error=>error.code==='call_ended');
  const next={owner:scope.owner,id:randomUUID(),epoch:1};
  a.call.openSession(next.owner,next.id,1,[remote[0].handle]);await a.call.syncRemote(next);
  assert.equal(b.call.active().length,1);
});
