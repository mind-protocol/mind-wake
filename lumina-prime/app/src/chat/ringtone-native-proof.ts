const known = new Set(["marco","vox","equerre","rose_des_vents","medicis"]);
/** Le marqueur vient du module compilé, jamais d’expoConfig/extra actualisable par OTA. */
export function verifiedRingtoneKeys(proof: unknown, expoGo: boolean): string[] {
  if(expoGo || !proof || typeof proof !== 'object')return [];
  const p=proof as {bundle?:unknown;ringtoneKeys?:unknown};
  return p.bundle === 'mind-ringtones-v1' && Array.isArray(p.ringtoneKeys)
    ? [...new Set(p.ringtoneKeys.filter((k):k is string=>typeof k==='string' && known.has(k)))] : [];
}
