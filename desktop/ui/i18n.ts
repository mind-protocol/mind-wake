import { english } from "./translations.js";

export type Language = "en" | "fr";
export const LANGUAGE_KEY = "mind-wake.language";

export function resolveLanguage(saved: string | null, languages: readonly string[]): Language {
  if (saved === "fr" || saved === "en") return saved;
  for (const language of languages) {
    const base = language.toLowerCase().split(/[-_]/)[0];
    if (base === "fr" || base === "en") return base;
  }
  return "en";
}

export function getLanguage(): Language {
  let saved: string | null = null;
  try { saved = globalThis.localStorage?.getItem(LANGUAGE_KEY) ?? null; } catch { /* Storage may be disabled. */ }
  return resolveLanguage(saved, typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language]);
}

export function setLanguage(language: Language): void {
  globalThis.localStorage.setItem(LANGUAGE_KEY, language);
}

export function formatLocale(): string {
  return getLanguage() === "fr" ? "fr-FR" : "en-US";
}

/** Replace only catalog placeholders, in one pass; values remain opaque data. */
export function translate(language: Language, key: string, values: readonly unknown[] = []): string {
  const template = language === "en" ? english[key] ?? key : key;
  return template.replace(/\{(\d+)\}/g, (match, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : match,
  );
}

export function tr(key: string, values: readonly unknown[] = []): string {
  return translate(getLanguage(), key, values);
}
