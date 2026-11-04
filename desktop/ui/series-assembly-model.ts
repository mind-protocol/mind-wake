export type SeriesFile = {relative:string; bytes:number; modifiedAt?:number};
export const SERIES_STAGES = [
  {id:'sources',label:'Matière',owner:'Sources · Planner',missing:'Aucune source présente.'},
  {id:'episodes',label:'Épisodes',owner:'Narrator',missing:'Aucun épisode ni plan narratif présent.'},
  {id:'scenes',label:'Scènes',owner:'Scenes',missing:'Aucune scène écrite présente.'},
  {id:'media',label:'Médias',owner:'Images · voix',missing:'Aucun média produit présent. Les prompts restent des textes.'},
  {id:'montage',label:'Montage',owner:'Cutter',missing:'Aucune timeline ni document de montage présent.'},
  {id:'video',label:'Vidéo',owner:'Export',missing:'Aucun fichier vidéo présent.'},
] as const;
export type SeriesStage = typeof SERIES_STAGES[number]['id'];
export const isSeriesMedia = (relative:string):boolean => /\.(mp4|webm|png|jpe?g|mp3|wav)$/i.test(relative);
export function seriesStage(file:SeriesFile):SeriesStage|undefined {
  const p=file.relative.toLowerCase();
  if (/\.(mp4|webm)$/.test(p)) return 'video';
  if (isSeriesMedia(p)) return 'media';
  if (p.startsWith('sources/')||p.startsWith('appui-sources/')) return 'sources';
  if (/(^|\/)mandat[^/]*\.md$/.test(p)||/\/(question\.json|visuel\.md)$/.test(p)) return undefined;
  if (p.startsWith('roles/planner/')) return 'sources';
  if (p.startsWith('episodes/')||p.startsWith('roles/narrator/')) return 'episodes';
  if (p.startsWith('scenes/')||p.startsWith('roles/scenes/')) return 'scenes';
  if (p.startsWith('montage/')||p.startsWith('roles/cutter/')) return 'montage';
  return undefined;
}
export function stageFiles(files:readonly SeriesFile[], stage:SeriesStage):SeriesFile[] {
  return files.filter(f=>f.bytes>0&&seriesStage(f)===stage);
}
