/**
 * Destinations fournisseur autorisées par runtime (allowlist du relais). Chaque hôte est
 * relevé dans la documentation officielle ou, à défaut, dans le code source officiel du
 * CLI, à la date indiquée ; la liste doit être revérifiée à chaque mise à jour d'un
 * adapter (AGENTS §5 « Transparence »). Noms exacts seulement : aucun joker, aucun
 * sous-domaine implicite. Le port est toujours 443 (TLS).
 *
 * Hôtes volontairement absents (télémétrie, mises à jour, marketplaces, connecteurs) : le
 * CLI les tente parfois, le relais les refuse et le journalise ; les variables de
 * `PROVIDER_ENVIRONMENT` désactivent ce trafic quand le CLI le permet.
 */

import type { NetworkDestination } from "../contracts/index.js";

export type ProviderRuntime = "codex" | "claude" | "gemini";

export const PROVIDER_RUNTIMES: readonly ProviderRuntime[] = ["codex", "claude", "gemini"];

export interface ProviderDestination extends NetworkDestination {
  /** Où le besoin a été constaté (vérifié le 29 octobre 2026). */
  readonly source: string;
}

const https = (host: string, purpose: string, source: string): ProviderDestination => ({
  host,
  ports: [443],
  purpose,
  source,
});

const CLAUDE_NETWORK_DOC = "https://code.claude.com/docs/en/network-config";
const CODEX_PROVIDER_SRC =
  "github.com/openai/codex codex-rs/model-provider-info/src/lib.rs, codex-rs/login/src/auth/manager.rs";
const GEMINI_SRC =
  "github.com/google-gemini/gemini-cli packages/core/src/code_assist/{server,oauth2}.ts, docs/reference/configuration.md";

export const PROVIDER_DESTINATIONS: Readonly<
  Record<ProviderRuntime, readonly ProviderDestination[]>
> = {
  codex: [
    https("api.openai.com", "API OpenAI (clé API)", CODEX_PROVIDER_SRC),
    https(
      "chatgpt.com",
      "backend Codex de la connexion ChatGPT (/backend-api/codex)",
      CODEX_PROVIDER_SRC,
    ),
    https("auth.openai.com", "rafraîchissement et révocation OAuth", CODEX_PROVIDER_SRC),
  ],
  claude: [
    https("api.anthropic.com", "requêtes de l'API Claude", CLAUDE_NETWORK_DOC),
    https("claude.ai", "authentification du compte claude.ai", CLAUDE_NETWORK_DOC),
    https(
      "platform.claude.com",
      "échange, rafraîchissement et révocation du jeton OAuth",
      CLAUDE_NETWORK_DOC,
    ),
  ],
  gemini: [
    https("cloudcode-pa.googleapis.com", "Code Assist (connexion Google)", GEMINI_SRC),
    https("generativelanguage.googleapis.com", "API Gemini (clé API)", GEMINI_SRC),
    https("oauth2.googleapis.com", "rafraîchissement du jeton OAuth Google", GEMINI_SRC),
    https("www.googleapis.com", "profil du compte (oauth2/v2/userinfo)", GEMINI_SRC),
  ],
};

/**
 * Variables non secrètes ajoutées à l'environnement du CLI : réduisent le trafic non
 * essentiel. `NODE_USE_ENV_PROXY` fait suivre `HTTPS_PROXY` au `fetch` natif de Node 24.
 */
export const PROVIDER_ENVIRONMENT: Readonly<
  Record<ProviderRuntime, Readonly<Record<string, string>>>
> = {
  codex: { NODE_USE_ENV_PROXY: "1" },
  claude: {
    NODE_USE_ENV_PROXY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  },
  gemini: { NODE_USE_ENV_PROXY: "1" },
};

/** Normalise un nom d'hôte (casse, point final). */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

/**
 * Allowlist effective : le catalogue vérifié du runtime, restreint aux hôtes que la policy
 * mentionne (`network.providerTransportDestinations`) quand elle en fournit. La policy peut
 * réduire la liste, pas l'élargir au-delà des hôtes vérifiés.
 */
export function providerAllowlist(
  runtime: ProviderRuntime,
  policy?: readonly NetworkDestination[],
): readonly NetworkDestination[] {
  const catalogue = PROVIDER_DESTINATIONS[runtime];
  if (policy === undefined) return catalogue;
  return catalogue.flatMap((dest) => {
    const granted = policy.filter((p) => normalizeHost(p.host) === dest.host);
    if (granted.length === 0) return [];
    const ports = dest.ports.filter((port) => granted.some((g) => g.ports.includes(port)));
    return ports.length === 0 ? [] : [{ ...dest, ports }];
  });
}
