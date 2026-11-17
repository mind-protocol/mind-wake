import { inheritedCallOverrides } from './human-call-capability.js';
import {openStore} from "../store/index.js";
import {controlDbPath} from "../daemon/paths.js";
import {DEFAULT_PROFILE_ID,DEFAULT_AGENT_ID} from "../cli/context.js";
import {describe,it,expect,vi} from 'vitest';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {callMcpConfig,callCodexOverrides,humanCallServer,roomCallIdentity,callContract} from './human-call-capability.js';
import {claudeRunArgs} from '../adapters/claude/command.js';import {buildAppServerCommand} from '../adapters/codex/command.js';
import {forkOwnerMcpConfig,roomAgentMcpConfig,validateAssignment,runAssignedClaudeTurn} from '../daemon/fork-assignment.js';import {roleMcpServers,roleWebSearchConfig} from '../daemon/codex-role-turn.js';
import {fastReplyArgs} from './fast-reply.js';import {registerCallOnly} from '../../services/mcp/human-call-main.js';import type {McpServer} from '@modelcontextprotocol/server';
const dataDir=path.join(os.tmpdir(),'mind-call-test-data');const identity={dataDir,signature:'Agent test'};
const servers=(text:string)=>JSON.parse(text).mcpServers as Record<string,Record<string,unknown>>;
describe('same minimal call contract on real launcher builders',()=>{
 it('registers exactly the call contract, with host identity and no owner publishing tools',()=>{
  const names:string[]=[];registerCallOnly({registerTool:(name:string)=>names.push(name)} as unknown as McpServer,{MIND_WAKE_DATA_DIR:dataDir,MIND_WAKE_OWNER_MESSAGES:'1',MIND_WAKE_OWNER_SIGNATURE:'Agent test'});
  expect(names.sort()).toEqual(['call_human','hangup_call','list_active_calls']);
  const server=humanCallServer(identity);expect(server['env']).toMatchObject({MIND_WAKE_OWNER_SIGNATURE:'Agent test'});expect(JSON.stringify(server)).not.toContain('colony');
 });
 it('adds calls to a formerly tool-less role without creating an owner channel',()=>{
  const cfg=servers(callMcpConfig(undefined,identity));expect(Object.keys(cfg)).toEqual(['mind_calls']);expect(cfg['mind_calls']?.['env']).toMatchObject({MIND_WAKE_OWNER_MESSAGES:'1'});
  const required=roleMcpServers(cfg);expect(required['mind_calls']).toMatchObject({required:true,startup_timeout_sec:30});
 });
 it('preserves existing owner MCP and its tool restrictions, without duplicate invitations paths',()=>{
  const existing={mcpServers:{mind:{command:'node',args:[path.resolve('services/mcp/fork-owner-main.ts')],env:{MIND_WAKE_OWNER_MESSAGES:'1',MIND_WAKE_DATA_DIR:dataDir,MIND_WAKE_OWNER_SIGNATURE:identity.signature},disabled_tools:['call_human']}}};
  expect(JSON.parse(callMcpConfig(JSON.stringify(existing),identity))).toEqual(existing);
 });
 it('uses the same minimal server from Claude and Codex builders',()=>{
  const args=claudeRunArgs({model:'test',systemPromptFile:'prompt.md',tools:[],permission:'skip_permissions_unsandboxed',session:{mode:'new',id:'session'},humanCall:identity});
  const ci=args.indexOf('--mcp-config');expect(ci).toBeGreaterThan(0);expect(Object.keys(servers(args[ci+1]!))).toEqual(['mind_calls']);
  const command=buildAppServerCommand({executable:{path:'codex'},codexHome:path.join(os.tmpdir(),'mind-test-code-x-home'),workspaceDir:dataDir,channel:null,humanCall:identity});
  expect(command.args).toContain('mcp_servers.mind_calls.required=true');expect(command.args.some(x=>x.includes('MIND_WAKE_OWNER_SIGNATURE')&&x.includes('Agent test'))).toBe(true);
 });
 it('exposes calls from formerly unconfigured room 4/5, preserving canonical role identity',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'calls-room-'));try{const file=path.join(tmp,'role.md');fs.writeFileSync(file,'role');for(const id of [4,5]){const a=validateAssignment({instructions:file,workspace:tmp,name:'Leader test'});const cfg=forkOwnerMcpConfig(id,tmp,process.execPath,path.resolve('.'),a);expect(cfg).toBeDefined();expect(Object.keys(servers(cfg!))).toEqual(['mind_calls']);}}
  finally{fs.rmSync(tmp,{recursive:true,force:true});}
 });
 it('keeps room agent owner identity and makes fast replies/holders call capable explicitly',()=>{
  const cfg=roomAgentMcpConfig(3,dataDir,{id:'selection',name:'Selection',tools:'read',owner:{profile:'publish',colony:'c.json'}} as never,process.execPath,path.resolve('.'));
  expect(servers(cfg!)['mind']?.['env']).toMatchObject({MIND_WAKE_OWNER_SIGNATURE:'Selection'});
  const args=fastReplyArgs('test','prompt.md',identity);expect(servers(args[args.indexOf('--mcp-config')+1]!)['mind_calls']).toBeDefined();expect(fastReplyArgs('test','router.md')).not.toContain('--mcp-config');
  expect(roomCallIdentity(dataDir,0).signature).toBe('Coach');
 });
});

