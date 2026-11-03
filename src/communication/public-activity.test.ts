import {expect,it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parsePublicActivity,readPublicActivity,readThreadPublicActivity} from './public-activity.js';
it('includes final responses in activity, with channel taking precedence over phase',()=>{
  const row=(payload:unknown)=>JSON.stringify({type:'response_item',timestamp:'2026-10-31T18:00:00Z',payload});
  const message=(extra:object,text:string)=>row({type:'message',role:'assistant',content:[{type:'output_text',text}],...extra});
  const items=parsePublicActivity([message({channel:'final'},'Résultat final'),message({phase:'final_answer'},'Autre résultat'),message({channel:'analysis',phase:'final_answer'},'PRIVATE')].join('\n'),'thread');
  expect(items.map(i=>i.text)).toEqual(['Résultat final','Autre résultat']);
  expect(items.map(i=>i.kind)).toEqual(['final','final']);
});
it('shows only the explicit mission from native delegation arguments and recognizes custom tools',()=>{
  const row=(payload:unknown)=>JSON.stringify({type:'response_item',timestamp:'2026-11-03T12:00:00Z',payload});
  const activity=parsePublicActivity([
    row({type:'function_call',name:'spawn_agent',arguments:JSON.stringify({task_name:'verifier',message:'Vérifie le rendu.',secret:'PRIVATE'})}),
    row({type:'custom_tool_call',name:'functions.exec',input:'PRIVATE'}),
    row({type:'function_call',name:'collaboration.followup_task',arguments:JSON.stringify({target:'verifier',message:'Continue.'})}),
  ].join('\n'),'main');
  expect(activity.map(a=>[a.source,a.text])).toEqual([['verifier','Mission : Vérifie le rendu.'],[undefined,'Utilise l’outil functions.exec.'],['verifier','Mission : Continue.']]);
  expect(JSON.stringify(activity)).not.toContain('PRIVATE');
});
it('replaces encrypted delegation messages with readable task labels without changing their IDs',()=>{
  const token='gAAAAABq6fVL'+'x'.repeat(2000)+'==';
  const row=(name:string,args:object)=>JSON.stringify({type:'response_item',timestamp:'2026-11-03T12:00:00Z',payload:{type:'function_call',name,call_id:'delegation',arguments:JSON.stringify(args)}});
  const raw=[
    row('spawn_agent',{task_name:'autosync_diagnostic',message:token}),
    row('collaboration.followup_task',{target:'/root/reddit_revision',message:token}),
    row('spawn_agent',{message:token}),
    row('spawn_agent',{task_name:'plan_w500',message:'x'.repeat(200)}),
  ].join('\n');
  const items=parsePublicActivity(raw,'main');
  expect(items.map(a=>a.text)).toEqual(['Mission : Autosync diagnostic','Mission : Reddit revision','Mission confiée à une sous-session.','Mission : Plan w500']);
  expect(JSON.stringify(items)).not.toContain(token);
  expect(parsePublicActivity(raw,'main').map(a=>a.id)).toEqual(items.map(a=>a.id));
});
it('reads only the Wake thread and its descendants, excluding inherited history and unrelated sessions',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wake-public-'));
  try {
    const codex=path.join(dir,'codex'),sessions=path.join(codex,'sessions'),data=path.join(dir,'data');
    fs.mkdirSync(sessions,{recursive:true});fs.mkdirSync(path.join(data,'codex-threads'),{recursive:true});
    const main='00000000-0000-0000-0000-000000000001',child='00000000-0000-0000-0000-000000000002',nested='00000000-0000-0000-0000-000000000003';
    fs.writeFileSync(path.join(data,'codex-threads','thread-abcd.json'),JSON.stringify({threadId:main,updatedAt:'2026-11-03'}));
    const message=(text:string,at='2026-11-03T12:01:00Z',channel='commentary')=>JSON.stringify({type:'response_item',timestamp:at,payload:{type:'message',role:'assistant',channel,content:[{type:'output_text',text}]}});
    const write=(id:string,parent:string|null,body:string)=>fs.writeFileSync(path.join(sessions,`rollout-${id}.jsonl`),JSON.stringify({type:'session_meta',payload:{id,timestamp:'2026-11-03T12:00:00Z',agent_path:'/root/render',source:parent?{subagent:{thread_spawn:{parent_thread_id:parent}}}:'cli'}})+'\n'+body);
    write(main,null,message('Principal'));
    write(child,main,[message('Héritage privé','2026-11-02T12:00:00Z'),message('Je vérifie.'),message('Résultat enfant','2026-11-03T12:02:00Z','final'),'broken'].join('\n'));
    write(nested,child,message('Résultat imbriqué','2026-11-03T12:03:00Z','final'));
    write('00000000-0000-0000-0000-000000000004',null,message('Autre session privée'));
    const activity=readPublicActivity(data,codex);
    expect(activity.map(a=>a.text)).toContain('Principal');
    expect(activity).toContainEqual(expect.objectContaining({text:'Résultat enfant',source:'render',threadId:child,kind:'final'}));
    expect(activity).toContainEqual(expect.objectContaining({text:'Résultat imbriqué',threadId:nested}));
    expect(activity.filter(a=>a.text==='Sous-session démarrée.')).toHaveLength(2);
    expect(JSON.stringify(activity)).not.toMatch(/Héritage privé|Autre session privée/);
    fs.appendFileSync(path.join(sessions,`rollout-${child}.jsonl`),'\n'+message('Mise à jour','2026-11-03T12:04:00Z'));
    expect(readPublicActivity(data,codex).at(-1)?.text).toBe('Mise à jour');
    const forkOnly=readThreadPublicActivity(child,codex,true);
    expect(forkOnly.map(a=>a.text)).toContain('Je vérifie.');
    expect(forkOnly.map(a=>a.text)).toContain('Résultat imbriqué');
    expect(JSON.stringify(forkOnly)).not.toMatch(/Principal|Héritage privé|Autre session privée/);
    fs.unlinkSync(path.join(sessions,`rollout-${child}.jsonl`));
    expect(readPublicActivity(data,codex).some(a=>a.text==='Principal')).toBe(true);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
it('keeps the complete final response while bounding activity excerpts',()=>{
  const text='Réponse longue. '.repeat(1000);
  const message=(channel:string)=>JSON.stringify({type:'response_item',timestamp:'2026-11-03T12:00:00Z',payload:{type:'message',role:'assistant',channel,content:[{type:'output_text',text}]}});
  const items=parsePublicActivity([message('commentary'),message('final')].join('\n'),'thread');
  expect(items[0]?.text).toHaveLength(4000);
  expect(items[1]).toMatchObject({text,kind:'final'});
});
it('exposes commentary and tool names, excluding analysis, reasoning, arguments and outputs',()=>{
  const row=(payload:unknown)=>JSON.stringify({type:'response_item',timestamp:'2026-10-29T22:00:00Z',payload});
  const raw=[row({type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'Je vérifie le résultat.'}]}),row({type:'message',role:'assistant',channel:'analysis',content:[{type:'output_text',text:'PRIVATE'}]}),row({type:'reasoning',summary:[{text:'PRIVATE'}]}),row({type:'function_call',name:'functions.exec',arguments:'PRIVATE'}),row({type:'function_call_output',output:'PRIVATE'}),row({type:'message',role:'user',phase:'commentary',content:[{type:'output_text',text:'PRIVATE'}]})].join('\n');
  const items=parsePublicActivity(raw,'thread');
  expect(items.map(i=>i.text)).toEqual(['Je vérifie le résultat.','Utilise l’outil functions.exec.']);
  expect(JSON.stringify(items)).not.toContain('PRIVATE');
  expect(parsePublicActivity('broken\n'+raw,'thread')).toEqual(items);
});
