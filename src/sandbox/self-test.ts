/**
 * Autotest de refus (A09) : lance une sonde native DANS un conteneur réel et vérifie que le
 * système refuse chaque sortie. Utilisé par `doctor` (l'isolation n'est « présente » que si
 * tout passe) et par les tests de recette.
 *
 * Effets temporaires, tous annulés et vérifiés à la fin, même en cas d'échec : un profil
 * AppContainer éphémère (clé HKCU de correspondance et dossier `%LOCALAPPDATA%\Packages`),
 * des ACE sur des dossiers créés dans le dossier temporaire, ces dossiers eux-mêmes.
 * Aucun droit administrateur, aucune règle pare-feu, aucun accès réseau sortant (sauf
 * `externalTcp`, réservé aux tests, qui doit être refusé par le système).
 *
 * Le secret est factice et la sonde ne rapporte que des codes d'erreur et des tailles.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { brokerPipeName } from "./broker.js";
import {
  ephemeralProfileName,
  parseJson,
  Sandbox,
  type SandboxedProcess,
  type SandboxLaunchSpec,
} from "./sandbox.js";

/** Codes Windows attendus d'un refus système. */
const ERROR_ACCESS_DENIED = 5;
const WSAEACCES = 10013;

export type CheckOutcome = "denied" | "allowed" | "not_demonstrable";

