/**
 * Réveil d'un coach par le @handle de sa personne. Le registre `COACHS-REGISTRE.json` (écrit
 * par une seule main, lu ici seulement) assigne chaque personne à un coach ; le coach est un
 * pattern holder ordinaire, réveillé par `pattern-holders.ts`.
 */
import fs from "node:fs";
import path from "node:path";

export const COACHS_REGISTRE = "COACHS-REGISTRE.json";

export interface CoachRegistryPerson {
  readonly id: string;
  readonly coach: string;
  readonly handles: readonly string[];
  readonly fiche?: string;
}
export interface CoachRegistry {
  readonly persons: readonly CoachRegistryPerson[];
  /** Slugs des coachs marqués `prive`. */
  readonly privateCoaches: ReadonlySet<string>;
}
export interface HandleHit {
  readonly handle: string;
  readonly person: string;
  readonly fiche?: string;
  readonly coach: string;
  readonly private: boolean;
}

/** Registre lu à chaque appel (fichier vivant), ou `null` avec la raison si absent ou invalide. */
export function readCoachRegistry(holdersDir: string): { registry: CoachRegistry } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(path.join(holdersDir, COACHS_REGISTRE), "utf8"));
  } catch (error) {
    return { error: error instanceof Error ? error.message : "illisible" };
  }
  const root = data as { personnes?: unknown; coachs?: unknown } | null;
  if (root === null || typeof root !== "object" || !Array.isArray(root.personnes))
    return { error: "`personnes` absent ou invalide" };
  const persons: CoachRegistryPerson[] = [];
  for (const p of root.personnes as unknown[]) {
    const o = p as Record<string, unknown> | null;
    if (o === null || typeof o !== "object" || typeof o["coach"] !== "string") continue;
    const handles = (Array.isArray(o["handles"]) ? (o["handles"] as unknown[]) : [])
      .map((h) => (h as { handle?: unknown } | null)?.handle)
      .filter((h): h is string => typeof h === "string" && h.trim() !== "")
      .map((h) => h.trim().replace(/^@/, "").toLowerCase());
    persons.push({
      id: typeof o["id"] === "string" ? o["id"] : handles[0] ?? "?",
      coach: o["coach"],
      handles,
      ...(typeof o["fiche"] === "string" ? { fiche: o["fiche"] } : {}),
    });
  }
  const privateCoaches = new Set<string>();
  const coachs = root.coachs;
  if (coachs !== null && typeof coachs === "object")
    for (const [slug, c] of Object.entries(coachs as Record<string, unknown>))
      if ((c as { prive?: unknown } | null)?.prive === true) privateCoaches.add(slug);
  return { registry: { persons, privateCoaches } };
}

/** `@handle` d'un texte, en minuscules, sans les adresses e-mail ni les chemins. */
export function extractHandles(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\p{L}\p{N}_.@/\\-])@([A-Za-z0-9][A-Za-z0-9_.-]*)/gu)) {
    const handle = (m[1] ?? "").replace(/[.-]+$/, "").toLowerCase();
    if (handle !== "") out.add(handle);
  }
  return [...out];
}

/** Personnes du registre visées par les @handles du texte, hors holders déjà connus. */
export function handleHits(
  text: string,
  registry: CoachRegistry,
  knownHolderSlugs: ReadonlySet<string>,
): HandleHit[] {
  const hits: HandleHit[] = [];
  for (const handle of extractHandles(text)) {
    if (knownHolderSlugs.has(handle)) continue;
    const person = registry.persons.find((p) => p.handles.includes(handle));
    if (person === undefined) continue;
    hits.push({
      handle,
      person: person.id,
      ...(person.fiche === undefined ? {} : { fiche: person.fiche }),
      coach: person.coach,
      private: registry.privateCoaches.has(person.coach),
    });
  }
  return hits;
}

export const PRIVATE_COACH_NOTE =
  "Tu es un coach privé : rien de ce que tu sais par le privé ne va dans un fil partagé.";

/** Message de réveil d'un coach pour les personnes mentionnées. */
export function handleWakeNote(hits: readonly HandleHit[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    if (seen.has(h.person)) continue;
    seen.add(h.person);
    lines.push(
      `@${h.handle} est mentionné ici. Tu es son coach dans le mesh. Ce n'est pas son choix, et tu n'as aucun mandat sur lui. Appuie-toi sur les citations sourcées de sa fiche, et présente le reste comme ton hypothèse. Si tu vois une aide utile, propose-la dans le fil principal. Sinon, ne dis rien (réponds exactement SILENCE).` +
        (h.fiche === undefined ? "" : ` Sa fiche : ${h.fiche}`),
    );
  }
  if (hits.some((h) => h.private)) lines.push(PRIVATE_COACH_NOTE);
  return lines.join("\n");
}
