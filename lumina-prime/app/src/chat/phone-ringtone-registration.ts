/** Échec ou ancien gateway : ne jamais interrompre pending, décroché ou son commun. */
export async function advertiseRingtoneCapabilities(
  request: (method: 'GET' | 'POST', body?: {keys: string[]}) => Promise<unknown>,
  keys: string[],
): Promise<boolean> {
  try {
    const support=await request('GET') as {version?:number} | null;
    if(support?.version!==1)return false;
    await request('POST',{keys});
    return true;
  } catch { return false; }
}
