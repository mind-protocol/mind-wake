import {describe,it,expect} from 'vitest';
import {stageFiles,seriesStage} from './series-assembly-model.js';
describe('inventaire de l’assemblage Séries',()=>{
 it('ne transforme ni mandat ni prompt en scène, média ou export',()=>{
  expect(seriesStage({relative:'roles/scenes/MANDAT-INITIAL.md',bytes:12})).toBeUndefined();
  expect(seriesStage({relative:'roles/cutter/VISUEL.md',bytes:12})).toBeUndefined();
  expect(seriesStage({relative:'roles/scenes/SCENES-CHUNK-01.md',bytes:12})).toBe('scenes');
  expect(seriesStage({relative:'media/prompts.md',bytes:12})).toBeUndefined();
  expect(stageFiles([{relative:'montage/export.mp4',bytes:0}], 'video')).toEqual([]);
 });
 it('compte les fichiers produits à leur étape réelle',()=>{
  const files=[{relative:'sources/fil-01.jsonl',bytes:12},{relative:'episodes/E01.md',bytes:12},{relative:'media/plan.png',bytes:12},{relative:'montage/timeline.json',bytes:12},{relative:'montage/E01.mp4',bytes:12}];
  expect(['sources','episodes','media','montage','video'].map(id=>stageFiles(files,id as 'sources').length)).toEqual([1,1,1,1,1]);
 });
});
