/**
 * Moteurs OCR interchangeables. Sélection pure (testée) à partir d'un
 * environnement injecté ; le câblage plateforme est dans ocr-engine.ts.
 *
 * - web : tesseract.js (chargé à la demande, image traitée dans le navigateur) ;
 * - Android/iOS : module natif « ExpoTextExtractor » (paquet expo-text-extractor,
 *   ML Kit / Apple Vision) présent uniquement dans un build de développement
 *   qui l'embarque. Absent d'Expo Go -> état explicite « indisponible ».
 */
export type OcrImage = Readonly<{ uri: string; file?: Blob | null; mimeType?: string | null }>;

export type OcrEngine = Readonly<{
  id: 'tesseract-web' | 'native-text-extractor' | 'none';
  label: string;
  available: boolean;
  /** Why the engine is unavailable on this target (French, user-facing). */
  reason: string | null;
  recognize: (image: OcrImage) => Promise<string>;
}>;

export type NativeTextExtractor = {
  isSupported?: boolean;
  extractTextFromImage: (uri: string) => Promise<string[]>;
};

export type TesseractLike = {
  createWorker: (langs?: string | string[]) => Promise<{
    recognize: (image: unknown) => Promise<{ data: { text: string } }>;
    terminate: () => Promise<unknown>;
  }>;
};

export type OcrEnvironment = Readonly<{
  platform: string;
  hasDocument: boolean;
  nativeExtractor: NativeTextExtractor | null;
  loadTesseract: () => Promise<TesseractLike>;
}>;

export const OCR_LANGS = ['fra', 'eng'];

export class OcrUnavailableError extends Error {}

function unavailable(reason: string): OcrEngine {
  return Object.freeze({
    id: 'none',
    label: 'Aucun moteur OCR',
    available: false,
    reason,
    recognize: async () => { throw new OcrUnavailableError(reason); },
  });
}

export function selectOcrEngine(env: OcrEnvironment): OcrEngine {
  if (env.platform === 'web') {
    if (!env.hasDocument) return unavailable('OCR indisponible : aucun navigateur n’est disponible pour lire l’image.');
    return Object.freeze({
      id: 'tesseract-web',
      label: 'Tesseract (dans ton navigateur)',
      available: true,
      reason: null,
      recognize: async (image: OcrImage) => {
        const tesseract = await env.loadTesseract();
        const worker = await tesseract.createWorker(OCR_LANGS);
        try {
          const result = await worker.recognize(image.file ?? image.uri);
          return result.data.text;
        } finally {
          await worker.terminate().catch(() => undefined);
        }
      },
    });
  }
  if (env.platform === 'android' || env.platform === 'ios') {
    const native = env.nativeExtractor;
    if (!native) {
      return unavailable('OCR indisponible sur cette cible : la lecture de capture demande un build de développement qui embarque le module de reconnaissance de texte (absent d’Expo Go). Colle le texte ci-dessous.');
    }
    if (native.isSupported === false) {
      return unavailable('OCR indisponible : cet appareil ne prend pas en charge la reconnaissance de texte. Colle le texte ci-dessous.');
    }
    return Object.freeze({
      id: 'native-text-extractor',
      label: env.platform === 'ios' ? 'Apple Vision (sur l’appareil)' : 'ML Kit (sur l’appareil)',
      available: true,
      reason: null,
      recognize: async (image: OcrImage) => {
        const lines = await native.extractTextFromImage(image.uri.replace('file://', ''));
        return lines.join('\n');
      },
    });
  }
  return unavailable(`OCR indisponible sur cette cible (${env.platform}). Colle le texte ci-dessous.`);
}
