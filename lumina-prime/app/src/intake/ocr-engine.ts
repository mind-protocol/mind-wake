/**
 * Câblage plateforme des moteurs OCR (voir ocr.ts).
 * Aucun paquet supplémentaire n'est importé statiquement :
 * - web : tesseract.js 7.0.0 est chargé à la demande depuis jsDelivr, version
 *   figée et intégrité SRI vérifiée. L'image n'est pas envoyée à un serveur :
 *   le navigateur télécharge le moteur et les données de langue, puis lit
 *   l'image localement. (Demande d'installation du paquet : deps/demande-ocr.txt.)
 * - natif : requireOptionalNativeModule renvoie null quand le module n'est pas
 *   embarqué (Expo Go, build sans expo-text-extractor).
 */
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { selectOcrEngine, type NativeTextExtractor, type OcrEngine, type TesseractLike } from './ocr.ts';

export const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
export const TESSERACT_SRI = 'sha384-2BQ3U3OdKOb0Uczxqr41I9UvZkzr4V9Hv8uSzMMZAlmhsFClvdZX5wi5fDCzG+tM';

let pending: Promise<TesseractLike> | null = null;

function loadTesseractFromCdn(): Promise<TesseractLike> {
  const scope = globalThis as unknown as { Tesseract?: TesseractLike; document?: Document };
  if (scope.Tesseract) return Promise.resolve(scope.Tesseract);
  if (pending) return pending;
  pending = new Promise<TesseractLike>((resolve, reject) => {
    const doc = scope.document;
    if (!doc) { reject(Error('Aucun document pour charger le moteur OCR.')); return; }
    const script = doc.createElement('script');
    script.src = TESSERACT_CDN;
    script.integrity = TESSERACT_SRI;
    script.crossOrigin = 'anonymous';
    script.async = true;
    script.onload = () => scope.Tesseract ? resolve(scope.Tesseract) : reject(Error('Moteur OCR introuvable après chargement.'));
    script.onerror = () => reject(Error('Le moteur OCR n’a pas pu être téléchargé (réseau ou blocage).'));
    doc.head.appendChild(script);
  }).catch(error => { pending = null; throw error; });
  return pending;
}

let cached: OcrEngine | null = null;

export function getOcrEngine(): OcrEngine {
  if (cached) return cached;
  let nativeExtractor: NativeTextExtractor | null = null;
  if (Platform.OS === 'android' || Platform.OS === 'ios') {
    try { nativeExtractor = requireOptionalNativeModule<NativeTextExtractor>('ExpoTextExtractor'); }
    catch { nativeExtractor = null; }
  }
  cached = selectOcrEngine({
    platform: Platform.OS,
    hasDocument: typeof (globalThis as { document?: unknown }).document !== 'undefined',
    nativeExtractor,
    loadTesseract: loadTesseractFromCdn,
  });
  return cached;
}
