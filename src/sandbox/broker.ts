/**
 * Point d'extension du transport fournisseur (ADR-002, ADR-003 §5, ADR-004).
 *
 * Le conteneur n'a aucune capacité réseau : TCP, UDP, DNS et loopback lui sont refusés par
 * le système. Le seul canal sortant possible est un pipe nommé créé par le lanceur, hors
 * du conteneur, dont le descripteur de sécurité n'accorde l'accès qu'à l'utilisateur et au
 * SID de ce conteneur (étiquette d'intégrité basse pour l'AppContainer), avec
 * `PIPE_REJECT_REMOTE_CLIENTS`. Le lanceur relaie chaque connexion, octet pour octet, vers
 * `127.0.0.1:<port>` : là écoute le broker du daemon (futur relais de budget), qui seul
 * détient le credential, applique l'allowlist des destinations fournisseur, compte et
 * borne la consommation. Sans broker, le réseau reste entièrement fermé.
 *
 * Aucune règle pare-feu, aucun droit administrateur, aucune modification persistante :
 * le pipe disparaît avec le lanceur. Ce module ne fournit que le contrat ; aucun relais
 * fournisseur n'existe encore (S11 et suivantes).
 */

import { randomBytes } from "node:crypto";

/** Canal broker d'un lancement confiné. */
export interface BrokerEndpoint {
  /** Nom du pipe sous `\\.\pipe\`, visible du conteneur. */
  readonly pipeName: string;
  /** Port loopback du broker du daemon, joignable par le seul lanceur (hors conteneur). */
  readonly port: number;
}

/**
 * Broker fournisseur du daemon, à implémenter par le relais de budget. Il reçoit des flux
 * venus du conteneur : rien de ce qu'ils contiennent n'est une autorité (AGENTS §3.8).
 */
export interface ProviderBroker {
  /** Démarre l'écoute loopback ; le port sert à construire `BrokerEndpoint`. */
  listen(): Promise<{ readonly port: number }>;
  close(): Promise<void>;
}

/** Nom de pipe imprévisible pour un lancement. */
export function brokerPipeName(): string {
  return `mindwake-broker-${randomBytes(12).toString("hex")}`;
}
