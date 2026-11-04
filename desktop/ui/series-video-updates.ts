import {type SeriesFile,stageFiles} from './series-assembly-model.js';
export type SeriesPublication={status:string;version:string;video:string;timeline?:string;cuts?:string;plans?:number;totalPlans?:number;duration?:number};
export const seriesVideoKey=(file:SeriesFile):string=>`${file.relative}|${file.bytes}|${file.modifiedAt??0}`;
export function latestPublishedVideo(files:readonly SeriesFile[],publication?:SeriesPublication|null):SeriesFile|undefined {
 if(publication){if(publication.status!=='ready')return undefined;const relative=publication.video.replaceAll('\\','/');return stageFiles(files,'video').find(file=>file.relative===relative);}
 return stageFiles(files,'video').sort((a,b)=>(b.modifiedAt??0)-(a.modifiedAt??0))[0];
}
/** Updates never interrupt an active or deliberately paused mid-clip player. */
export function videoUpdateAction(currentKey:string,candidate:SeriesFile|undefined,state:{enabled:boolean;visible:boolean;playing:boolean;pausedMidway:boolean}):'none'|'queue'|'switch' {
 if(!candidate||!state.enabled||seriesVideoKey(candidate)===currentKey)return 'none';
 if(!state.visible||state.playing||state.pausedMidway)return 'queue';
 return 'switch';
}
