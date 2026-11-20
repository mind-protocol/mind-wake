/** Filtre des fins de tour du principal : vide, remplissage, redite ; et ce qui reste relayé. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { OwnerMessages } from "./owner-messages.js";
import { principalOutputSkip, readFilterStatus } from "./principal-output-filter.js";
import { readPrincipalOutputs, recordPrincipalOutput } from "./principal-outputs.js";
import { readFil, wakeReason, type PatternHolder } from "./pattern-holders.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "po-filter-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const AT = "2026-11-20T12:40:00.000Z";

// (a) vide : ponctuation, emoji, trop peu de lettres.
it.each([".", "—", "  …  ", "👍", "🙂 ✅", "OK, fait."])("(a) skips an empty or near-empty turn: %j", (text) => {
  expect(principalOutputSkip(text, AT, [])).toMatchObject({ reason: "vide" });
});

// (b) remplissage : formule connue dans un message court, accents et casse ignorés.
it.each([
  "Rien de nouveau depuis mon dernier point. Mindset retire son rappel : l'essai tournait déjà. À 14 h, je commencerai par « tenu » ou « pas tenu ».",
  "Rien à ajouter : Narration reprend correctement où on en est.",
  "RIEN A AJOUTER, Narration a raison sur la phase.",
  "Compris : je n’écris plus dans le fil entre deux points.",
  "Pas de changement depuis 13:40 sur les sous-sessions en cours.",
  "Narration a mis à jour la phase de la salle. Je n'ai rien à corriger ni à ajouter.",
])("(b) skips a short filler turn: %j", (text) => {
  expect(principalOutputSkip(text, AT, [])).toMatchObject({ reason: "remplissage" });
});

it("(b) keeps a long message that merely contains a filler phrase", () => {
  const text = "Rien de nouveau sur le disque, mais le ticket Soda est en ligne : " +
    "https://github.com/sodadata/soda-core/issues/3018. La PR attend ton clic, et la sous-session du toggle " +
    "corrige encore l'erreur de permission avant le redéploiement du daemon.";
  expect(text.length).toBeGreaterThanOrEqual(200);
  expect(principalOutputSkip(text, AT, [])).toBeNull();
});

// (c) redite : paire réelle du 20 nov. (message du fil à 13:48:48, fin de tour à 13:49:05).
const POSTED = "Marco : Noté pour le toast « Appel entrant » qui reste affiché une fois l'appel décroché. Je l'ai confié à la sous-session de l'appel automatique, puisqu'elle travaille déjà sur ce code. Il devra se fermer quand tu décroches, quand tu refuses et quand l'appel raccroche, et on le vérifiera sur un vrai appel.";
const REPEAT = "J'ai confié le toast « Appel entrant » qui reste affiché à la sous-session qui travaille déjà sur l'appel automatique. Il devra se fermer quand tu décroches, quand tu refuses et quand l'appel raccroche. Je ne le dirai réglé qu'après l'avoir vérifié sur un vrai appel.";
// Paraphrase réelle (13:35:05 → 13:35:26) : Jaccard 0,45 seulement, mais 60 % de ses mots repris.
const POSTED_2 = "Marco : @mindset C'est déjà lancé depuis 13:32 : une sous-session passe la recette de transcription sur de vrais enregistrements de la voix de NLR, et compare le résultat au texte de référence déjà gardé. D'ici 14 h, je tente d'obtenir sa voix transcrite dans un fichier, avec la vérification des dates et des chiffres.";
const PARAPHRASE = "L'essai sur ta vraie voix tourne déjà depuis 13 h 32. Une sous-session passe la transcription sur tes propres enregistrements et compare le texte obtenu à celui déjà gardé. Elle vérifie surtout les dates et les chiffres. D'ici 14 h, l'objectif est d'avoir ta voix transcrite dans un fichier, avec ces vérifications faites.";

it("(c) skips a near-verbatim or paraphrased repeat of the agent's own post from the last 5 minutes", () => {
  expect(principalOutputSkip(REPEAT, "2026-11-20T12:49:05.000Z", [{ at: "2026-11-20T12:48:48.000Z", text: POSTED }]))
    .toMatchObject({ reason: "repetition" });
  expect(principalOutputSkip(PARAPHRASE, "2026-11-20T12:35:26.000Z", [{ at: "2026-11-20T12:35:05.000Z", text: POSTED_2 }]))
    .toMatchObject({ reason: "repetition" });
});

it("(c) does not compare with posts older than 5 minutes or posted after the turn", () => {
  expect(principalOutputSkip(REPEAT, "2026-11-20T12:54:00.000Z", [{ at: "2026-11-20T12:48:48.000Z", text: POSTED }])).toBeNull();
  expect(principalOutputSkip(REPEAT, "2026-11-20T12:48:00.000Z", [{ at: "2026-11-20T12:48:48.000Z", text: POSTED }])).toBeNull();
});

it("(c) end to end: reads the owner thread, skips, logs and counts; holders neither see nor wake on it", () => {
  const owner = new OwnerMessages(dir, "claude-wake");
  owner.publish(POSTED, "own-post-1");
  // Une intervention de holder n'est pas un message de l'agent : jamais comparée.
  owner.publish(REPEAT, "pattern-holder:critique:principal-output:x");
  owner.close();
  const at = new Date(Date.now() + 1000).toISOString();
  const lines: string[] = [];
  recordPrincipalOutput(dir, { id: "claude:s:repeat", at, text: REPEAT }, { log: (l) => lines.push(l) });
  recordPrincipalOutput(dir, { id: "claude:s:dot", at, text: "." }, { log: (l) => lines.push(l) });
  expect(readPrincipalOutputs(dir, 10)).toEqual([]);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^fin de tour non relayée \(repetition\) claude:s:repeat — /u);
  expect(lines[1]).toMatch(/^fin de tour non relayée \(vide\) claude:s:dot — /u);
  expect(readFilterStatus(dir)).toMatchObject({ skipped: 2, byReason: { vide: 1, remplissage: 0, repetition: 1 } });
  const fil = readFil(dir);
  expect(fil.some((m) => m.id.startsWith("principal-output:"))).toBe(false);
  const holder = { slug: "critique", name: "Critique", wakeOnPrincipalOutput: true } as unknown as PatternHolder;
  expect(wakeReason(holder, fil, fil.filter((m) => m.id.startsWith("principal-output:")))).toBeNull();
});

// Cas positif : une vraie fin de tour, distincte du dernier message posté, est relayée et réveille.
it("still relays a substantive turn that is distinct from the agent's recent posts", () => {
  const owner = new OwnerMessages(dir, "claude-wake");
  owner.publish("Marco : @narration Petite correction pour ta phase : le commentaire « DuckDB seul » est déjà en ligne depuis 13:26 (#3018), il n'est plus à venir.", "own-post-2");
  owner.close();
  const text = "Narration a raison, la transcription n'a pas encore été essayée sur une vraie voix. J'ai lancé une sous-session pour la tester sur tes propres enregistrements, en regardant surtout si les dates, les heures et les chiffres sortent justes. Aucun son ne sera joué.";
  const at = new Date(Date.now() + 1000).toISOString();
  const lines: string[] = [];
  recordPrincipalOutput(dir, { id: "claude:s:real", at, text }, { log: (l) => lines.push(l) });
  expect(lines).toEqual([]);
  expect(readPrincipalOutputs(dir, 10)).toEqual([expect.objectContaining({ id: "claude:s:real", text })]);
  const fil = readFil(dir);
  const holder = { slug: "critique", name: "Critique", wakeOnPrincipalOutput: true } as unknown as PatternHolder;
  expect(wakeReason(holder, fil, fil.filter((m) => m.id.startsWith("principal-output:")))).toEqual({ reason: "principal-output" });
  expect(readFilterStatus(dir).skipped).toBe(0);
});
