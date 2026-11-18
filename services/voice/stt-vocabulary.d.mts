export interface SttVocabulary { terms: string[]; elevenlabsKeyterms: boolean }
export const STT_VOCABULARY_FILE: string;
export const DEFAULT_TERMS: readonly string[];
export function defaultSttVocabulary(): SttVocabulary;
export function normalizeSttVocabulary(value: unknown): SttVocabulary;
export function readSttVocabulary(dataDir: string): SttVocabulary & { source: "file" | "default"; error?: string };
export function writeSttVocabulary(dataDir: string, value: Partial<SttVocabulary>): SttVocabulary;
export function formatSttVocabularyText(vocabulary: SttVocabulary): string;
export function parseSttVocabularyText(text: string): { terms: string[] };
export function whisperHotwordArguments(vocabulary: SttVocabulary): string[];
export function whisperHotwords(vocabulary: SttVocabulary): string;
export function elevenLabsKeyterms(vocabulary: SttVocabulary, options?: { realtime?: boolean }): string[];
