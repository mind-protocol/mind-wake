/**
 * `npm run demo:advice` : rejoue dans le terminal un scénario déterministe de conseil
 * guest distant, entièrement SIMULÉ (aucun argent, wallet, réseau public ni publication).
 *
 * Options : `--stop-after <n>` arrête la séance à l'initiative du guide après n échanges
 * (sinon : 5 échanges puis clôture normale par l'agent) ; `--keep` conserve le dossier
 * temporaire de la démo.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SIMULATION_LABEL } from "../session/index.js";
import { demoCatalog, GUIDE_SCRIPT } from "./catalog.js";
import { AdviceDemo, DEMO_SENTENCE, type DemoLine, type SettleResult } from "./scenario.js";

const { values } = parseArgs({
  options: { "stop-after": { type: "string" }, keep: { type: "boolean" } },
  strict: true,
});
const stopAfter = values["stop-after"] === undefined ? null : Number(values["stop-after"]);
if (stopAfter !== null && (!Number.isInteger(stopAfter) || stopAfter < 0 || stopAfter > 5)) {
  process.stderr.write("--stop-after : entier entre 0 et 5 attendu.\n");
  process.exit(2);
}

const PREFIX: Record<DemoLine["kind"], string> = {
  step: "   ",
  money: "[SIMULÉ] ",
  agent: "   agent  › ",
  guide: "   guide  › ",
  service: "   service· ",
  warn: "   ! ",
};
const print = (line: DemoLine): void => {
  process.stdout.write(`${PREFIX[line.kind]}${line.text}\n`);
};
const title = (text: string): void => {
  process.stdout.write(`\n== ${text}\n`);
};

process.stdout.write(
  `MIND — démo de conseil guest distant · ${SIMULATION_LABEL}\n` +
    "Trois rôles en processus séparés sur cette machine : service MIND simulé, adaptateur MCP\n" +
    "du guide, agent guest « chez lui » (dossier privé). Aucun réseau public, aucun wallet.\n",
);

const dir = mkdtempSync(join(tmpdir(), "mind-advice-demo-"));
const demo = new AdviceDemo({ dir, catalog: demoCatalog(), log: print });
let exitCode = 0;
try {
  title("1. Une phrase, matching factice, contrat et réservation fictive");
  const started = await demo.start(DEMO_SENTENCE, {
    guest: { closeAfter: stopAfter === null ? GUIDE_SCRIPT.length : 0 },
  });
  if (started.status !== "started") throw new Error(`lancement impossible : ${started.status}`);
  const { session } = started;

  title("2. Conversation (au plus 5 échanges)");
  const planned = stopAfter ?? GUIDE_SCRIPT.length;
  for (const text of GUIDE_SCRIPT.slice(0, planned)) await session.exchange(text);

  title("3. Clôture");
  if (stopAfter !== null) {
    print({ kind: "guide", text: "Arrêtons là, merci." });
    await session.requestClose("guide_stopped");
  } else {
    const summary = await session.nextAgentMessage((m) => m.inReplyTo === undefined);
    print({ kind: "agent", text: `${summary.author} [${summary.trust}] : ${summary.text}` });
    print({
      kind: "service",
      text: "synthèse de clôture : couverte par la réservation, non facturée",
    });
  }
  const closed = await session.awaitClosed();
  print({ kind: "step", text: `Contrat clôturé : ${String(closed.closeReason)}.` });

  title("4. Règlement simulé des seuls échanges accomplis");
  const settled = await session.settle();
  await session.dispose();

  title("5. Reçu SIMULÉ (sans contenu de conversation)");
  process.stdout.write(`${JSON.stringify(settled.receipt, null, 2)}\n`);
  recap(settled, demo.rail.effects().length);
} catch (error) {
  exitCode = 1;
  process.stderr.write(
    `Échec de la démo : ${error instanceof Error ? error.message : String(error)}\n`,
  );
} finally {
  await demo.close();
  if (values.keep === true) process.stdout.write(`\nDossier conservé : ${dir}\n`);
  else rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);

function recap(settled: SettleResult, transfers: number): void {
  const { receipt, contract } = settled;
  const reservation = contract.reservation;
  title("Récapitulatif");
  const rows: [string, string][] = [
    [
      "Échanges comptés",
      `${String(receipt.criteria.earnedExchanges)} / ${String(receipt.criteria.maxExchanges)}`,
    ],
    ["Motif de clôture", String(receipt.criteria.closeReason)],
    ["Montant fictif réglé", `${String(receipt.amountDue)} unités fictives (SIMULÉ)`],
    [
      "Réserve libérée",
      `${reservation === null ? "?" : String(reservation.released)} unités fictives (SIMULÉ)`,
    ],
    ["Transferts simulés", `${String(transfers)} ligne(s) dans le rail SIMULÉ local`],
    ["Statut", `${receipt.status} — aucun paiement réel n'a eu lieu`],
  ];
  for (const [label, value] of rows) process.stdout.write(`   ${label.padEnd(22)} ${value}\n`);
  process.stdout.write(
    "\nCe qui reste hypothétique :\n" +
      "   - $MIND, wallet, rail et frais réels : absents ; « réglé » signifie une écriture fictive locale.\n" +
      "   - Matching : catalogue factice de 3 agents, pas un service distant ni un marché.\n" +
      "   - Agent guest : script déterministe sans modèle ; il tourne ici dans un processus séparé\n" +
      "     qui représente le poste de l'agent, jamais dans la session du guide.\n" +
      "   - Producteurs d'événements non authentifiés cryptographiquement (P15) ; réservation ≠ escrow.\n" +
      "   - Pas de réseau public, de Telegram/WhatsApp ni de résolution humaine des litiges.\n",
  );
}
