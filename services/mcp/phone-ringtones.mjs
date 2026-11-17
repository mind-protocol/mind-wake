/** Catalogue local fermé. Aucun nom de fichier fourni par un appelant. */
export const RINGTONE_KEYS = Object.freeze(["marco","vox","equerre","rose_des_vents","medicis"]);
const common = Object.freeze({key:'common',sound:'ring.wav',channelId:'appel-agent'});
const callers = Object.freeze({mind:'marco',marco:'marco',vox:'vox'});
export function ringtoneCapabilities(input) {
 if(input===undefined)return [];
 if(!Array.isArray(input)||input.length>RINGTONE_KEYS.length||input.some(k=>!RINGTONE_KEYS.includes(k)))throw Error('Capacités sonneries invalides');
 return [...new Set(input)];
}
export function phoneRingtone(caller,capabilities=[]) {
 const key=callers[caller];
 return key && capabilities.includes(key) ? {key,sound:'ring_'+key+'.wav',channelId:'appel-'+key+'-v1'} : common;
}
// Équerre/Rose/Médicis : assets prêts, caller hôte non reçu, aucun alias inventé.
