import { expect, it } from 'vitest';
import { collectionKey, documentLabel, modificationAge, visibleDocuments } from './document-library.js';

const entries=[
 {name:'index.html',relative:'artifacts/creations/blog/edition/index.html',modifiedAt:10},
 {name:'révision.md',relative:'artifacts/creations/blog/révision.md',modifiedAt:30},
 {name:'index.html',relative:'artifacts/creations/vj/index.html',modifiedAt:40},
 {name:'sources.md',relative:'artifacts/creations/blog/sources.md',modifiedAt:20},
 {name:'cache',relative:'cache',directory:true,modifiedAt:99},
];
it('garde les éditions imbriquées dans leur projet et ordonne par fraîcheur',()=>{
 expect(collectionKey(entries[0]!.relative)).toBe('artifacts/creations/blog');
 expect(visibleDocuments(entries,'artifacts/creations/blog','','').map(e=>e.name)).toEqual(['révision.md','sources.md','index.html']);
});
it('combine recherche sans accents et format sans faire disparaître le projet',()=>{
 expect(visibleDocuments(entries,'artifacts/creations/blog','revision','md').map(e=>e.relative)).toEqual(['artifacts/creations/blog/révision.md']);
 expect(visibleDocuments(entries,'artifacts/creations/blog','','html')).toHaveLength(1);
 expect(visibleDocuments(entries,'artifacts/creations/vj','revision','')).toEqual([]);
});
it('distingue les index de projets et retire les dossiers du parcours suivant',()=>{
 expect(documentLabel(entries[2]!)).toBe('vj');
 expect(visibleDocuments(entries,'','','').map(e=>e.relative)).not.toContain('cache');
});

it('ages filesystem modification times without inventing unknown dates',()=>{
 const now=Date.parse('2026-10-30T16:00:00Z');
 expect(modificationAge(now-30_000,now).label).toBe('à l’instant');
 expect(modificationAge(now-180_000,now).label).toBe('il y a 3 min');
 expect(modificationAge(now-7_200_000,now).label).toBe('il y a 2 h');
 expect(modificationAge(now-172_800_000,now)).toEqual({label:'il y a 2 j',date:'2026-10-28T16:00:00.000Z'});
 for(const value of [undefined,0,-1,NaN,Infinity]) expect(modificationAge(value,now)).toEqual({label:'date inconnue'});
 expect(modificationAge(now+1000,now).label).toBe('date future');
});

it('includes txt in all documents and filters plain text independently from Markdown and HTML',()=>{
 const draft={name:'machine-draft.TXT',relative:'artifacts/creations/blog/machine-draft.TXT',modifiedAt:50};
 const library=[...entries,draft];
 expect(visibleDocuments(library,'artifacts/creations/blog','','')[0]).toEqual(draft);
 expect(visibleDocuments(library,'','','txt')).toEqual([draft]);
 expect(visibleDocuments(library,'','','md')).not.toContain(draft);
 expect(visibleDocuments(library,'','','html')).not.toContain(draft);
 expect(documentLabel(draft)).toBe('machine draft');
});
