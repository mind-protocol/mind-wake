/** First conversation setup. JSON is private implementation data, never a human prerequisite. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { nativeCodexPolicy } from "./codex-policy.mjs";
import { codexRuntimeEnv } from "./installation.mjs";
import { nodeArgs } from "./start-local.mjs";

function read(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1000000)
      throw Error("Fichier local invalide : " + path.basename(file));
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function write(file, value) {
  const temp = file + "." + randomUUID() + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  try {
    // Windows scanners can briefly hold the destination after a read. Keep atomic
    // replacement and retry only sharing failures, without truncating the old file.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temp, file);
        break;
      } catch (error) {
        if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          Math.min(20 * 2 ** attempt, 200),
        );
      }
    }
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function acquire(lock) {
  const ownerFile = path.join(lock, "owner.json");
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = read(ownerFile);
    if (!Number.isInteger(owner?.pid) || owner.pid <= 0)
      throw Error(
        "Un premier accueil est en cours ou son verrou doit être vérifié par l’agent installateur.",
      );
    let alive = true;
    try {
      process.kill(owner.pid, 0);
    } catch (failure) {
      if (failure.code === "ESRCH") alive = false;
    }
    if (alive) throw Error("Un premier accueil est déjà en cours sur ce profil.");
    fs.unlinkSync(ownerFile);
    fs.rmdirSync(lock);
    fs.mkdirSync(lock);
  }
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
  return () => {
    fs.unlinkSync(ownerFile);
    fs.rmdirSync(lock);
  };
}
export function settings(options = {}) {
  const model = options.model ?? "gpt-6.1-sol";
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  nativeCodexPolicy({ model, timeZone });
  const sources = [
    ...new Set(
      (options.sources ?? []).map((source) => {
        if (typeof source !== "string" || !path.isAbsolute(source) || source.includes("\0"))
          throw Error("Chaque source partagée doit être un dossier absolu.");
        if (!fs.statSync(source).isDirectory()) throw Error("Source introuvable : " + source);
        return fs.realpathSync(source);
      }),
    ),
  ];
  return { model, timeZone, sources };
}
export function prepareOnboarding(dataDir, options = {}) {
  const file = path.join(dataDir, "installation/onboarding.json");
  const previous = read(file);
  if (previous) return previous; // A rerun cannot widen the approved sources or reset progress.
  const record = { version: 1, settings: settings(options), preparedAt: new Date().toISOString() };
  write(file, record);
  return record;
}

/** Derived from local runtime evidence, not from a successful installer exit. */
export function conversationProgress(record, status, messages) {
  const profile = status.profile;
  const state = profile?.state;
  const result = {
    stage: "consent",
    settings: record?.settings ?? settings(),
    evidence: {},
    profileState: state,
    activeRevisionId: profile?.activePolicyRevisionId ?? null,
    nativeApproved: Boolean(
      record?.acceptedAt ||
      (record?.revisionId && profile?.activePolicyRevisionId === record.revisionId),
    ),
  };
  if (!profile) return { ...result, stage: "unprepared" };
  if (profile.activePolicyRevisionId && !record?.revisionId)
    return { ...result, stage: "existing" };
  if (record?.completedAt)
    return { ...result, stage: "complete", evidence: record.completionEvidence };
  if (["paused", "stopped", "blocked"].includes(state) || profile.emergencyStopLocked)
    return { ...result, stage: "held", reason: profile.stateReason ?? state };
  if (!record?.requestedAt)
    return {
      ...result,
      stage: "consent",
      error: record?.error,
    };
  const since = Date.parse(record.requestedAt);
  if (status.daemon?.state === "crashed" && Date.parse(status.daemon.startedAt) >= since)
    return {
      ...result,
      stage: "error",
      error: status.daemon.endReason ?? "Le moteur a été interrompu. Consulter daemon.log.",
    };
  const newSession =
    status.lastSession &&
    !status.lastSession.simulated &&
    status.lastSession.sessionId !== record.baselineSessionId;
  const failed =
    newSession &&
    ["failed", "orphaned"].includes(status.lastSession.outcome) &&
    !["running", "checkpointing"].includes(state);
  if (failed) return { ...result, stage: "error", error: status.lastSession.reason };
  const real =
    status.daemon?.mode === "real" &&
    (state === "running" || state === "checkpointing" || newSession);
  if (!real)
    return {
      ...result,
      stage: record.error ? "error" : "starting",
      error: record.error,
      reason: status.lastSession?.reason,
    };
  const agent = [
    ...(messages.agentMessages ?? []).map((m) => ({ id: m.id, at: m.createdAt })),
    ...(messages.publicActivity ?? []).filter((m) => m.kind === "final" && !m.source),
    ...(messages.agentNote?.text?.trim()
      ? [{ id: "legacy-note", at: messages.agentNote.updatedAt }]
      : []),
  ]
    .filter((m) => Number.isFinite(Date.parse(m.at)) && Date.parse(m.at) >= since)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const hello = agent[0];
  const human = (messages.replies ?? []).find(
    (m) => hello && Date.parse(m.at) > Date.parse(hello.at),
  );
  const deliveredAt = human && messages.deliveryReceipts?.[human.id];
  const answer = deliveredAt && agent.find((m) => Date.parse(m.at) > Date.parse(deliveredAt));
  return {
    ...result,
    stage: answer ? "complete" : human ? "reply_pending" : hello ? "awaiting_human" : "working",
    evidence: {
      sessionId: status.lastSession?.sessionId ?? null,
      greetingId: hello?.id ?? null,
      humanReplyId: human?.id ?? null,
      deliveredAt: deliveredAt || null,
      answerId: answer?.id ?? null,
    },
    reason: profile.stateReason,
    error: record.error,
  };
}