describe('installed path and inherited contract',()=>{
 it('resolves source and compiled service entries and refuses an incomplete install',()=>{
  const repo=fs.mkdtempSync(path.join(os.tmpdir(),'call-install-'));try{const dir=path.join(repo,'services/mcp');fs.mkdirSync(dir,{recursive:true});const source=path.join(dir,'human-call-main.ts');fs.writeFileSync(source,'');expect(humanCallServer(identity,{repoDir:repo})['args']).toContain(source);fs.unlinkSync(source);const compiled=path.join(dir,'human-call-main.js');fs.writeFileSync(compiled,'');expect(humanCallServer(identity,{repoDir:repo})['args']).toEqual([compiled]);fs.unlinkSync(compiled);expect(()=>humanCallServer(identity,{repoDir:repo})).toThrow('missing');}finally{fs.rmSync(repo,{recursive:true,force:true});}
 });
 it('reuses the installed principal wrapper and gives a different role one correctly attributed call route',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'owned-call-'));try{const data=path.join(tmp,'data'),home=path.join(tmp,'home'),install=path.join(data,'installation');fs.mkdirSync(install,{recursive:true});fs.mkdirSync(home);const wrapper=path.join(install,'mcp.mjs');fs.writeFileSync(wrapper,"await startLocal(manifestFile,'agent');");fs.writeFileSync(path.join(install,'manifest.json'),JSON.stringify({repoDir:path.resolve('.'),dataDir:data}));fs.writeFileSync(path.join(home,'config.toml'),'[mcp_servers.owned]\ncommand="node"\nargs='+JSON.stringify([wrapper])+'\n');
 const main=callCodexOverrides({dataDir:data,signature:'Marco'},home);expect(main).toMatchObject({'mcp_servers.owned.required':'true','mcp_servers.owned.startup_timeout_sec':'30'});expect(Object.keys(main).filter(key=>key.endsWith('.approval_mode')).sort()).toEqual(['call_human','hangup_call','list_active_calls'].map(tool=>'mcp_servers.owned.tools.'+tool+'.approval_mode'));
 const role=callCodexOverrides({dataDir:data,signature:'Coach'},home);expect(role['mcp_servers.mind_calls.required']).toBe('true');expect(role['mcp_servers.owned.disabled_tools']).toContain('call_human');
 fs.appendFileSync(path.join(home,'config.toml'),'disabled_tools=["call_human"]\n');expect(callCodexOverrides({dataDir:data,signature:'Coach'},home)).toEqual({});
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
 });
});

