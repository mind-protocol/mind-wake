// Isolated UI preview: no live Wake data, no real agent, no owner messages.
import { createChatServer } from '../server/chat-server.mjs';
import { createCallService } from '../server/chat-call.mjs';
import { createCallPeers } from '../server/call-peers.mjs';
import { serveDesktopCall } from '../server/desktop-call-page.mjs';
import { randomUUID } from 'node:crypto';

const running=[];
for (const [label,port] of [['PC de test A',18789],['PC de test B',18790]]) {
  const messages=[],notices=[];
  const call=createCallService({mainLabel:`Agent simulé ${label.slice(-1)}`,mainAgentId:'mind',handleTable:()=>new Map(),
    mainReplies:()=>messages,sendMain:async(id,text)=>{messages.push({id,role:'agent',at:new Date().toISOString(),text:`Réponse simulée : ${text.slice(-100)}`});return {};},
    noticeMain:async(key,text)=>{notices.push({key,text});},speak:async()=>{throw Error('Preview has no voice provider');}});
  const peers=createCallPeers({call,port:0,host:'127.0.0.1'});
  await peers.admin('profile',{label,caller:'Utilisateur de test'});
  const admin=async(action,input)=>{const value=await peers.admin(action,input);return {...value,addresses:value.enabled?[`http://127.0.0.1:${value.port}`]:[]};};
  const gateway=createChatServer({bridge:{snapshot:()=>[],send:async()=>({})},call,peers:{...peers,admin},phones:{register:()=>{},setRingtoneCapabilities:()=>{},pending:()=>null},privateNetworkConnect:true,
    origins:[`http://127.0.0.1:${port}`],desktopCallPage:serveDesktopCall});
  await new Promise(r=>gateway.server.listen(port,'127.0.0.1',r));
  running.push({gateway,peers,call});
  console.log(`Preview only: http://127.0.0.1:${port}/desktop-call`);
}
if(process.env.MIND_PREVIEW_HUMAN==='1') {
  const [a,b]=running,invite=await b.peers.admin('invite',{shared:['mind']});
  await a.peers.admin('pair',{address:`http://127.0.0.1:${invite.port}`,code:invite.code});
  const scope={owner:'preview-human',id:randomUUID(),epoch:1};
  a.call.openSession(scope.owner,scope.id,1,a.call.targets().filter(t=>t.kind==='remote').map(t=>t.handle));
  await a.call.syncRemote(scope);await a.peers.humanRequest(scope,{action:'invite'});
}
async function close(){for(const {gateway,peers,call} of running){await gateway.close();await peers.close();call.stop();}}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void close().then(()=>process.exit(0));});
