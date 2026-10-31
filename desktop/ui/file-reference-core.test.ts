import { expect, it } from 'vitest';
import { findFileMentions, type FileCatalog } from './file-reference-core.js';

const catalogs:readonly FileCatalog[]=[
 {scope:'agent',entries:[
  {relative:'artifacts/notes.md'},
  {relative:'artifacts/creations/blog/index.html'},
  {relative:'artifacts/Mon étude [1]+(bis).md'},
  {relative:'README.md'},
  {relative:'artifacts/other/notes.md'},
  {relative:'artifacts/image.png'},
 ]},
 {scope:'project',entries:[{relative:'README.md'},{relative:'docs/guide.markdown'},{relative:'../secret.md'},{relative:'C:\\secret.md'}]},
];
it('résout un chemin exact, ./ et les séparateurs Windows vers les fichiers connus',()=>{
 const text='Voir ./artifacts/creations/blog/index.html puis docs\\guide.markdown.';
 const refs=findFileMentions(text,catalogs);
 expect(refs.map(r=>r.text)).toEqual(['./artifacts/creations/blog/index.html','docs\\guide.markdown']);
 expect(refs.map(r=>r.files[0]?.scope)).toEqual(['agent','project']);
 expect(refs[1]?.files[0]?.relative).toBe('docs/guide.markdown');
 expect(findFileMentions('artifacts/./notes.md',catalogs)[0]?.files[0]?.relative).toBe('artifacts/notes.md');
});
it('rend explicites toutes les ambiguïtés de nom sans choisir une racine ou un dossier',()=>{
 const refs=findFileMentions('README.md et notes.md',catalogs);
 expect(refs[0]?.files.map(f=>f.scope)).toEqual(['agent','project']);
 expect(refs[1]?.files.map(f=>f.relative)).toEqual(['artifacts/notes.md','artifacts/other/notes.md']);
 expect(findFileMentions('artifacts/notes.md',catalogs)[0]?.files).toHaveLength(1);
});
it('ne détecte pas les suffixes de chemins inconnus, les chemins absolus et les traversées',()=>{
 const text='unknown/README.md C:\\other\\README.md /outside/README.md ../README.md foo-notes.md README.md.bak';
 expect(findFileMentions(text,catalogs)).toEqual([]);
 expect(findFileMentions('C:\\folder with README.md',catalogs)).toEqual([]);
 expect(findFileMentions('/folder with README.md',catalogs)).toEqual([]);
});
it('laisse les URL, file://, courriels et domaines www intacts',()=>{
 expect(findFileMentions('https://host/README.md file:///README.md mailto:README.md a@README.md www.README.md',catalogs)).toEqual([]);
});
it('ignore les blocs de code clôturés ou non avec les deux types de clôture',()=>{
 expect(findFileMentions('```js\nREADME.md\n```\n~~~\nnotes.md\n~~~\nREADME.md',catalogs).map(r=>r.text)).toEqual(['README.md']);
 expect(findFileMentions('avant\n```\nREADME.md',catalogs)).toEqual([]);
 expect(findFileMentions('    ```\nREADME.md\n    ```',catalogs)).toEqual([]);
});
it('dans le code inline accepte seulement une référence entière connue',()=>{
 const text='`artifacts/notes.md` puis `const x = "README.md"` et ``README.md``';
 expect(findFileMentions(text,catalogs).map(r=>r.text)).toEqual(['artifacts/notes.md','README.md']);
});
it('conserve espaces, accents, caractères regex littéraux et offsets UTF-16',()=>{
 const text='😀 « Mon étude [1]+(bis).md », puis MON ÉTUDE [1]+(BIS).MD.';
 const refs=findFileMentions(text,catalogs);
 expect(refs).toHaveLength(2);
 for(const ref of refs)expect(text.slice(ref.start,ref.end)).toBe(ref.text);
 expect(refs[0]?.start).toBe(5);
 expect(refs[0]?.files[0]?.relative).toBe('artifacts/Mon étude [1]+(bis).md');
 expect(findFileMentions('Mon etude [1]+(bis).md',catalogs)).toEqual([]);
});
it('retourne les répétitions en ordre et ne duplique pas un même fichier dans les catalogues',()=>{
 const duplicated:FileCatalog={scope:'agent',entries:[{relative:'artifacts/notes.md'},{relative:'ARTIFACTS/NOTES.MD'}]};
 const refs=findFileMentions('artifacts/notes.md, artifacts/notes.md',[duplicated]);
 expect(refs).toHaveLength(2);expect(refs.every(r=>r.files.length===1)).toBe(true);
 expect(refs[0]!.start).toBeLessThan(refs[1]!.start);
});
it('écarte les extensions non prises en charge et les entrées de catalogue hors racines',()=>{
 expect(findFileMentions('image.png secret.md',catalogs)).toEqual([]);
});
it('ne transforme pas un courriel connu même en code inline',()=>{
 const known:FileCatalog={scope:'agent',entries:[{relative:'a@b.md'}]};
 expect(findFileMentions('`a@b.md`', [known])).toEqual([]);
});

it('detects txt paths and unique or ambiguous basenames with punctuation and backticks',()=>{
 const path='artifacts/projets/delegation-entre-ateliers/machinetomachine-draft.txt';
 const textFiles:FileCatalog[]=[
  {scope:'agent',entries:[{relative:path},{relative:'artifacts/shared.txt'},{relative:'artifacts/tool.txt.exe'}]},
  {scope:'project',entries:[{relative:'shared.txt'},{relative:'../outside.txt'}]},
 ];
 const text='Voir `'+path+'`, puis machinetomachine-draft.TXT. (shared.txt)!';
 const refs=findFileMentions(text,textFiles);
 expect(refs.map(ref=>[ref.text,ref.files.length])).toEqual([[path,1],['machinetomachine-draft.TXT',1],['shared.txt',2]]);
 expect(refs[0]?.files[0]?.relative).toBe(path);
 for(const ref of refs)expect(text.slice(ref.start,ref.end)).toBe(ref.text);
 expect(findFileMentions('unknown/shared.txt ../shared.txt /shared.txt https://host/shared.txt tool.txt.exe outside.txt',textFiles)).toEqual([]);
 expect(findFileMentions('```\nshared.txt\n```\n`cat shared.txt`',textFiles)).toEqual([]);
});