it('carries the minimal server through the actual formerly tool-less assigned-role turn',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'call-real-turn-'));try{const file=path.join(tmp,'role.md');fs.writeFileSync(file,'Role');const assignment=validateAssignment({instructions:file,workspace:tmp,name:'Leader test'});const state=new Map<string,string>();let received:string|undefined;
 const result=await runAssignedClaudeTurn({dataDir:tmp,dir:path.join(tmp,'fork'),id:4,assignment,store:{get:key=>state.get(key)??null,set:(key,value)=>void state.set(key,value)},message:'Text verification only',control:()=> 'run',history:()=>[],turn:async input=>{received=input.mcpConfig;return{outcome:'completed',sessionConfirmed:true,text:'verified',tokens:1,retryAtMs:null,detail:null};}});
 expect(result.outcome).toBe('completed');const cfg=servers(received!);expect(Object.keys(cfg)).toEqual(['mind_calls']);expect(cfg['mind_calls']?.['env']).toMatchObject({MIND_WAKE_OWNER_SIGNATURE:'Leader test (Room 4)'});
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

it('keeps a native role to its explicit MCP list without changing built-in permissions',()=>{
 const args=claudeRunArgs({model:'test',systemPromptFile:'prompt.md',tools:[],nativeCapabilities:true,strictMcpConfig:true,permission:'skip_permissions_unsandboxed',session:{mode:'new',id:'session'},humanCall:identity});
 expect(args.filter(x=>x==='--strict-mcp-config')).toHaveLength(1);expect(args).toContain('--mcp-config');expect(args).toContain('--dangerously-skip-permissions');
});

it('preauthorizes only the three MCP call tools for fast replies and holder invocations',()=>{
 const args=fastReplyArgs('test','prompt.md',identity);const allowed=args[args.indexOf('--allowedTools')+1];expect(allowed?.split(',').sort()).toEqual(['mcp__mind_calls__call_human','mcp__mind_calls__hangup_call','mcp__mind_calls__list_active_calls']);expect(args).not.toContain('--dangerously-skip-permissions');expect(fastReplyArgs('test','router.md')).not.toContain('--allowedTools');
});
it.each([{state:'paused',locked:false},{state:'stopped',locked:false},{state:'running',locked:true}])('refuses ringing before opening the call database when Wake is %s',async({state,locked})=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'call-stop-'));try{const store=openStore(controlDbPath(tmp));store.uow.profiles.create({id:DEFAULT_PROFILE_ID,agentId:DEFAULT_AGENT_ID,state:state as never,activePolicyRevisionId:null,nextWakeAt:null,emergencyStopLocked:locked,stateReason:'test stop control',updatedAt:new Date().toISOString() as never});store.close();const handlers=new Map<string,(args:object)=>unknown>();registerCallOnly({registerTool:(name:string,_config:unknown,handler:(args:object)=>unknown)=>handlers.set(name,handler)} as unknown as McpServer,{MIND_WAKE_DATA_DIR:tmp,MIND_WAKE_OWNER_MESSAGES:'1',MIND_WAKE_OWNER_SIGNATURE:'Test role'});const result=await handlers.get('call_human')!({}) as {isError?:boolean};expect(result.isError).toBe(true);expect(fs.existsSync(path.join(tmp,'mobile-calls.sqlite'))).toBe(false);}finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