export interface SelfTestCheck {
  readonly id: string;
  readonly expected: "denied" | "allowed";
  readonly outcome: CheckOutcome;
  /** Code d'erreur Windows rapporté par le système (0 si l'opération a réussi). */
  readonly code: number | null;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface SelfTestTermination {
  readonly confirmed: boolean;
  readonly elapsedMs: number;
  readonly kernelMs: number | null;
  /** Processus de l'arborescence (principal, enfant, petit-enfant) encore vivants après. */
  readonly survivors: number;
  readonly treeSize: number;
}

export interface SelfTestCleanup {
  readonly aclRemoved: boolean;
  readonly profileRemoved: boolean;
  readonly tempRemoved: boolean;
}

export interface IsolationSelfTestReport {
  readonly passed: boolean;
  readonly platform: NodeJS.Platform;
  readonly profile: string | null;
  readonly checks: readonly SelfTestCheck[];
  readonly termination: SelfTestTermination | null;
  readonly cleanup: SelfTestCleanup | null;
  /** Ce que l'autotest n'a pas pu démontrer sur ce poste. */
  readonly notDemonstrated: readonly string[];
  readonly durationMs: number;
  readonly error?: string;
}

export interface SelfTestOptions {
  readonly platform?: NodeJS.Platform;
  /** Dossier temporaire parent (défaut : `os.tmpdir()`). */
  readonly tempParent?: string;
  /**
   * Tentatives vers l'extérieur (tests seulement, jamais `doctor`) : connexion TCP
   * `hôte:port` et résolution DNS d'un nom public. Les deux doivent être refusées.
   */
  readonly externalNetwork?: { readonly tcp?: string; readonly dnsName?: string };
  /** Borne de terminaison exigée (ADR-003 : 1 s). */
  readonly terminationBoundMs?: number;
}

interface ProbeResult {
  readonly op: string;
  readonly ok: boolean;
  readonly code: number;
  readonly [key: string]: unknown;
}

const FAKE_SECRET_ENV = "MIND_WAKE_FAKE_SECRET";

type LaunchProbe = (args: readonly string[], extra: Partial<SandboxLaunchSpec>) => SandboxedProcess;

export async function runIsolationSelfTest(
  options: SelfTestOptions = {},
): Promise<IsolationSelfTestReport> {
  const begin = performance.now();
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      passed: false,
      platform,
      profile: null,
      checks: [],
      termination: null,
      cleanup: null,
      notDemonstrated: [],
      durationMs: performance.now() - begin,
      error: "isolation démontrée sous Windows seulement (ADR-003)",
    };
  }

  const base = fs.mkdtempSync(path.join(options.tempParent ?? os.tmpdir(), "mindwake-selftest-"));
  const dirs = {
    build: path.join(base, "build"),
    root: path.join(base, "root"),
    runtime: path.join(base, "runtime"),
    outside: path.join(base, "outside"),
    control: path.join(base, "control"),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir);

  const sandbox = new Sandbox(dirs.build, ephemeralProfileName());
  const roots = { readWrite: [dirs.root], readOnly: [dirs.runtime] };
  const servers: net.Server[] = [];
  let checks: SelfTestCheck[] = [];
  let termination: SelfTestTermination | null = null;
  const notDemonstrated: string[] = [];
  let error: string | undefined;
  try {
    if (!sandbox.status.available) throw new Error(sandbox.status.reason);
    const probe = path.join(dirs.runtime, "probe.exe");
    fs.copyFileSync(sandbox.status.launcherPath, probe);
    const fixtures = prepareFixtures(dirs, notDemonstrated);
    sandbox.ensureProfile();

    let loopbackAccepted = 0;
    const loopback = await listen(
      net.createServer((socket) => {
        loopbackAccepted += 1;
        socket.destroy();
      }),
      { host: "127.0.0.1", port: 0 },
    );
    servers.push(loopback);
    const echo = await listen(
      net.createServer((socket) => socket.pipe(socket)),
      { host: "127.0.0.1", port: 0 },
    );
    servers.push(echo);
    let foreignAccepted = 0;
    const foreignPipe = `mindwake-foreign-${randomBytes(8).toString("hex")}`;
    servers.push(
      await listen(
        net.createServer((socket) => {
          foreignAccepted += 1;
          socket.end("pong\n");
        }),
        { path: `\\\\.\\pipe\\${foreignPipe}` },
      ),
    );
    const brokerPipe = brokerPipeName();
    const launch: LaunchProbe = (args, extra) =>
      sandbox.launch({
        jobName: `Local\\mindwake-selftest-${randomBytes(8).toString("hex")}`,
        executable: probe,
        args: ["probe", ...args],
        readWriteRoots: roots.readWrite,
        readOnlyRoots: roots.readOnly,
        protectedPaths: [dirs.control],
        maxWallMs: 30_000,
        ...extra,
      });

    // 1. Fichiers, liens, réseau, secrets, administration.
    const ops: [id: string, op: string][] = [
      ["write_inside_root", `write:${path.join(dirs.root, "written.txt")}`],
      ["read_inside_root", `read:${fixtures.inside}`],
      ["write_outside_root", `write:${path.join(dirs.outside, "escape.txt")}`],
      ["read_secret_outside_root", `read:${fixtures.secret}`],
      ["list_outside_root", `list:${dirs.outside}`],
      [
        "write_user_temp",
        `write:${path.join(os.tmpdir(), `mindwake-escape-${randomBytes(4).toString("hex")}.txt`)}`,
      ],
      ["read_via_junction", `read:${path.join(fixtures.junction, "secret.txt")}`],
      ["write_via_junction", `write:${path.join(fixtures.junction, "escape.txt")}`],
      ["create_junction", `junction:${path.join(dirs.root, "new-junction")}|${dirs.outside}`],
      ["create_hardlink", `hardlink:${path.join(dirs.root, "hardlink.txt")}|${fixtures.secret}`],
      ["write_control_db", `write:${fixtures.db}`],
      ["read_control_db", `read:${fixtures.db}`],
      ["tcp_loopback", `tcp:127.0.0.1:${String(port(loopback))}`],
      ["foreign_pipe", `pipe:${foreignPipe}`],
      ["broker_pipe", `pipe:${brokerPipe}`],
      ["parent_env_secret", `env:${FAKE_SECRET_ENV}`],
      ["open_daemon_process", `openproc:${String(process.pid)}`],
      ["registry_write", "regwrite:Software\\MindWakeSelfTestProbe"],
      ["job_breakaway", "breakaway"],
    ];
    if (fixtures.symlink !== null) {
      ops.push(["read_via_symlink", `read:${fixtures.symlink}`]);
    }
    const external = options.externalNetwork;
    if (external?.tcp !== undefined) ops.push(["tcp_external", `tcp:${external.tcp}`]);
    if (external?.dnsName !== undefined) ops.push(["dns_external", `dns:${external.dnsName}`]);
    const main = await collect(
      withSecretEnv(() =>
        launch(
          ops.map(([, op]) => op),
          { broker: { pipeName: brokerPipe, port: port(echo) } },
        ),
      ),
      ops.length,
    );
    checks = ops.map(([id], i) => judge(id, main.results[i]));
    checks.push({
      id: "loopback_connections_accepted",
      expected: "denied",
      outcome: loopbackAccepted === 0 ? "denied" : "allowed",
      code: null,
      passed: loopbackAccepted === 0,
      detail: `connexions acceptées par le serveur loopback : ${String(loopbackAccepted)}`,
    });
    checks.push({
      id: "foreign_pipe_connections_accepted",
      expected: "denied",
      outcome: foreignAccepted === 0 ? "denied" : "allowed",
      code: null,
      passed: foreignAccepted === 0,
      detail: `connexions acceptées par le pipe étranger : ${String(foreignAccepted)}`,
    });
    checks.push(rootsIntact(dirs, fixtures.secret));
    if (!main.exit.aclRevoked) error = "ACE non retirées après le lancement principal";

    // 2. Limites du job : mémoire puis nombre de processus.
    const limits = await collect(
      launch(["alloc:512", "spawn-many:6"], { maxProcesses: 3, memoryLimitMb: 128 }),
      2,
    );
    checks.push(judge("job_memory_limit", limits.results[0]));
    checks.push(judge("job_process_limit", limits.results[1]));

    // 3. Arborescence non coopérative : enfant + petit-enfant, terminaison mesurée.
    termination = await treeTermination(launch, options.terminationBoundMs ?? 1_000);
    checks.push({
      id: "grandchild_survives_kill",
      expected: "denied",
      outcome: termination.survivors === 0 && termination.confirmed ? "denied" : "allowed",
      code: null,
      passed:
        termination.confirmed &&
        termination.survivors === 0 &&
        termination.treeSize === 3 &&
        termination.elapsedMs <= (options.terminationBoundMs ?? 1_000),
      detail: `${String(termination.treeSize)} processus, ${termination.elapsedMs.toFixed(1)} ms, survivants : ${String(termination.survivors)}`,
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  }
  const cleanup = cleanUp(sandbox, roots, base);
  const passed =
    error === undefined &&
    checks.length > 0 &&
    checks.every((c) => c.passed) &&
    cleanup.aclRemoved &&
    cleanup.profileRemoved &&
    cleanup.tempRemoved;
  return {
    passed,
    platform,
    profile: sandbox.profile,
    checks,
    termination,
    cleanup,
    notDemonstrated,
    durationMs: performance.now() - begin,
    ...(error === undefined ? {} : { error }),
  };
}

interface Fixtures {
  readonly inside: string;
  readonly secret: string;
  readonly junction: string;
  readonly symlink: string | null;
  readonly db: string;
}

function prepareFixtures(
  dirs: Readonly<Record<"root" | "outside" | "control", string>>,
  notDemonstrated: string[],
): Fixtures {
  const inside = path.join(dirs.root, "inside.txt");
  fs.writeFileSync(inside, "fichier de la racine accordée\n");
  const secret = path.join(dirs.outside, "secret.txt");
  fs.writeFileSync(secret, `FAKE-SECRET-${randomBytes(16).toString("hex")}\n`);
  // Jonction préexistante racine → dehors, posée par l'utilisateur (aucun privilège requis).
  const junction = path.join(dirs.root, "escape-junction");
  fs.symlinkSync(dirs.outside, junction, "junction");
  // Symlink préexistant : exige SeCreateSymbolicLinkPrivilege ou le mode développeur.
  let symlink: string | null = path.join(dirs.root, "escape-symlink.txt");
  try {
    fs.symlinkSync(secret, symlink, "file");
  } catch (caught) {
    symlink = null;
    notDemonstrated.push(
      `traversée d'un symlink préexistant : création impossible sans privilège ni mode développeur (${(caught as NodeJS.ErrnoException).code ?? "erreur"})`,
    );
  }
  // Base de contrôle SQLite réelle, hors de toute racine.
  const db = path.join(dirs.control, "wake.sqlite");
  const handle = new Database(db);
  handle.exec("CREATE TABLE control (id INTEGER PRIMARY KEY, value TEXT)");
  handle.close();
  return { inside, secret, junction, symlink, db };
}

/** Verdict d'une tentative : un refus doit venir du système (code d'accès refusé). */
function judge(id: string, result: ProbeResult | undefined): SelfTestCheck {
  if (result === undefined) {
    return {
      id,
      expected: "denied",
      outcome: "not_demonstrable",
      code: null,
      passed: false,
      detail: "aucun résultat de la sonde",
    };
  }
  const allowedExpected = new Set(["write_inside_root", "read_inside_root", "broker_pipe"]);
  const expected = allowedExpected.has(id) ? "allowed" : "denied";
  const outcome: CheckOutcome = result.ok ? "allowed" : "denied";
  let passed = outcome === expected;
  let detail: string | undefined;
  if (expected === "denied" && !result.ok) {
    switch (id) {
      case "parent_env_secret":
        detail = "variable absente : environnement construit explicitement par le lanceur";
        break;
      case "tcp_loopback":
        // Le loopback est filtré sans réponse (délai) ou refusé (EACCES) selon la pile.
        passed = result.code === WSAEACCES || result.code === 10060;
        break;
      case "tcp_external":
        passed = result.code === WSAEACCES;
        break;
      case "dns_external":
        detail = "résolution impossible dans le conteneur (WSAHOST_NOT_FOUND = 11001)";
        break;
      case "job_memory_limit":
        detail = `allocation interrompue à ${String(result["allocatedMb"])} Mio`;
        break;
      case "job_process_limit":
        passed = Number(result["refused"]) > 0;
        detail = `lancés : ${String(result["started"])}, refusés : ${String(result["refused"])}`;
        break;
      default:
        passed = result.code === ERROR_ACCESS_DENIED;
    }
  }
  if (id === "broker_pipe" && result.ok) {
    passed = result["reply"] === "ping";
    detail = "seul canal sortant : relayé par le lanceur vers le broker loopback";
  }
  return {
    id,
    expected,
    outcome,
    code: result.code,
    passed,
    ...(detail === undefined ? {} : { detail }),
  };
}

/** Vérifie depuis le daemon que rien n'a franchi la frontière (fichiers hors racine). */
function rootsIntact(dirs: Readonly<Record<"outside", string>>, secret: string): SelfTestCheck {
  const outside = fs.readdirSync(dirs.outside);
  const intact = outside.length === 1 && path.join(dirs.outside, outside[0] ?? "") === secret;
  return {
    id: "outside_unchanged",
    expected: "denied",
    outcome: intact ? "denied" : "allowed",
    code: null,
    passed: intact,
    detail: `contenu du dossier extérieur : ${outside.join(", ")}`,
  };
}

async function collect(
  proc: SandboxedProcess,
  expected: number,
): Promise<{ results: ProbeResult[]; exit: Awaited<SandboxedProcess["exited"]> }> {
  await proc.started();
  const results: ProbeResult[] = [];
  for (;;) {
    const line = await proc.readLine();
    if (line === null) break;
    const result = parseProbe(line);
    if (result !== null) results.push(result);
    if (results.length === expected) break;
  }
  const exit = await proc.exited;
  return { results, exit };
}

async function treeTermination(launch: LaunchProbe, boundMs: number): Promise<SelfTestTermination> {
  const proc = launch(["spawn:tree", "sleep:60000"], {});
  const main = await proc.started();
  let child = 0;
  let grandchild = 0;
  const deadline = Date.now() + 15_000;
  while ((child === 0 || grandchild === 0) && Date.now() < deadline) {
    const line = await Promise.race([proc.readLine(), sleep(15_000).then(() => null)]);
    if (line === null) break;
    const result = parseProbe(line);
    if (result?.op === "spawn" && typeof result["pid"] === "number") child = result["pid"];
    if (result?.op === "grandchild" && typeof result["pid"] === "number")
      grandchild = result["pid"];
  }
  const pids = [main, child, grandchild].filter((pid) => pid > 0);
  const aliveBefore = pids.filter(isAlive).length;
  const result = await proc.terminateTree(boundMs);
  await proc.exited;
  // Le noyau a confirmé zéro processus actif ; on vérifie aussi chaque PID depuis dehors.
  const survivors = pids.filter(isAlive).length;
  return {
    confirmed: result.confirmed,
    elapsedMs: result.elapsedMs,
    kernelMs: result.kernelMs,
    survivors,
    treeSize: aliveBefore,
  };
}

function cleanUp(
  sandbox: Sandbox,
  roots: { readonly readWrite: readonly string[]; readonly readOnly: readonly string[] },
  base: string,
): SelfTestCleanup {
  let aclRemoved = false;
  let profileRemoved = false;
  try {
    if (sandbox.available) {
      sandbox.revoke(roots);
      aclRemoved = sandbox.aclStatus(roots).every((a) => !a.granted);
      const status = sandbox.deleteProfile();
      profileRemoved = status.exists === false;
    } else {
      aclRemoved = true;
      profileRemoved = true;
    }
  } catch {
    // Vérification impossible : l'autotest échoue, rien n'est présumé nettoyé.
  }
  try {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // Signalé par `tempRemoved`.
  }
  return { aclRemoved, profileRemoved, tempRemoved: !fs.existsSync(base) };
}

function withSecretEnv<T>(run: () => T): T {
  // Secret factice dans l'environnement du daemon, donc du lanceur : il ne doit pas
  // atteindre le conteneur.
  const previous = process.env[FAKE_SECRET_ENV];
  process.env[FAKE_SECRET_ENV] = `FAKE-${randomBytes(8).toString("hex")}`;
  try {
    return run();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, FAKE_SECRET_ENV);
    else process.env[FAKE_SECRET_ENV] = previous;
  }
}

function parseProbe(line: string): ProbeResult | null {
  if (!line.startsWith("probe ")) return null;
  const json = parseJson(line.slice("probe ".length));
  if (json === null || typeof json["op"] !== "string") return null;
  return {
    ...json,
    op: json["op"],
    ok: json["ok"] === true,
    code: typeof json["code"] === "number" ? json["code"] : -1,
  };
}

function listen(server: net.Server, address: net.ListenOptions): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      resolve(server);
    });
  });
}

function port(server: net.Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("adresse inattendue");
  return address.port;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
