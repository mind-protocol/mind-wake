/**
 * Nom affiché d'un fil (NLR, 15 nov. 2026) : « Room N », sauf le fil principal (Marco) et la
 * Room de VOX (Vox). Affichage seulement : les identifiants internes (`fork:7`…) ne changent pas.
 *
 * NLR, 16 nov. 2026 : « renommons les rooms avec les noms de projet ». Le runtime rend pour
 * chaque room un `label` (champ `name` de son affectation, sinon sa signature, sinon « Room N ») ;
 * `setRoomLabels` le retient à chaque lecture de l'état des rooms.
 */
const labels = new Map<number, string>();

export function setRoomLabels(forks: readonly { id: number; label?: unknown }[]): void {
  labels.clear();
  for (const fork of forks)
    if (typeof fork.label === "string" && fork.label.trim() !== "") labels.set(fork.id, fork.label.trim());
}

export function roomName(id: number): string {
  if (id === 1) return "Marco";
  return labels.get(id) ?? (id === 7 ? "Vox" : `Room ${String(id)}`);
}