it('preserves all legitimate global MCPs of the native principal Claude without an explicit config',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'principal-global-'));try{
  const config={mcpServers:{owner:{command:'node',args:[path.resolve('services/mcp/server-main.ts')],env:{MIND_WAKE_OWNER_MESSAGES:'1',MIND_WAKE_DATA_DIR:dataDir,MIND_WAKE_OWNER_SIGNATURE:'Marco'}},legitimate:{command:'other-provider',args:['third-party.js']}}};const file=path.join(home,'.claude.json');fs.writeFileSync(file,JSON.stringify(config));vi.spyOn(os,'homedir').mockReturnValue(home);
  const args=claudeRunArgs({model:'test',systemPromptFile:'prompt.md',tools:['Bash','Read'],nativeCapabilities:true,permission:'skip_permissions_unsandboxed',session:{mode:'new',id:'session'},humanCall:{dataDir,signature:'Marco'}});
  expect(args).not.toContain('--strict-mcp-config');expect(args).not.toContain('--mcp-config');expect(args[args.indexOf('--tools')+1]).toBe('default');expect(JSON.parse(fs.readFileSync(file,'utf8'))).toEqual(config);
 }finally{vi.restoreAllMocks();fs.rmSync(home,{recursive:true,force:true});}
});
it.each(['claude','codex'] as const)('reloads the changed prompt on the actual Claude path for a declared %s role only when its digest changes',async engine=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'all-prompt-reload-'));try{const file=path.join(tmp,'role.md');fs.writeFileSync(file,'first');const assignment=validateAssignment({instructions:file,workspace:tmp,name:'Leader test',engine});const state=new Map<string,string>();const runs:{id:string;mode:string}[]=[];const run=()=>runAssignedClaudeTurn({dataDir:tmp,dir:path.join(tmp,'fork'),id:4,assignment,store:{get:k=>state.get(k)??null,set:(k,v)=>void state.set(k,v)},message:'verification text only',control:()=> 'run',history:()=>[],turn:async input=>{runs.push({id:input.session.id,mode:input.session.mode});return{outcome:'completed',sessionConfirmed:true,text:'verified',tokens:1,retryAtMs:null,detail:null};}});
 await run();await run();expect(runs[1]).toEqual({id:runs[0]!.id,mode:'resume'});fs.writeFileSync(file,'second');await run();expect(runs[2]!.mode).toBe('new');expect(runs[2]!.id).not.toBe(runs[0]!.id);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

it('honors effective Codex launcher restrictions without adding a second call route',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'call-effective-'));try{
  const data=path.join(tmp,'data'),home=path.join(tmp,'home'),install=path.join(data,'installation');fs.mkdirSync(install,{recursive:true});fs.mkdirSync(home);
  const wrapper=path.join(install,'mcp.mjs');fs.writeFileSync(wrapper,"await startLocal(manifestFile,'agent');");fs.writeFileSync(path.join(install,'manifest.json'),JSON.stringify({repoDir:path.resolve('.'),dataDir:data}));
  fs.writeFileSync(path.join(home,'config.toml'),'[mcp_servers.owned]\ncommand="node"\nargs='+JSON.stringify([wrapper])+'\n');
  for(const restriction of [{'mcp_servers.owned.disabled_tools':'["call_human"]'},{'mcp_servers.owned.enabled_tools':'["list_active_calls"]'},{'mcp_servers.owned.enabled':'false'}]){
   const command=buildAppServerCommand({executable:{path:'codex'},codexHome:home,workspaceDir:data,channel:null,nativeCapabilities:true,humanCall:{dataDir:data,signature:'Coach'},extraConfig:restriction});
   expect(command.args.some(arg=>arg.startsWith('mcp_servers.mind_calls.'))).toBe(false);
   for(const [key,value]of Object.entries(restriction))expect(command.args).toContain(key+'='+value);
  }
  expect(callCodexOverrides({dataDir:data,signature:'Coach'},undefined,{'mcp_servers.mind_calls.disabled_tools':'["call_human"]'})).toEqual({});
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

it('replaces an inherited minimal route with the host role identity without disabling its own tools',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'call-minimal-host-'));try{
  fs.writeFileSync(path.join(home,'config.toml'),'[mcp_servers.mind_calls]\ncommand="node"\nargs='+JSON.stringify([path.resolve('services/mcp/human-call-main.ts')])+'\n[mcp_servers.mind_calls.env]\nMIND_WAKE_OWNER_MESSAGES="1"\nMIND_WAKE_DATA_DIR='+JSON.stringify(dataDir)+'\nMIND_WAKE_OWNER_SIGNATURE="Marco"\n');
  const role=callCodexOverrides(identity,home);
  expect(role['mcp_servers.mind_calls.required']).toBe('true');expect(role['mcp_servers.mind_calls.disabled_tools']).toBeUndefined();expect(role['mcp_servers.mind_calls.env']).toContain('Agent test');
  expect(()=>callCodexOverrides(identity,undefined,{'mcp_servers.mind_calls.command':'"other-server"','mcp_servers.mind_calls.args':'["unknown.js"]'})).toThrow('already owned');
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});

