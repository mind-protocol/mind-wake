import {expect,it} from 'vitest';
import {parsePublicActivity} from './public-activity.js';
it('includes final responses in activity, with channel taking precedence over phase',()=>{
  const row=(payload:unknown)=>JSON.stringify({type:'response_item',timestamp:'2026-10-31T18:00:00Z',payload});
  const message=(extra:object,text:string)=>row({type:'message',role:'assistant',content:[{type:'output_text',text}],...extra});
  const items=parsePublicActivity([message({channel:'final'},'Résultat final'),message({phase:'final_answer'},'Autre résultat'),message({channel:'analysis',phase:'final_answer'},'PRIVATE')].join('\n'),'thread');
  expect(items.map(i=>i.text)).toEqual(['Résultat final','Autre résultat']);
});
it('exposes commentary and tool names, excluding analysis, reasoning, arguments and outputs',()=>{
  const row=(payload:unknown)=>JSON.stringify({type:'response_item',timestamp:'2026-10-29T22:00:00Z',payload});
  const raw=[row({type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'Je vérifie le résultat.'}]}),row({type:'message',role:'assistant',channel:'analysis',content:[{type:'output_text',text:'PRIVATE'}]}),row({type:'reasoning',summary:[{text:'PRIVATE'}]}),row({type:'function_call',name:'functions.exec',arguments:'PRIVATE'}),row({type:'function_call_output',output:'PRIVATE'}),row({type:'message',role:'user',phase:'commentary',content:[{type:'output_text',text:'PRIVATE'}]})].join('\n');
  const items=parsePublicActivity(raw,'thread');
  expect(items.map(i=>i.text)).toEqual(['Je vérifie le résultat.','Utilise l’outil functions.exec.']);
  expect(JSON.stringify(items)).not.toContain('PRIVATE');
  expect(parsePublicActivity('broken\n'+raw,'thread')).toEqual(items);
});
