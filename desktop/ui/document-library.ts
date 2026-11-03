import { tr } from "./i18n.js";
export interface LibraryEntry { name:string; relative:string; modifiedAt?:number|null; directory?:boolean; modifiedAtSource?:string; dateUnavailableReason?:string }
export interface AuroreSyncStatus {status:string; lastSuccessAt:string|null; error:string|null}
export function auroreDocumentStatus(version:string|undefined,sync?:AuroreSyncStatus):string {
  return tr("Dépôt mind-protocol/scisense-aurore-workspace · révision chargée ")+(version??tr("inconnue"))+tr(" · lecture seule")
    +(sync?tr(" · synchronisation : ")+sync.status+(sync.lastSuccessAt?tr(" · dernier succès ")+sync.lastSuccessAt:'')+(sync.error?' · '+sync.error:''):tr(" · synchronisation non observée"));
}
export function collectionKey(relative:string):string {
  const parts=relative.split('/');
  if(parts[0]==='artifacts'&&parts[1]==='creations'&&parts[2])return parts.slice(0,3).join('/');
  return parts.length>1?parts.slice(0,parts[0]==='artifacts'?2:1).join('/'):'@root';
}
export function libraryLabel(value:string):string {
  if(value==='@root')return tr("Repères");
  return (value.split('/').at(-1)??value).replace(/\.(?:md|markdown|html?|txt)$/i,'').replace(/[-_]/g,' ');
}
export function documentLabel(entry:LibraryEntry):string {
  return /^index\.html?$/i.test(entry.name)?libraryLabel(entry.relative.split('/').slice(0,-1).join('/')):libraryLabel(entry.name);
}
export function visibleDocuments(entries:LibraryEntry[],collection:string,query:string,format:string):LibraryEntry[]{
  const normalize=(s:string):string=>s.normalize('NFD').replace(/\p{Diacritic}/gu,'').toLocaleLowerCase();
  const search=normalize(query.trim());
  return entries.filter(e=>!e.directory&&(!collection||collectionKey(e.relative)===collection)
    &&(!search||normalize(e.relative).includes(search))
    &&(!format||(format==='html'?/\.html?$/i:format==='txt'?/\.txt$/i:/\.(?:md|markdown)$/i).test(e.relative)))
    .sort((a,b)=>(b.modifiedAt??0)-(a.modifiedAt??0)||a.relative.localeCompare(b.relative));
}

/** Epoch milliseconds: filesystem for local scopes, path commit for Aurore. */
export function modificationAge(modifiedAt: number | null | undefined, now: number): {label:string; date?:string} {
  if (modifiedAt == null || !Number.isFinite(modifiedAt) || modifiedAt <= 0 || !Number.isFinite(new Date(modifiedAt).getTime())) return {label:tr("date inconnue")};
  const date = new Date(modifiedAt).toISOString();
  const elapsed = now - modifiedAt;
  if (elapsed < 0) return {label:tr("date future"),date};
  if (elapsed < 60_000) return {label:tr("à l’instant"),date};
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return {label:`il y a ${minutes} min`,date};
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return {label:`il y a ${hours} h`,date};
  const days = Math.floor(hours / 24);
  return {label:`il y a ${days} j`,date};
}