describe('call provider host identity boundary',()=>{
 const main={dataDir,signature:'Marco'};
 const direct=(dir:string,signature?:string)=>({command:'node',args:[path.resolve('services/mcp/server-main.ts')],env:{MIND_WAKE_OWNER_MESSAGES:'1',MIND_WAKE_DATA_DIR:dir,...(signature===undefined?{}:{MIND_WAKE_OWNER_SIGNATURE:signature})}});
 it.each([
  {label:'another profile',server:direct(path.join(dataDir,'other-profile'),'Marco')},
  {label:'VOX under the same profile',server:direct(dataDir,'VOX')},
  {label:'another installed wrapper',server:{command:'node',args:[path.join(dataDir,'other-profile/installation/mcp.mjs')]}}
 ])('refuses $label rather than reusing it or adding a route around it',({server})=>{
  expect(callContract(server,main)).toBe('foreign');
  expect(()=>callMcpConfig(JSON.stringify({mcpServers:{owner:server}}),main)).toThrow('another host profile or identity');
  expect(()=>callMcpConfig(JSON.stringify({mcpServers:{owner:{...server,disabled_tools:['call_human']}}}),main)).toThrow('another host profile or identity');
 });
 it('reuses a role own direct provider and accepts the actual absent-signature Marco default',()=>{
  const selection={dataDir,signature:'Selection'},server=direct(dataDir,'Selection');
  const original={mcpServers:{owner:server}};
  expect(callContract(server,selection)).toBe('provided');expect(JSON.parse(callMcpConfig(JSON.stringify(original),selection))).toEqual(original);
  expect(callContract(direct(dataDir),main)).toBe('provided');expect(callContract(direct(dataDir),{dataDir,signature:'Coach'})).toBe('foreign');
 });
 it('does not silently reuse a foreign global provider for principal Claude',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'claude-call-identity-'));try{
   fs.writeFileSync(path.join(home,'.claude.json'),JSON.stringify({mcpServers:{owner:direct(dataDir,'VOX')}}));vi.spyOn(os,'homedir').mockReturnValue(home);
   expect(()=>claudeRunArgs({model:'test',systemPromptFile:'prompt.md',tools:[],nativeCapabilities:true,permission:'skip_permissions_unsandboxed',session:{mode:'new',id:'session'},humanCall:main})).toThrow('another host profile or identity');
  }finally{vi.restoreAllMocks();fs.rmSync(home,{recursive:true,force:true});}
 });
 it('reroutes an inherited same-profile parent for Codex while refusing another profile',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'codex-call-identity-'));try{
   const write=(dir:string)=>fs.writeFileSync(path.join(home,'config.toml'),'[mcp_servers.parent]\ncommand="node"\nargs='+JSON.stringify([path.resolve('services/mcp/server-main.ts')])+'\n[mcp_servers.parent.env]\nMIND_WAKE_OWNER_MESSAGES="1"\nMIND_WAKE_DATA_DIR='+JSON.stringify(dir)+'\nMIND_WAKE_OWNER_SIGNATURE="Marco"\n');
   write(dataDir);const result=callCodexOverrides({dataDir,signature:'Coach'},home);expect(result['mcp_servers.mind_calls.env']).toContain('Coach');expect(result['mcp_servers.parent.disabled_tools']).toContain('call_human');
   write(path.join(dataDir,'other-profile'));expect(()=>callCodexOverrides({dataDir,signature:'Coach'},home)).toThrow('another host profile or identity');
  }finally{fs.rmSync(home,{recursive:true,force:true});}
 });
 it('reads literal strings, comments and multiline trailing-comma arrays without bypassing restrictions',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'codex-call-toml-'));try{
   const wrapper=path.join(dataDir,'installation/mcp.mjs').replaceAll('\\','/');
   fs.mkdirSync(path.dirname(wrapper),{recursive:true});fs.writeFileSync(wrapper,"await startLocal(manifestFile,'agent');");fs.writeFileSync(path.join(dataDir,'installation/manifest.json'),JSON.stringify({repoDir:path.resolve('.'),dataDir}));
   const base="[mcp_servers.'owner'] # comment\ncommand = 'node'\nargs = [\n '"+wrapper+"', # comment\n]\n";
   fs.writeFileSync(path.join(home,'config.toml'),base);
   expect(inheritedCallOverrides(dataDir,home)['mcp_servers.owner.required']).toBe('true');
   for(const suffix of ["disabled_tools = [\n 'call_human',\n] # explicit restriction\n", "enabled_tools = ['list_active_calls'] # restriction\n", "[mcp_servers.owner.tools.call_human]\napproval_mode = 'reject' # restriction\n", "tools = {call_human = {enabled = false}}\n"]){
    fs.writeFileSync(path.join(home,'config.toml'),base+suffix);expect(inheritedCallOverrides(dataDir,home)).toEqual({});
   }
   fs.writeFileSync(path.join(home,'config.toml'),base+"disabled_tools = unsupported\n");expect(()=>inheritedCallOverrides(dataDir,home)).toThrow('host review');
   fs.writeFileSync(path.join(home,'config.toml'),base+"[mcp_servers.unrelated]\ncommand = unsupported\nargs = ['unrelated-tool']\n");expect(inheritedCallOverrides(dataDir,home)['mcp_servers.owner.required']).toBe('true');
  }finally{fs.rmSync(home,{recursive:true,force:true});}
 });
});