export function onboardingService(manifestFile, dependencies = {}) {
  const m = { ...read(manifestFile), manifestFile };
  if (m.version !== 1 || !m.dataDir || !m.repoDir || !m.node) throw Error("Installation inconnue.");
  const file = path.join(m.dataDir, "installation/onboarding.json");
  const cli =
    dependencies.cli ??
    ((args) => {
      const result = spawnSync(
        m.node,
        [path.join(m.repoDir, "dist/cli/main.js"), ...args, "--data-dir", m.dataDir, "--json"],
        {
          cwd: m.repoDir,
          env: { ...process.env, ...codexRuntimeEnv(m) },
          encoding: "utf8",
          windowsHide: true,
          timeout: 30000,
        },
      );
      let envelope;
      try {
        envelope = JSON.parse(result.stdout);
      } catch {
        throw Error("Commande Wake sans réponse : " + args[0]);
      }
      if (
        result.error ||
        result.status !== 0 ||
        envelope.ok !== true ||
        envelope.data?.status === "rejected" ||
        envelope.data?.enabled === false
      )
        throw Error(
          envelope.error?.message ??
            envelope.data?.detail ??
            JSON.stringify(
              envelope.data?.issues ??
                envelope.data?.refusal ??
                "Commande Wake refusée : " + args[0],
            ),
        );
      return envelope.data;
    });
  const startEngine =
    dependencies.startEngine ??
    (() =>
      new Promise((resolve, reject) => {
        const log = fs.openSync(path.join(m.dataDir, "daemon.log"), "a");
        try {
          const child = spawn(
            m.node,
            [
              ...nodeArgs(m),
              path.join(m.repoDir, "scripts/engine-supervisor.mjs"),
              "--manifest",
              manifestFile,
            ],
            {
              cwd: m.repoDir,
              env: { ...process.env, ...codexRuntimeEnv(m), MIND_WAKE_DATA_DIR: m.dataDir },
              detached: true,
              windowsHide: true,
              stdio: ["ignore", log, log],
            },
          );
          child.once("error", reject);
          child.once("spawn", () => {
            child.unref();
            resolve();
          });
        } finally {
          fs.closeSync(log);
        }
      }));
  const requestWake =
    dependencies.requestWake ??
    (async () => {
      // Queue an opportunity without using `wake`, whose interactive semantics can resume Pause.
      const { requestHumanWake } = await import(
        pathToFileURL(path.join(m.repoDir, "dist/daemon/human-wake.js")).href
      );
      requestHumanWake(m.dataDir, Date.now());
    });
  const status = () => {
    const record = read(file);
    const current = cli(["status"]);
    const progress = conversationProgress(
      record,
      current,
      record?.requestedAt && !record.completedAt ? cli(["messages"]) : {},
    );
    if (progress.stage === "complete" && !record.completedAt) {
      let release;
      try {
        release = acquire(path.join(m.dataDir, "installation/onboarding.lock"));
      } catch {
        return progress;
      } // An action in progress owns the durable state.
      try {
        const latest = read(file);
        if (latest.requestedAt === record.requestedAt && latest.revisionId === record.revisionId)
          write(file, {
            ...latest,
            completedAt: new Date().toISOString(),
            completionEvidence: progress.evidence,
          });
      } finally {
        release();
      }
    }
    return progress;
  };
  const start = async ({ acceptNative = false } = {}) => {
    if (!acceptNative)
      throw Error("L’accord pour le mode natif et l’utilisation de l’abonnement est requis.");
    const lock = path.join(m.dataDir, "installation/onboarding.lock");
    const release = acquire(lock);
    let record;
    try {
      record = read(file) ?? prepareOnboarding(m.dataDir);
      if (!record.acceptedAt) {
        record = { ...record, acceptedAt: new Date().toISOString() };
        write(file, record);
      }
      let current = cli(["status"]);
      if (!current.profile) throw Error("Terminer le setup local avant le premier réveil.");
      if (
        ["paused", "stopped", "blocked"].includes(current.profile.state) ||
        current.profile.emergencyStopLocked
      )
        throw Error(
          "Wake est en pause, arrêté ou bloqué. Le premier accueil ne modifie pas cet état.",
        );
      if (current.profile.activePolicyRevisionId && !record.revisionId)
        throw Error(
          "Ce profil possède déjà une configuration. Utiliser ses contrôles habituels, ou choisir un profil neuf.",
        );
      if (
        current.profile.activePolicyRevisionId &&
        current.profile.activePolicyRevisionId !== record.revisionId
      )
        throw Error(
          "La configuration active a changé ailleurs. La conserver et relire les choix avec l’agent installateur.",
        );
      if (!current.profile.activePolicyRevisionId) {
        if (!record.revisionId && cli(["policy", "show"]).revisionCount > 0)
          throw Error(
            "Ce profil possède déjà une configuration en attente. La conserver ou choisir un profil neuf.",
          );
        const workspace = cli(["wake-history"]).locations.workspace;
        fs.mkdirSync(workspace, { recursive: true });
        const authorizationsFile = path.join(workspace, "AUTORISATIONS.json");
        const scope = [workspace, ...record.settings.sources].join("\n");
        const authorizations = {
          version: 1,
          title: "Autorisations de mon agent",
          context: "Choix confirmés au premier accueil sur ce poste.",
          example: "",
          guidance:
            "Le mode natif agit avec les accès Windows : ces choix ne sont pas une sandbox. Les sources partagées sont en lecture seule. Pause, arrêt et limites fournisseur restent applicables. Tout autre accès privé, envoi à un tiers, publication ou dépense demande un accord distinct.",
          entries: [
            {
              id: "W01",
              action: "Explorer, créer et entretenir ma mémoire",
              decision: "authorized",
              scope: workspace,
              category: "build",
            },
            {
              id: "W02",
              action: "Lire les sources partagées pour comprendre mon humain",
              decision: "authorized",
              scope,
              category: "find_out",
            },
            {
              id: "W03",
              action: "Converser avec mon humain dans Wake",
              decision: "authorized",
              scope: "Canal local de cette application.",
              category: "connect",
            },
          ],
        };
        const existingAuthorizations = read(authorizationsFile);
        if (
          existingAuthorizations &&
          JSON.stringify(existingAuthorizations) !== JSON.stringify(authorizations)
        )
          throw Error(
            "Des autorisations personnelles existent déjà. Les conserver et les examiner avec l’agent installateur ; choisir un profil neuf pour cet accueil.",
          );
        if (!existingAuthorizations)
          fs.writeFileSync(authorizationsFile, JSON.stringify(authorizations, null, 2) + "\n", {
            flag: "wx",
            mode: 0o600,
          });
        if (!record.revisionId) {
          const policyFile = path.join(m.dataDir, "installation/first-wake-policy.json");
          write(policyFile, nativeCodexPolicy(record.settings));
          const proposed = cli(["policy", "configure", policyFile]);
          if (typeof proposed.revisionId !== "string")
            throw Error("Révision de configuration non confirmée.");
          record = { ...record, revisionId: proposed.revisionId };
          write(file, record);
        }
        // Re-read immediately before enabling: never clear a stop made in another window.
        current = cli(["status"]);
        if (current.profile.state !== "disabled" || current.profile.emergencyStopLocked)
          throw Error(
            "Le profil a changé pendant la préparation. Relire son état avant de poursuivre.",
          );
        cli(["enable", "--revision", record.revisionId]);
        record = { ...record, consentedAt: new Date().toISOString() };
        write(file, record);
      }
      current = cli(["status"]);
      if (
        !["ready", "hibernating", "running", "checkpointing"].includes(current.profile.state) ||
        current.profile.emergencyStopLocked
      )
        throw Error("Le profil ne permet pas de démarrer. Pause et arrêt sont conservés.");
      const retry =
        record.error ||
        (current.lastSession &&
          current.lastSession.sessionId !== record.baselineSessionId &&
          ["failed", "orphaned"].includes(current.lastSession.outcome));
      if (
        !record.requestedAt ||
        (retry && ["ready", "hibernating"].includes(current.profile.state))
      ) {
        record = {
          ...record,
          requestedAt: new Date().toISOString(),
          baselineSessionId: current.lastSession?.sessionId ?? null,
          error: null,
        };
        write(file, record);
        await requestWake();
      }
      current = cli(["status"]);
      if (
        !["ready", "hibernating", "running", "checkpointing"].includes(current.profile.state) ||
        current.profile.emergencyStopLocked
      )
        throw Error(
          "Le profil a été mis en pause ou arrêté. Aucun moteur lancé par le premier accueil.",
        );
      if (current.daemon?.state !== "running") await startEngine();
      record.error = null;
      write(file, record);
      return status();
    } catch (error) {
      if (record) {
        try {
          write(file, { ...record, error: error.message });
        } catch {
          /* Preserve the original failure if the progress file itself is unavailable. */
        }
      }
      throw error;
    } finally {
      release();
    }
  };
  return { status, start };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        "data-dir": { type: "string" },
        "accept-native": { type: "boolean" },
        json: { type: "boolean" },
      },
    });
    const dataDir = values["data-dir"] ?? process.env.MIND_WAKE_DATA_DIR;
    if (!dataDir) throw Error("Dossier de données requis.");
    const service = onboardingService(
      path.join(path.resolve(dataDir), "installation/manifest.json"),
    );
    const action = positionals[0] ?? "status";
    if (!["status", "start"].includes(action))
      throw Error("Utiliser onboarding.mjs status ou start --accept-native.");
    const data =
      action === "start"
        ? await service.start({ acceptNative: values["accept-native"] })
        : service.status();
    console.log(JSON.stringify({ ok: true, data }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: { message: error.message } }));
    process.exitCode = 1;
  }
}
