import {it,expect} from 'vitest';
import {directorPlans,directorPlanAt} from './series-director-notes.js';
it('uses exported frames and matching source revision, with end-exclusive cuts',()=>{
 const result=directorPlans({source_response_id:'v3',settings:{fps:{numerator:24,denominator:1}},clips:[{id:'C1',track:'image',start_frame:0,end_frame:144},{id:'C2',track:'image',start_frame:144,end_frame:240},{id:'voice',track:'voice',start_frame:0,end_frame:50}]},{response_id:'v3',cuts:[{cut_id:'C1',title:'La demande',framing:'Plan moyen',dialogue:[{speaker:'Reine',intention:'Simple consigne'}]},{cut_id:'C2',continuity_out:'L’eau arrive'}]});
 expect(result.plans).toHaveLength(2);expect(result.plans[0]?.end).toBe(6);
 expect(result.plans[0]?.notes.map(n=>n.text)).toEqual(['Plan moyen','Simple consigne']);
 expect(directorPlanAt(result.plans,5.999)?.id).toBe('C1');expect(directorPlanAt(result.plans,6)?.id).toBe('C2');expect(directorPlanAt(result.plans,10)).toBeUndefined();
});
it('never attaches v3 intentions to a different export; retains embedded timeline evidence',()=>{
 const result=directorPlans({fps:24,source_response_id:'v2',clips:[{id:'C1',startFrame:0,endFrameExclusive:120,visible_action:'Note réellement exportée'}]},{response_id:'v3',cuts:[{cut_id:'C1',visible_action:'Version suivante',intention:'À ne pas afficher'}]});
 expect(result.warning).toContain('ne correspond pas');expect(result.plans[0]?.notes).toEqual([{label:'Jeu',text:'Note réellement exportée'}]);
});
it('the fifty-second opening can expose its plan list without inventing director notes',()=>{
 const result=directorPlans({id:'premier-apercu-v1',fps:24,clips:[{id:'PA01',title:'LE CONSEIL',caption:'Caption is not a director instruction',startFrame:0,endFrameExclusive:1200}]});
 expect(result.plans[0]).toMatchObject({id:'PA01',start:0,end:50,notes:[]});
});
