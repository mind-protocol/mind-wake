/**
 * Shim exécuté DANS le conteneur, devant le CLI du fournisseur. Le conteneur n'a pas de
 * réseau, mais le loopback interne à un même AppContainer est permis (mesuré : écoute et
 * connexion sur 127.0.0.1 et ::1, dans un processus et entre deux processus du même
 * conteneur ; le loopback vers l'hôte reste refusé). Le shim écoute donc sur
 * `127.0.0.1:<port libre>` et relaie chaque connexion, octet pour octet, vers le pipe du
 * broker ; il lance le CLI avec `HTTPS_PROXY=http://127.0.0.1:<port>` et les poignées
 * standard héritées, puis reprend son code de sortie.
 *
 * Le shim n'est pas une frontière : l'agent peut l'ignorer et ouvrir le pipe lui-même.
 * Toutes les décisions (allowlist, adresses, SNI, journal) restent dans le relais, hors du
 * conteneur. Source JavaScript autonome (modules natifs de Node seulement), écrite sur
 * disque par `installShim` dans une racine en lecture seule du conteneur.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SHIM_SOURCE = String.raw`// MIND Wake — shim de transport fournisseur (généré, ne pas modifier).
import net from "node:net";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const pipeAt = argv.indexOf("--pipe");
const pipeName = pipeAt >= 0 && pipeAt < sep ? argv[pipeAt + 1] : undefined;
const command = sep >= 0 ? argv.slice(sep + 1) : [];
if (typeof pipeName !== "string" || !/^[A-Za-z0-9._-]{1,200}$/.test(pipeName) || command.length === 0) {
  process.stderr.write("usage: shim --pipe <nom> -- <exe> [args...]\n");
  process.exit(2);
}
const PIPE = "\\\\.\\pipe\\" + pipeName;
// Erreurs transitoires d'ouverture du pipe (instance suivante pas encore créée).
const RETRYABLE = new Set(["ENOENT", "EBUSY", "EAGAIN", "ECONNREFUSED"]);

function relay(client) {
  client.pause();
  client.on("error", () => client.destroy());
  let attempt = 0;
  const open = () => {
    const upstream = net.connect({ path: PIPE, allowHalfOpen: true });
    let connected = false;
    upstream.once("connect", () => {
      connected = true;
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstream.on("error", (error) => {
      if (!connected && RETRYABLE.has(error.code) && attempt < 40 && !client.destroyed) {
        attempt += 1;
        setTimeout(open, 25);
        return;
      }
      client.destroy();
    });
    upstream.on("close", () => {
      if (connected) client.destroy();
    });
    client.on("close", () => upstream.destroy());
  };
  open();
}

const server = net.createServer({ allowHalfOpen: true }, relay);
server.on("error", () => process.exit(3));
server.listen(0, "127.0.0.1", () => {
  const proxy = "http://127.0.0.1:" + String(server.address().port);
  const local = "localhost,127.0.0.1,::1";
  const env = {
    ...process.env,
    HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy,
    NO_PROXY: local, no_proxy: local,
  };
  const child = spawn(command[0], command.slice(1), { stdio: "inherit", env, windowsHide: true });
  child.on("error", () => process.exit(127));
  child.on("exit", (code) => process.exit(code ?? 1));
});
`;

/** Empreinte du shim : un contenu modifié produit un nouveau nom de fichier. */
export function shimDigest(): string {
  return createHash("sha256").update(SHIM_SOURCE).digest("hex").slice(0, 16);
}

/**
 * Écrit le shim dans `dir` (racine en lecture seule du conteneur) sous un nom dérivé de son
 * empreinte, par renommage atomique. Idempotent. Extension `.mjs` : module ES sans
 * `package.json` voisin.
 */
export function installShim(dir: string): string {
  const target = path.join(dir, `mindwake-provider-shim-${shimDigest()}.mjs`);
  if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === SHIM_SOURCE) return target;
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${target}.${String(process.pid)}.${String(Date.now())}.tmp`;
  fs.writeFileSync(temp, SHIM_SOURCE, { encoding: "utf8" });
  fs.renameSync(temp, target);
  return target;
}
