/**
 * Validation applicative d'un lancement confiné, avant tout appel au système. C'est une
 * seconde barrière : la frontière réelle reste l'AppContainer (refus du noyau), mais une
 * racine mal choisie (le disque entier, le dossier de contrôle, une racine qui contient la
 * base SQLite) accorderait au conteneur ce que la policy ne lui donne pas.
 */

import fs from "node:fs";
import path from "node:path";

/** Variables fournies au conteneur : le strict nécessaire au démarrage d'un processus. */
export const SANDBOX_BASE_ENV_KEYS = ["SystemRoot", "SystemDrive", "windir"] as const;

/**
 * Noms de variables refusés dans l'environnement du conteneur : le credential fournisseur
 * reste au broker, hors du conteneur (ADR-003 §4).
 */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE)/i;

export class SandboxSpecError extends Error {
  readonly code:
    | "root_invalid"
    | "root_overlaps_protected"
    | "root_too_broad"
    | "executable_outside_roots"
    | "env_secret_name"
    | "env_invalid"
    | "limit_invalid";

  constructor(code: SandboxSpecError["code"], message: string) {
    super(message);
    this.name = "SandboxSpecError";
    this.code = code;
  }
}

export interface RootSet {
  readonly readWrite: readonly string[];
  readonly readOnly: readonly string[];
}

/**
 * Résout chaque racine (chemin réel, liens et jonctions suivis : l'ACE porte sur la cible)
 * et vérifie qu'aucune ne contient un chemin protégé, ni n'est la racine d'un volume ou le
 * profil utilisateur entier. Retourne les chemins réels à accorder.
 */
export function resolveRoots(
  roots: RootSet,
  protectedPaths: readonly string[],
  userProfile: string | undefined = process.env["USERPROFILE"],
): RootSet {
  const guarded = protectedPaths.map((p) => realOrResolved(p));
  const broad = userProfile === undefined ? [] : [realOrResolved(userProfile)];
  const resolve = (root: string): string => {
    if (!path.isAbsolute(root)) {
      throw new SandboxSpecError("root_invalid", `racine non absolue : ${root}`);
    }
    let real: string;
    try {
      real = fs.realpathSync.native(root);
    } catch {
      throw new SandboxSpecError("root_invalid", `racine introuvable : ${root}`);
    }
    if (!fs.statSync(real).isDirectory()) {
      throw new SandboxSpecError("root_invalid", `racine qui n'est pas un dossier : ${root}`);
    }
    if (path.parse(real).root === withSep(real) || broad.some((b) => samePath(b, real))) {
      throw new SandboxSpecError("root_too_broad", `racine trop large : ${real}`);
    }
    // Une racine ne peut contenir aucun chemin protégé (base de contrôle, policy, dossier de
    // données). Un sous-dossier dédié du dossier de données (binaires runtime) reste possible.
    for (const g of guarded) {
      if (isWithin(real, g)) {
        throw new SandboxSpecError(
          "root_overlaps_protected",
          `la racine ${real} contient le chemin protégé ${g}`,
        );
      }
    }
    return real;
  };
  return { readWrite: roots.readWrite.map(resolve), readOnly: roots.readOnly.map(resolve) };
}

/** L'exécutable doit se trouver dans une racine accordée : sinon le conteneur ne peut pas le lire. */
export function assertExecutableInRoots(executable: string, roots: RootSet): void {
  const real = realOrResolved(executable);
  if (![...roots.readOnly, ...roots.readWrite].some((r) => isWithin(r, real))) {
    throw new SandboxSpecError(
      "executable_outside_roots",
      `exécutable hors des racines accordées : ${executable}`,
    );
  }
}

/**
 * Environnement complet du conteneur : variables système minimales, `LOCALAPPDATA`
 * (exigée par `CreateProcess` en AppContainer, qui la redirige vers le dossier du profil),
 * puis les variables explicitement demandées. Rien n'est hérité du daemon.
 */
export function sandboxEnvironment(
  extra: Readonly<Record<string, string>> = {},
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...SANDBOX_BASE_ENV_KEYS, "LOCALAPPDATA"]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\0\r\n]/.test(value)) {
      throw new SandboxSpecError("env_invalid", `variable invalide : ${key}`);
    }
    if (SECRET_NAME.test(key)) {
      throw new SandboxSpecError(
        "env_secret_name",
        `variable au nom de secret refusée dans le conteneur : ${key}`,
      );
    }
    env[key] = value;
  }
  return env;
}

export function assertLimit(name: string, value: number | undefined, max: number): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new SandboxSpecError("limit_invalid", `${name} invalide : ${String(value)}`);
  }
}

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function withSep(p: string): string {
  return p.endsWith(path.sep) ? p : p + path.sep;
}

function samePath(a: string, b: string): boolean {
  return path.relative(a, b) === "";
}

/** `child` est `parent` ou se trouve dessous (comparaison insensible à la casse sous Windows). */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
