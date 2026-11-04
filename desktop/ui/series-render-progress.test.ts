import {describe,it,expect} from 'vitest';
import {renderProgressScope} from './series-render-progress.js';
describe('progression du film réellement sélectionné',()=>{
 it('distingue le candidat douze chapitres du film dix-sept séquences affiché',()=>{
  expect(renderProgressScope('marco-integral-123','montage/marco-scenes-456/marco-scenes.mp4|172000000|1',12)).toBe('Candidat 12 chapitres · marco-integral-123');
 });
 it('ne rattache pas une progression sans version à la vidéo',()=>{
  expect(renderProgressScope(undefined,'montage/film.mp4|32|1',12)).toContain('Candidat 12 chapitres');
 });
 it('identifie seulement le dossier exact de la vidéo sélectionnée',()=>{
  expect(renderProgressScope('marco-integral-123','montage/marco-integral-123/marco-integral.mp4|32|1',12)).toBe('Vidéo affichée');
  expect(renderProgressScope('marco-integral-12','montage/marco-integral-123/marco-integral.mp4|32|1',12)).toContain('Candidat');
 });
});
