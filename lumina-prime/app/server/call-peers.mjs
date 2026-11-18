import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChatError, isPrivateAddress } from './chat-server.mjs';
import { speechChunks } from './chat-call.mjs';
import { humanInvitation, expireHuman, decideHuman, requireHuman, humanDescription } from './call-human-state.mjs';

const fail = (code, status = 400) => { throw new ChatError(code, status); };
const hash = text => createHash('sha256').update(text).digest('hex');
const hex = n => randomBytes(n).toString('hex');
const name = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 80 && !/[\r\n\x00-\x1f]/.test(value) ? value.trim() : fail('peer_name_invalid');
const speakerName = value => typeof value === 'string' && value.trim() && value.length <= 180 && !/[\r\n\x00-\x1f]/.test(value) ? value.trim() : fail('peer_name_invalid');
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value) ? value : fail('call_session_invalid');
const inboundId = (peerId, callId) => {
  const h=hash(`${peerId}:${callId}`);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
};
const list = value => Array.isArray(value) && value.length > 0 && value.length <= 8 && value.every(x => typeof x === 'string') ? [...new Set(value)] : fail('call_target_invalid');

export function peerAddress(value) {
  let url; try { url = new URL(value); } catch { fail('peer_address_invalid'); }
  // Literal IPv4 only: no DNS rebinding and no redirects to an unrelated service.
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || !isPrivateAddress(url.hostname) || url.hostname === '0.0.0.0'
    || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('peer_address_invalid');
  return url.origin;
}

