/**
 * Position de lecture d'un fil re-rendu en entier (NLR, 15 nov. 2026, Room de Vox) : quand
 * l'humain est remonté lire, un nouveau message ne doit pas le ramener en bas. Le re-rendu
 * recrée les images à hauteur nulle ; le navigateur rabote alors `scrollTop` vers le bas.
 * On remet la position exacte après le rendu et à chaque image chargée, jusqu'à ce que
 * l'humain fasse défiler lui-même.
 */
export function readingHold(list: HTMLElement): {
  /** Position à garder après un rendu, ou `null` pour suivre le bas. */
  keep(top: number | null): void;
  holding(): boolean;
} {
  let held: number | null = null;
  const release = () => { held = null; };
  for (const name of ["wheel", "touchstart", "pointerdown", "keydown"]) list.addEventListener(name, release);
  list.addEventListener("load", () => { if (held !== null) list.scrollTop = held; }, true);
  return {
    keep(top) {
      held = top;
      if (top !== null) list.scrollTop = top;
    },
    holding: () => held !== null,
  };
}
