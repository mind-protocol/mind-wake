import {expect,it} from 'vitest';
import {parsePublicActivity} from './public-activity.js';
it('exposes commentary and tool names, excluding analysis, reasoning, arguments and outputs',()=>{
  const row=(payload:unknown)=>JSON.stringify({type:'response_item',timestamp:'2026-10-29T22:00:00Z',payload});
  const raw=[row({type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'Je vérifie le résultat.'}]}),row({type:'message',role:'assistant',channel:'analysis',content:[{type:'output_text',text:'PRIVATE'}]}),row({type:'reasoning',summary:[{text:'PRIVATE'}]}),row({type:'function_call',name:'functions.exec',arguments:'PRIVATE'}),row({type:'function_call_output',output:'PRIVATE'}),row({type:'message',role:'user',phase:'commentary',content:[{type:'output_text',text:'PRIVATE'}]})].join('\n');
  const items=parsePublicActivity(raw,'thread');
  expect(items.map(i=>i.text)).toEqual(['Je vérifie le résultat.','Utilise l’outil functions.exec.']);
  expect(JSON.stringify(items)).not.toContain('PRIVATE');
  expect(parsePublicActivity('broken\n'+raw,'thread')).toEqual(items);
});