// Authenticated encryption also protects transcript/audio on plain HTTP LAN links.
// The invitation carries 256 random bits, not a guessable PIN. No owner session crosses this port.
export function sealPeer(secret, id, payload) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(secret, 'hex'), iv);
  cipher.setAAD(Buffer.from(`mind.call.peer.v1:${id}`));
  const data = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return { id, iv: iv.toString('hex'), data: data.toString('base64'), tag: cipher.getAuthTag().toString('hex') };
}
export function openPeer(secret, envelope) {
  try {
    if (!/^[a-f0-9]{24}$/.test(envelope.iv) || !/^[a-f0-9]{32}$/.test(envelope.tag)) throw Error();
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(secret, 'hex'), Buffer.from(envelope.iv, 'hex'));
    decipher.setAAD(Buffer.from(`mind.call.peer.v1:${envelope.id}`)); decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString());
  } catch { fail('peer_unauthorized', 401); }
}
async function readJson(stream, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of stream) { size += chunk.length; if (size > limit) fail('body_too_large', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { fail('invalid_json'); }
}

export function createCallPeers({ call, controls = null, file = null, port = 8790, host = '0.0.0.0', now = Date.now, fetchImpl = fetch } = {}) {
  let config = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { id: randomUUID(), label: os.hostname(), caller: 'NLR', enabled: false, peers: [] };
  const invites = new Map(), incoming = new Map(), outgoing = new Map(), directory = new Map(), replays = new Map();
  let server = null, starting = null, startupError = null;
  const save = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.pending', JSON.stringify(config), { mode: 0o600 }); fs.renameSync(file + '.pending', file);
  };
  // Existing associations also share all local targets; discard old allowlists.
  const hadAllowlists = config.peers.some(p => Object.hasOwn(p, 'shared'));
  for (const p of config.peers) delete p.shared;
  if (hadAllowlists) save();
  const localTargets = () => call.targets().filter(t => t.kind !== 'remote');
  const peer = id => config.peers.find(p => p.id === id) ?? fail('peer_unknown', 404);
  const exported = () => localTargets().map(t => ({ handle: t.handle, label: t.label, kind: t.kind, channel: call.channelOf(call.resolve(t.handle)) }));
  const permitted = handles => {
    for (const h of list(handles)) if (!exported().some(t => t.handle === h)) fail('peer_target_forbidden', 403);
    return handles;
  };
  function closeIncoming(c) {
    call.endSession(c.owner,c.id,1); controls?.markEnded({ id:c.id, epoch:1 }); incoming.delete(c.key);
    replays.set(`ended:${c.key}`,now()+24*60*60_000);
  }
  function activeIncoming(p, id) {
    const c = incoming.get(`${p.id}:${uuid(id)}`);
    if (!c) fail('call_ended',410);
    if (now() - c.lastSeen > 45_000 || controls?.control({id:c.id,epoch:1})?.status === 'ended') { closeIncoming(c); fail('call_ended',410); }
    call.assertSession(c.owner,c.id,1); permitted(c.handles); c.lastSeen = now();
    call.stateSession(c.owner,c.id,1); return c;
  }
  async function dispatch(p, input) {
    if (input.op === 'directory') return { label:config.label, targets:exported(), at:now() };
    if (input.op === 'end') {
      const c = incoming.get(`${p.id}:${uuid(input.call)}`); if(c) closeIncoming(c);
      controls?.markEnded({id:inboundId(p.id,input.call),epoch:1});
      // A tombstone prevents an in-flight sync from resurrecting a hung-up call.
      replays.set(`ended:${p.id}:${input.call}`, now() + 24 * 60 * 60_000);
      return { status:'ended' };
    }
    if (input.op === 'sync') {
      if (!Number.isSafeInteger(input.revision) || input.revision < 1) fail('call_revision_invalid');
      const key = `${p.id}:${uuid(input.call)}`;
      if (replays.has(`ended:${key}`)) fail('call_ended',410);
      const handles = permitted(list(input.handles));
      let c = incoming.get(key);
      if (!c) {
        if(input.create!==true)fail('call_ended',410);
        if(incoming.size >= 32)fail('too_many_calls',429);
        c={ key, id:inboundId(p.id,input.call), owner:`peer:${p.id}`, handles, lastSeen:now(), revision:0, delivered:new Map() };
        controls?.registerCall({id:c.id,epoch:1,participants:call.identityKeys(handles)});
        call.openSession(c.owner,c.id,1,handles,{mirror:false,caller:`${p.caller} · ${p.label}`}); incoming.set(key,c);
      } else activeIncoming(p,input.call);
      if (input.revision >= c.revision) {
        let state=call.stateSession(c.owner,c.id,1);
        const additions=handles.filter(h=>!state.handles.includes(h));
        // Add/remove individually so replacing eight participants never exceeds the local limit.
        const removals=state.handles.filter(h=>!handles.includes(h));
        if (removals.length === state.handles.length) {
          // Keep one old slot until a new participant can be inserted.
          const first=removals.shift();
          if(removals.length) state=call.removeSession(c.owner,c.id,1,removals,state.revision);
          state=call.addSession(c.owner,c.id,1,[additions.shift()],state.revision);
          state=call.removeSession(c.owner,c.id,1,[first],state.revision);
        } else if(removals.length) state=call.removeSession(c.owner,c.id,1,removals,state.revision);
        if(additions.length) call.addSession(c.owner,c.id,1,additions,state.revision);
        c.handles=handles; c.revision=input.revision;
        controls?.replaceParticipants({id:c.id,epoch:1,participants:call.identityKeys(handles)});
      }
      return { status:'active', at:now(), revision:c.revision };
    }
    const c=activeIncoming(p,input.call);
    if(input.op==='human') {
      if(input.action==='invite'&&!c.human)c.human=humanInvitation(c.id,`${p.caller} · ${p.label}`,now());
      const h=c.human;if(!h)fail('call_expired',409);
      expireHuman(h,now());
      if(input.action==='offer') {
        requireHuman(h,undefined,now());const offer=humanDescription(input.description,'offer');
        if(h.offer&&h.offer.sdp!==offer.sdp)fail('human_signal_conflict',409);h.offer=offer;
      } else if(input.action==='leave'){h.status='ended';expireHuman(h,now());}
      else if(!['invite','poll'].includes(input.action))fail('invalid_request');
      return {id:h.id,status:h.status,label:`${config.caller} · ${config.label}`,answer:h.status==='accepted'?h.answer:null};
    }
    if (input.op === 'read') {
      if(!c.handles.includes(input.target))fail('call_target_not_joined',403);
      return { items:await call.sessionItems(c.owner,c.id,1,input.target) };
    }
    if (input.op === 'deliver') {
      const handles=permitted(list(input.handles));
      if(handles.some(h=>!c.handles.includes(h)))fail('call_target_not_joined',403);
      if(typeof input.text!=='string'||input.text.length>4000||typeof input.message!=='string'||input.message.length>100)fail('invalid_request');
      const key=`peer-${hash(`${p.id}:${input.call}:${input.message}`).slice(0,40)}`;
      const speaker=input.speaker?speakerName(input.speaker):`${p.caller} · ${p.label}`;
      const fingerprint=hash(JSON.stringify([handles,input.text,speaker]));
      if(c.delivered.has(key)&&c.delivered.get(key).fingerprint!==fingerprint)fail('message_conflict',409);
      if(!c.delivered.has(key)) {
        const pending=call.deliver(handles,key,input.text,{owner:c.owner,id:c.id,epoch:1,speaker});
        c.delivered.set(key,{pending,fingerprint}); pending.catch(()=>c.delivered.delete(key));
      }
      await c.delivered.get(key).pending; return {status:'delivered'};
    }
    if (input.op === 'notice') {
      if(typeof input.text!=='string'||input.text.length>1500||!input.text.startsWith('[Appel]')||typeof input.message!=='string'||input.message.length>160)fail('invalid_request');
      const ok=await call.sessionNotice(c.owner,c.id,1,input.target,`peer-copy:${hash(`${p.id}:${input.call}:${input.message}`)}`,input.text);
      if(!ok)fail('call_target_unavailable',503); return {status:'delivered'};
    }
    if (input.op === 'speech') {
      const items=await call.sessionItems(c.owner,c.id,1,input.target);
      const allowed=items.flatMap(item=>{const chunks=speechChunks(item.text);return chunks.map((_,i)=>chunks.length>1?`${item.id}~${i}`:item.id);});
      if(!allowed.includes(input.item))fail('call_reply_unknown',404);
      const audio=await call.speech(input.target,input.item,Boolean(input.announce));
      activeIncoming(p,input.call);
      if(audio.bytes.length>8*1024*1024)fail('audio_too_large',413);
      return {bytes:audio.bytes.toString('base64'),mime:audio.mime,provider:audio.provider,ms:audio.ms};
    }
    fail('not_found',404);
  }

  async function start() {
    if(server)return; if(starting)return starting;
    starting=(async()=>{
      const next=createServer(async(req,res)=>{
        const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
        try {
          if(req.method!=='POST'||req.url!=='/mind-call/v1'||req.headers.origin||!isPrivateAddress(req.socket.remoteAddress))fail('peer_forbidden',403);
          const envelope=await readJson(req,40_000);
          const invitation=invites.get(envelope.id);
          const p=config.peers.find(p=>p.id===envelope.id&&p.direction==='in');
          const secret=invitation?.secret??p?.secret;
          if(!secret)fail('peer_unauthorized',401);
          const input=openPeer(secret,envelope);
          if(typeof input.nonce!=='string'||!/^[a-f0-9]{32}$/.test(input.nonce)||!Number.isFinite(input.at)||Math.abs(now()-input.at)>120_000||replays.has(input.nonce))fail('peer_replay',409);
          if(replays.size>=20_000)fail('peer_rate_limited',429);
          replays.set(input.nonce,now()+180_000);
          let result;
          try {
            if(invitation) {
              if(input.op!=='pair'||invitation.expiresAt<now())fail('peer_invitation_expired',410);
              if(config.peers.length>=32)fail('too_many_peers',429);
              const paired={id:hex(8),secret:hex(32),direction:'in',label:name(input.label),caller:name(input.caller)};
              config.peers.push(paired);save();invites.delete(envelope.id);
              result={id:paired.id,secret:paired.secret,label:config.label,targets:exported()};
            } else result=await dispatch(p,input);
            send(200,sealPeer(secret,envelope.id,{nonce:input.nonce,result}));
          } catch(error) {send(200,sealPeer(secret,envelope.id,{nonce:input.nonce,error:error.code??'peer_unavailable',status:error.status??503}));}
        } catch(error) {send(error.status??503,{error:error.code??'peer_unavailable'});}
      });
      next.requestTimeout=15_000;next.headersTimeout=5000;
      try {await new Promise((resolve,reject)=>{next.once('error',reject);next.listen(port,host,resolve);});}
      catch {fail('peer_port_unavailable',503);}
      server=next;startupError=null;
    })().finally(()=>{starting=null;});return starting;
  }
  async function rpc(p, data, timeout = 10_000) {
    let response, nonce;
    for(let attempt=0;attempt<2;attempt++) {
      nonce=hex(16);const packet=sealPeer(p.secret,p.id,{...data,nonce,at:now()});
      try {response=await fetchImpl(`${peerAddress(p.address)}/mind-call/v1`,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(packet),signal:AbortSignal.timeout(timeout)});break;}
      catch {if(attempt||data.op==='pair'||data.op==='speech')fail('peer_unavailable',503);}
    }
    if(!response.ok)fail(response.status===401?'peer_unauthorized':'peer_unavailable',response.status===401?401:503);
    const value=openPeer(p.secret,await readJson(response.body,12*1024*1024));
    if(value.nonce!==nonce)fail('peer_unauthorized',401);
    if(value.error)fail(value.error,value.status);
    return value.result;
  }
  function cacheDirectory(p, targets) {
    if(!Array.isArray(targets))fail('invalid_response');
    for(const [h,t] of directory)if(t.peerId===p.id)directory.delete(h);
    for(const t of targets) {
      if(!/^[a-z0-9][a-z0-9_.-]{0,60}$/.test(t.handle)||!['main','room','agent','holder'].includes(t.kind)||!(/^(main|room:[2-9])$/).test(t.channel))fail('invalid_response');
      const handle=`lan-${p.id}-${hash(t.handle).slice(0,16)}`;
      directory.set(handle,{handle,label:`${name(t.label)} · ${p.label}`,kind:'remote',peerId:p.id,remoteHandle:t.handle,channel:`remote:${p.id}:${t.channel}`});
    }
    p.online=true;
  }
  async function refresh() {
    await Promise.all(config.peers.filter(p=>p.direction==='out').map(async p=>{
      try {const result=await rpc(p,{op:'directory'});cacheDirectory(p,result.targets);}
      catch {p.online=false;}
    }));
  }
  const groups = c => {
    const result=new Map();for(const {target:t} of c.targets.values())if(t.kind==='remote'){
      const slot=result.get(t.peerId)??[];slot.push(t);result.set(t.peerId,slot);
    }return result;
  };
  const outgoingFor = (target,c) => {
    const found=c?outgoing.get(`${c.id}:${target.peerId}`):null;
    if(!found)return null;call.assertSession(found.c.owner,found.c.id,found.c.epoch);return found;
  };
  async function sync(c) {
    const desired=groups(c);
    await Promise.all([...desired].map(async([id,targets])=>{
      const p=peer(id),key=`${c.id}:${id}`;
      let state=outgoing.get(key);
      if(!state){state={c,peerId:id,offset:0,revision:0};outgoing.set(key,state);}
      const result=await rpc(p,{op:'sync',call:c.id,handles:targets.map(t=>t.remoteHandle),revision:c.revision,create:state.revision===0});
      if(!state.revision)state.offset=now()-result.at;
      state.revision=Math.max(state.revision,result.revision);
      try {call.assertSession(c.owner,c.id,c.epoch);}catch(error){await rpc(p,{op:'end',call:c.id}).catch(()=>{});throw error;}
    }));
    for(const [key,state] of outgoing)if(state.c.id===c.id&&!desired.has(state.peerId)){
      outgoing.delete(key);await rpc(peer(state.peerId),{op:'end',call:c.id});
    }
  }
  const remote = {
    targets:()=>[...directory.values()].map(t=>({...t,available:peer(t.peerId).online!==false})),
    resolve:h=>directory.get(h), sync,
    end(c){for(const [key,s] of outgoing)if(s.c.id===c.id){outgoing.delete(key);rpc(peer(s.peerId),{op:'end',call:c.id}).catch(()=>{});}},
    async items(t,c) {
      const state=outgoingFor(t,c);if(!state)return [];
      const result=await rpc(peer(t.peerId),{op:'read',call:state.c.id,target:t.remoteHandle});
      call.assertSession(state.c.owner,state.c.id,state.c.epoch);
      return result.items.map(item=>({...item,id:`p${t.peerId}:${item.id}`,at:new Date(Date.parse(item.at)+state.offset).toISOString(),speaker:`${item.speaker} · ${peer(t.peerId).label}`}));
    },
    async deliver(targets,id,text,c,speaker) {
      await sync(c);
      for(const [peerId,selected] of groups({...c,targets:new Map(targets.map(t=>[t.handle,{target:t}]))})) {
        call.assertSession(c.owner,c.id,c.epoch);
        const retained=selected.filter(t=>c.targets.has(t.handle));if(!retained.length)continue;
        await rpc(peer(peerId),{op:'deliver',call:c.id,handles:retained.map(t=>t.remoteHandle),message:id,text,...(speaker?{speaker}:{})});
      }
    },
    async post(channel,key,text,c) {
      if(!c)return false;
      const t=[...c.targets.values()].map(v=>v.target).find(t=>t.channel===channel);
      if(!t)return false;
      await rpc(peer(t.peerId),{op:'notice',call:c.id,target:t.remoteHandle,message:key,text});return true;
    },
    async speech(t,item,announce,c) {
      const state=outgoingFor(t,c);if(!state)fail('call_ended',410);
      const prefix=`p${t.peerId}:`;if(!item.startsWith(prefix))fail('call_reply_unknown',404);
      const result=await rpc(peer(t.peerId),{op:'speech',call:state.c.id,target:t.remoteHandle,item:item.slice(prefix.length),announce},145_000);
      call.assertSession(state.c.owner,state.c.id,state.c.epoch);
      return {...result,bytes:Buffer.from(result.bytes,'base64')};
    },
  };
  call.attachRemote(remote);
  function guestCall(id) {
    const c=[...incoming.values()].find(c=>c.human?.id===id);if(!c)fail('call_ended',410);
    if(now()-c.lastSeen>45_000){closeIncoming(c);fail('call_ended',410);}
    call.assertSession(c.owner,c.id,1);
    if(controls?.control({id:c.id,epoch:1})?.status==='ended'){closeIncoming(c);fail('call_ended',410);}
    return c;
  }
  function humanPending() {
    for(const c of incoming.values())if(c.human&&expireHuman(c.human,now()).status==='ringing') {
      if(now()-c.lastSeen>45_000)continue;
      const {id,kind,caller,label,until}=c.human;return {id,kind,caller,label,until};
    }return null;
  }
  function humanGuest(owner,input) {
    const c=guestCall(input.id),h=c.human;
    if(input.action==='answer') {
      if(input.decision==='accept'&&[...incoming.values()].some(other=>other!==c&&other.human&&expireHuman(other.human,now()).status==='accepted'))fail('human_busy',409);
      return decideHuman(h,owner,input.decision,now());
    }
    requireHuman(h,owner,now());h.lastSeen=now();
    if(input.action==='signal') {
      if(!h.offer)fail('human_signal_invalid');
      const answer=humanDescription(input.description,'answer');
      if(h.answer&&h.answer.sdp!==answer.sdp)fail('human_signal_conflict',409);h.answer=answer;
    } else if(input.action==='leave'){h.status='left';expireHuman(h,now());}
    else if(input.action!=='poll')fail('invalid_request');
    return {id:h.id,label:h.label,status:h.status,offer:h.status==='accepted'?h.offer:null};
  }
  async function humanRequest(scope,input) {
    if(!['invite','poll','signal','leave','text'].includes(input.action))fail('invalid_request');
    if(['signal','text'].includes(input.action)&&!input.peerId)fail('invalid_request');
    const c=call.assertSession(scope.owner,scope.id,scope.epoch);
    const selected=groups(c);
    if(input.action==='invite')await sync(c);
    const states=[...outgoing.values()].filter(s=>s.c===c&&selected.has(s.peerId)&&(!input.peerId||input.peerId===s.peerId));
    if(input.peerId&&!states.length)fail('call_target_not_joined',403);
    const humans=[];
    for(const state of states) {
      if(input.action!=='invite'&&!state.humanInvited)continue;
      if(!['invite','poll','signal','leave','text'].includes(input.action))fail('invalid_request');
      const action=input.action==='signal'?'offer':input.action==='text'?'poll':input.action;
      const value=await rpc(peer(state.peerId),{op:'human',call:c.id,action,...(input.description?{description:input.description}:{})});
      call.assertSession(scope.owner,scope.id,scope.epoch);
      state.humanInvited=true;state.human=value;
      if(input.action==='text') {
        if(value.status!=='accepted')fail('call_ended',410);
        if(typeof input.text!=='string'||!input.text.trim()||input.text.length>3900)fail('invalid_request');
        uuid(input.message);
        const id=`human-${state.peerId}-${input.message}`;
        state.humanTexts??=new Map();const fingerprint=hash(input.text);
        const existing=state.humanTexts.get(id);
        if(existing&&existing.fingerprint!==fingerprint)fail('message_conflict',409);
        if(!existing) {
          const pending=call.deliver([...c.targets.keys()],id,input.text,{...scope,speaker:speakerName(value.label)});
          state.humanTexts.set(id,{pending,fingerprint});pending.catch(()=>state.humanTexts.delete(id));
        }
        await state.humanTexts.get(id).pending;
      }
      humans.push({...value,peerId:state.peerId});
    }
    return {humans};
  }
  function status() {
    const listenPort=server?.address()?.port??port;
    return {label:config.label,caller:config.caller,enabled:Boolean(server),port:listenPort,error:startupError,
      addresses:Object.values(os.networkInterfaces()).flat().filter(v=>v&&v.family==='IPv4'&&!v.internal&&isPrivateAddress(v.address)).map(v=>`http://${v.address}:${listenPort}`),
      peers:config.peers.map(({id,label,direction,address,online})=>({id,label,direction,address,online})),targets:localTargets()};
  }
  async function admin(action,input={}) {
    if(action==='status')return status();
    if(action==='profile'){config.label=name(input.label);config.caller=name(input.caller);save();return status();}
    if(action==='invite') {
      await start();config.enabled=true;save();invites.clear();
      const id=hex(8),secret=hex(32),expiresAt=now()+3_600_000;invites.set(id,{secret,expiresAt});
      return {...status(),code:`${id}.${secret}`,expiresAt};
    }
    if(action==='pair') {
      if(config.peers.length>=32)fail('too_many_peers',429);
      const match=/^([a-f0-9]{16})\.([a-f0-9]{64})$/.exec(String(input.code).trim());if(!match)fail('peer_code_invalid');
      const address=peerAddress(input.address);
      const result=await rpc({id:match[1],secret:match[2],address},{op:'pair',label:config.label,caller:config.caller});
      if(!/^[a-f0-9]{16}$/.test(result.id)||!/^[a-f0-9]{64}$/.test(result.secret))fail('invalid_response');
      const p={id:result.id,secret:result.secret,address,label:name(result.label),direction:'out'};
      config.peers.push(p);cacheDirectory(p,result.targets);save();return status();
    }
    if(action==='refresh'){await refresh();return status();}
    if(action==='revoke') {
      const p=peer(input.id);
      for(const c of [...incoming.values()])if(c.owner===`peer:${p.id}`)closeIncoming(c);
      for(const s of [...outgoing.values()])if(s.peerId===p.id)call.endSession(s.c.owner,s.c.id,s.c.epoch);
      config.peers=config.peers.filter(item=>item.id!==p.id);
      for(const [h,t] of directory)if(t.peerId===p.id)directory.delete(h);
      save();return status();
    }
    fail('invalid_request');
  }
  const timer=setInterval(()=>{
    for(const [key,until] of replays)if(until<now())replays.delete(key);
    for(const [id,invite] of invites)if(invite.expiresAt<now())invites.delete(id);
    for(const c of [...incoming.values()])if(now()-c.lastSeen>45_000)closeIncoming(c);
  },5000);timer.unref();
  return {admin,status,refresh,start,humanPending,humanGuest,humanRequest,ready:async()=>{if(config.enabled)try{await start();}catch{startupError='peer_port_unavailable';}await refresh();},
    close:async()=>{clearInterval(timer);for(const c of [...incoming.values()])closeIncoming(c);for(const s of [...outgoing.values()])remote.end(s.c);
      if(server){server.closeAllConnections();await new Promise(r=>server.close(r));server=null;}},
  };
}
