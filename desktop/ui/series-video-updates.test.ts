import {describe,it,expect} from 'vitest';
import {latestPublishedVideo,seriesVideoKey,videoUpdateAction} from './series-video-updates.js';
const a={relative:'montage/v1/a.mp4',bytes:12,modifiedAt:1},b={relative:'montage/v2/b.mp4',bytes:24,modifiedAt:2};
describe('versions vidéo itératives',()=>{
 it('suit la publication prête plutôt que le dernier fichier encore en encodage',()=>{expect(latestPublishedVideo([a,b],{status:'ready',version:'v1',video:a.relative})).toEqual(a);expect(latestPublishedVideo([a,b],{status:'rendering',version:'v2',video:b.relative})).toBeUndefined();});
 it('met en attente pendant lecture et pause au milieu, bascule au repos',()=>{expect(videoUpdateAction(seriesVideoKey(a),b,{enabled:true,visible:true,playing:true,pausedMidway:false})).toBe('queue');expect(videoUpdateAction(seriesVideoKey(a),b,{enabled:true,visible:true,playing:false,pausedMidway:true})).toBe('queue');expect(videoUpdateAction(seriesVideoKey(a),b,{enabled:true,visible:true,playing:false,pausedMidway:false})).toBe('switch');});
 it('ne recharge pas une version identique et respecte le lecteur fermé',()=>{expect(videoUpdateAction(seriesVideoKey(a),a,{enabled:true,visible:true,playing:false,pausedMidway:false})).toBe('none');expect(videoUpdateAction(seriesVideoKey(a),b,{enabled:true,visible:false,playing:false,pausedMidway:false})).toBe('queue');expect(videoUpdateAction(seriesVideoKey(a),b,{enabled:false,visible:true,playing:false,pausedMidway:false})).toBe('none');});
});
