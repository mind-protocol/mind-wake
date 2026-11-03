import { tr, formatLocale } from "./i18n.js";
/** Project identity is independent of wake position, phase and preview ordering. */
export function projectMarker(projectId: string | null, title: string): {letter: string; color: string} {
  if (projectId === null) return {letter: "·", color: "#d9e2ee"};
  let hash = 2166136261;
  for (const char of projectId) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619) >>> 0;
  const letter = title.normalize("NFD").replace(/\p{M}/gu, "").match(/[\p{L}\p{N}]/u)?.[0]?.toLocaleUpperCase(formatLocale()) ?? "?";
  return {letter, color: `hsl(${hash % 360} 72% 76%)`};
}

export function projectBadge(projectId: string | null, title: string): HTMLSpanElement {
  const marker = projectMarker(projectId, title), badge = document.createElement("span");
  badge.className = "project-badge";
  badge.textContent = marker.letter;
  badge.style.setProperty("--project-color", marker.color);
  badge.title = title;
  badge.setAttribute("aria-label", tr("Projet : {0}", [title]));
  return badge;
}

export function undefinedObjectiveBadge(): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.className = "objective-undefined-badge";
  badge.textContent = tr("? À définir");
  badge.title = tr("L’objectif de ce wake n’est pas encore défini.");
  return badge;
}
