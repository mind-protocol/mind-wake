import { expect,it } from 'vitest';
import { CatalogRefreshGate, MessageFileQueue } from './message-file-links.js';
import type { FileCatalog } from './file-reference-core.js';
const started=Date.parse('2026-10-30T15:00:00Z');
const catalogs:FileCatalog[]=[{scope:'agent',entries:[{relative:'artifacts/alpha.md'},{relative:'artifacts/beta.html'},{relative:'artifacts/README.md'}]},{scope:'project',entries:[{relative:'README.md'}]}];
const item=(id:string,text:string,at='2026-10-30T15:01:00Z')=>({id,text,at});

it('ne rejoue pas le snapshot initial, puis ouvre le premier fichier reconnu et garde leur ordre',()=>{
 const state=new MessageFileQueue(started);
 state.observe([item('old','alpha.md')]);expect(state.resolve(catalogs)).toEqual([]);
 state.observe([item('old','alpha.md'),item('new','beta.html puis alpha.md')]);
 expect(state.resolve(catalogs).map(f=>f.name)).toEqual(['beta.html']);
 expect(state.entries.map(f=>f.name)).toEqual(['beta.html','alpha.md']);
});
it('ne rejoue ni polling, ni modification du même ID, ni pagination historique',()=>{
 const state=new MessageFileQueue(started);state.observe([]);
 state.observe([item('one','alpha.md')]);expect(state.resolve(catalogs)).toHaveLength(1);
 state.observe([item('one','beta.html')]);expect(state.resolve(catalogs)).toEqual([]);
 state.observe([item('older-loaded-later','beta.html')],true);expect(state.resolve(catalogs)).toEqual([]);
 expect(state.entries.map(f=>f.name)).toEqual(['alpha.md']);
});
it('ignore un message ancien et un message sans ID dans un nouveau polling',()=>{
 const state=new MessageFileQueue(started);state.observe([]);
 state.observe([item('old','alpha.md','2026-10-30T14:00:00Z'),{at:'2026-10-30T15:01:00Z',text:'beta.html'}]);
 expect(state.resolve(catalogs)).toEqual([]);expect(state.entries).toEqual([]);
});
it('conserve une bulle humaine live avant le premier snapshot sans la rejouer à réception',()=>{
 const state=new MessageFileQueue(started);const outgoing=item('ui-one','alpha.md');
 state.observe([outgoing],false,true);expect(state.resolve(catalogs)).toHaveLength(1);
 state.observe([outgoing,item('historical','beta.html')],true);expect(state.resolve(catalogs)).toEqual([]);
});
it('attend le catalogue avant résolution et ne choisit jamais un filename ambigu',()=>{
 const state=new MessageFileQueue(started);state.observe([]);state.observe([item('one','README.md puis beta.html')]);
 expect(state.resolve(catalogs).map(f=>f.name)).toEqual(['beta.html']);
 expect(state.entries.map(f=>f.name)).toEqual(['beta.html']);
});
it('déduplique la file par fichier tout en ouvrant la référence d’un nouveau message',()=>{
 const state=new MessageFileQueue(started);state.observe([]);
 state.observe([item('one','alpha.md puis alpha.md')]);expect(state.resolve(catalogs)).toHaveLength(1);
 state.observe([item('two','alpha.md')]);expect(state.resolve(catalogs)).toHaveLength(1);
 expect(state.entries).toHaveLength(1);
});
it('attend un catalogue frais pour un fichier créé après le démarrage',async()=>{
 const state=new MessageFileQueue(started);state.observe([]);
 let current:FileCatalog[]=[{scope:'agent',entries:[]}],finish!:()=>void;
 const read=new Promise<void>(resolve=>{finish=resolve;});
 let opened:string[]=[];
 const gate=new CatalogRefreshGate(async()=>{await read;current=[{scope:'agent',entries:[{relative:'artifacts/nouveau.md'}]}];},()=>{opened=state.resolve(current).map(file=>file.relative);});
 expect(state.observe([item('new-file','nouveau.md')])).toHaveLength(1);
 const refresh=gate.request();await Promise.resolve();
 expect(gate.busy).toBe(true);expect(opened).toEqual([]);expect(state.entries).toEqual([]);
 finish();await refresh;
 expect(opened).toEqual(['artifacts/nouveau.md']);expect(state.entries).toHaveLength(1);
 expect(state.observe([item('new-file','nouveau.md')])).toEqual([]);
});
it('regroupe les messages arrivant pendant une lecture et ne résout qu’à la fin',async()=>{
 let reads=0,settles=0,finish!:()=>void;
 const first=new Promise<void>(resolve=>{finish=resolve;});
 const gate=new CatalogRefreshGate(async()=>{reads++;if(reads===1)await first;},()=>{settles++;});
 const run=gate.request();await Promise.resolve();
 void gate.request();void gate.request();
 expect(reads).toBe(1);expect(settles).toBe(0);
 finish();await run;
 expect(reads).toBe(2);expect(settles).toBe(1);expect(gate.busy).toBe(false);
});