it('preauthorizes exactly the three call tools on effective Codex role configs, preserving unrelated tools and filters',()=>{
 const server={...humanCallServer(identity),tools:{unrelated:{approval_mode:'prompt'}}};
 const prepared=roleMcpServers({mind_calls:server},dataDir)['mind_calls'] as Record<string,unknown>;
 expect(prepared['tools']).toEqual({unrelated:{approval_mode:'prompt'},call_human:{approval_mode:'approve'},list_active_calls:{approval_mode:'approve'},hangup_call:{approval_mode:'approve'}});
 expect(prepared).not.toHaveProperty('default_tools_approval_mode');
 const restricted={...server,disabled_tools:['call_human']};expect((roleMcpServers({mind_calls:restricted},dataDir)['mind_calls'] as Record<string,unknown>)['tools']).toBe(server.tools);
 expect(()=>roleMcpServers({mind_calls:server},path.join(dataDir,'another-profile'))).toThrow('another host profile');
 const command=buildAppServerCommand({executable:{path:'codex'},codexHome:path.join(os.tmpdir(),'empty-call-host'),workspaceDir:dataDir,channel:null,humanCall:identity});
 expect(command.args.filter(arg=>arg.includes('.approval_mode=')).sort()).toEqual(['call_human','hangup_call','list_active_calls'].map(tool=>'mcp_servers.mind_calls.tools.'+tool+'.approval_mode="approve"'));
 expect(command.args.some(arg=>arg.includes('default_tools_approval_mode'))).toBe(false);
});
it('keeps web search disabled by default and permits only an explicit typed role mode',()=>{
 expect(roleWebSearchConfig()).toBe('web_search="disabled"');expect(roleWebSearchConfig('live')).toBe('web_search="live"');expect(roleWebSearchConfig('cached')).toBe('web_search="cached"');expect(()=>roleWebSearchConfig('other' as never)).toThrow('Invalid');
});
it('passes an explicitly granted room agent web mode through the assigned turn contract',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'room-web-turn-'));try{
  const file=path.join(tmp,'role.md');fs.writeFileSync(file,'role');const assignment=validateAssignment({instructions:file,workspace:tmp,name:'Role web test'});const state=new Map<string,string>();let received:string|undefined;
  await runAssignedClaudeTurn({dataDir:tmp,dir:path.join(tmp,'fork'),id:4,assignment,store:{get:k=>state.get(k)??null,set:(k,v)=>void state.set(k,v)},message:'test only',control:()=> 'run',history:()=>[],agent:{key:'fixture-agent',prompt:'role',mcpConfig:undefined,promptDir:path.join(tmp,'prompts'),webSearch:'live'},turn:async input=>{received=input.webSearch;return{outcome:'completed',sessionConfirmed:true,text:'verified',tokens:1,retryAtMs:null,detail:null};}});
  expect(received).toBe('live');
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
it('preserves per-tool disabled, rejection and explicit prompt policies from inherited TOML or launcher overrides',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'call-tool-policy-'));try{
  const base='[mcp_servers.parent]\ncommand="node"\nargs='+JSON.stringify([path.resolve('services/mcp/server-main.ts')])+'\n[mcp_servers.parent.env]\nMIND_WAKE_OWNER_MESSAGES="1"\nMIND_WAKE_DATA_DIR='+JSON.stringify(dataDir)+'\nMIND_WAKE_OWNER_SIGNATURE="Marco"\n';
  for(const policy of [{field:'enabled',value:'false'},{field:'approval_mode',value:'"reject"'},{field:'approval_mode',value:'"prompt"'}]){
   fs.writeFileSync(path.join(home,'config.toml'),base+'[mcp_servers.parent.tools.call_human]\n'+policy.field+'='+policy.value+'\n');expect(callCodexOverrides(identity,home)).toEqual({});
   fs.writeFileSync(path.join(home,'config.toml'),base);expect(callCodexOverrides(identity,home,{['mcp_servers.parent.tools.call_human.'+policy.field]:policy.value})).toEqual({});
  }
  expect(callCodexOverrides(identity,undefined,{'mcp_servers.mind_calls.tools.call_human.enabled':'false'})).toEqual({});
  const original={...humanCallServer(identity),tools:{call_human:{approval_mode:'reject'}}};expect((roleMcpServers({mind_calls:original},dataDir)['mind_calls'] as Record<string,unknown>)['tools']).toBe(original.tools);
  expect(()=>callCodexOverrides(identity,home,{'mcp_servers.parent.tools.call_human':'{enabled=false}'})).toThrow('tool policy');
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});

