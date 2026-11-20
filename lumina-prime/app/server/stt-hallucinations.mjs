/**
 * Hallucinations de Whisper sur le silence ou le bruit (NLR, 20 nov. 2026 14:03 : « Sous-titres
 * réalisés par la communauté d'Amara.org » relayé comme sa parole pendant un appel). Ces phrases
 * viennent des sous-titres de vidéos qui ont servi à entraîner le modèle.
 *
 * - Crédits de sous-titrage (Amara.org, ST' 501, Radio-Canada…) : jamais dits par une personne,
 *   retirés où qu'ils soient dans la transcription.
 * - Formules de fin de vidéo (« Merci d'avoir regardé », « Abonnez-vous ») : écartées seulement
 *   quand elles forment toute la transcription.
 * - Énergie : sous `MIN_SPEECH_RMS` (≈ −54 dBFS sur les passages retenus par la VAD), le passage
 *   est du silence ou du souffle, quel que soit le texte.
 */
export const MIN_SPEECH_RMS = 0.002;

const fold = text => String(text).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’ʼ`]/gu, "'");

/** Crédits retirés partout (texte replié : sans accents, minuscules). */
const CREDITS = [
  /sous-?titres? (realises? )?(par|de) (la communaute d'?)?amara\.org/gu,
  /(subtitles|captions) by the amara\.org community/gu,
  /(la )?communaute d'?amara\.org/gu,
  /amara\.org/gu,
  /sous-?titrage (st'? ?501|societe radio-canada|fr ?\?|mfp\.?)/gu,
  /sous-?titres? (realises? )?par (l'?)?(st'? ?501|societe radio-canada)/gu,
];

/** Formules écartées seulement seules. */
const WHOLE = [
  /^(merci|thanks?|thank you) (d'avoir|de nous avoir|for) (regarde|suivi|ecoute|watching)( (cette|la) video)?( et a bientot)?$/u,
  /^(abonnez-vous|n'oubliez pas de vous abonner)( a la chaine)?$/u,
  /^(merci|thank you)$/u,
  /^(sous-?titres?|sous-?titrage)$/u,
];

const letters = text => (text.match(/\p{L}/gu) ?? []).length;

/**
 * Texte à remettre, ou `null` si la transcription n'est qu'une hallucination de silence.
 * `reason` explique l'écart ; un texte partiellement nettoyé garde le reste de la parole.
 */
export function cleanTranscript(text, { speechRms } = {}) {
  const raw = String(text ?? '').trim();
  if (typeof speechRms === 'number' && Number.isFinite(speechRms) && speechRms < MIN_SPEECH_RMS)
    return { text: null, reason: `energie_basse (${speechRms.toFixed(4)})` };
  let folded = fold(raw);
  let removed = false;
  for (const re of CREDITS) folded = folded.replace(re, () => { removed = true; return ' '; });
  const rest = folded.replace(/[^\p{L}\p{N}' -]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (letters(rest) === 0) return { text: null, reason: removed ? 'credit_sous_titres' : 'vide' };
  if (WHOLE.some(re => re.test(rest))) return { text: null, reason: 'formule_video' };
  if (!removed) return { text: raw, reason: null };
  // Crédit mêlé à de la vraie parole : on retire le crédit du texte d'origine (accents conservés).
  let kept = raw;
  for (const re of [/sous-?titres?[^.!?\n]*amara\.org\.?/giu, /[^.!?\n]*amara\.org\.?/giu, /sous-?titrage\s+(st'?\s?501|soci[ée]t[ée] radio-canada)\.?/giu])
    kept = kept.replace(re, ' ');
  kept = kept.replace(/\s+/gu, ' ').trim();
  return letters(kept) === 0 ? { text: null, reason: 'credit_sous_titres' } : { text: kept, reason: 'credit_retire' };
}
