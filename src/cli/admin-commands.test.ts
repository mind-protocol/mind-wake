/**
 * Commandes d'administration de S9 sur la base SQLite réelle : `policy configure`,
 * `enable`, `export`, `purge`, `uninstall`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PolicyRevisionId, UtcTimestamp } from "../contracts/index.js";
import { POLICY_SCHEMA_VERSION } from "../contracts/index.js";
import { openStore } from "../store/index.js";
import { validDraft } from "../../test/support/policy-fixtures.js";
import { enable, type EnableComponents } from "./commands/enable.js";
import { DEFAULT_PROFILE_ID, processContext, type CliContext } from "./context.js";
import { runCli } from "./run.js";
import { CONTROL_DB_FILE } from "./store/index.js";

const NOW = new Date("2026-10-29T10:00:00.000Z");
const ALL_COMPONENTS: EnableComponents = { isolation: true, runtimeAdapter: true };

let tmpRoot: string;
let dataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mind-wake-admin-"));
  dataDir = path.join(tmpRoot, "data");
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function context(out: string[], prompt?: (question: string) => Promise<string | null>): CliContext {
  return {
    ...processContext(),
    stdout: (text) => out.push(text),
    stderr: (text) => out.push(text),
    env: {},
    cwd: tmpRoot,
    homeDir: path.join(tmpRoot, "home"),
    now: () => NOW,
    ...(prompt === undefined ? {} : { prompt }),
  };
}

type Json = Record<string, unknown> & { data: Record<string, unknown>; ok: boolean };

async function run(...argv: string[]): Promise<{ code: number; json: Json }> {
  const out: string[] = [];
  const code = await runCli(["--data-dir", dataDir, ...argv, "--json"], context(out));
  return { code, json: JSON.parse(out.join("")) as Json };
}

function writeDraft(draft: unknown, name = "policy.json"): string {
  const file = path.join(tmpRoot, name);
  fs.writeFileSync(file, JSON.stringify(draft));
  return file;
}

/** Brouillon valide pour le profil `default`, identité complétée par la CLI. */
function draftWithoutIdentity(): Record<string, unknown> {
  const draft: Record<string, unknown> = { ...validDraft() };
  delete draft["identity"];
  return draft;
}

function readDb<T>(fn: (store: ReturnType<typeof openStore>) => T): T {
  const store = openStore(path.join(dataDir, CONTROL_DB_FILE));
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

async function configured(): Promise<{ revisionId: string; code: string }> {
  await run("init");
  const proposed = await run("policy", "configure", writeDraft(draftWithoutIdentity()));
  expect(proposed.json).toMatchObject({ ok: true, data: { status: "proposed" } });
  return {
    revisionId: String(proposed.json.data["revisionId"]),
    code: String(proposed.json.data["confirmationCode"]),
  };
}

describe("policy configure", () => {
  it("refuse un brouillon dont une limite obligatoire manque, sans créer de révision", async () => {
    await run("init");
    const draft = draftWithoutIdentity();
    const budget = { ...(draft["budget"] as Record<string, unknown>) };
    delete budget["tokensPerPeriod"];
    const result = await run("policy", "configure", writeDraft({ ...draft, budget }));
    expect(result.code).toBe(1);
    expect(result.json.data["issues"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "budget.tokensPerPeriod" })]),
    );
    expect(readDb((s) => s.uow.policies.listRevisions(DEFAULT_PROFILE_ID))).toHaveLength(0);
    const enabled = await run("enable");
    expect(enabled.json.data).toMatchObject({ refusal: { code: "no_pending_revision" } });
  });

  it("propose une révision sans effet et refuse une seconde proposition en attente", async () => {
    const { revisionId } = await configured();
    const status = await run("status");
    expect(status.json.data).toMatchObject({
      profile: { state: "disabled", activePolicyRevisionId: null },
    });
    expect(readDb((s) => s.uow.policies.getConsent(revisionId as PolicyRevisionId))).toBeNull();
    const second = await run("policy", "configure", writeDraft(draftWithoutIdentity()));
    expect(second.code).toBe(1);
    expect(JSON.stringify(second.json.data["issues"])).toContain("attend déjà");
  });

  it("refuse un fichier illisible", async () => {
    await run("init");
    const file = path.join(tmpRoot, "casse.json");
    fs.writeFileSync(file, "{ pas du json");
    expect((await run("policy", "configure", file)).json.data).toMatchObject({
      status: "rejected",
      issues: [{ detail: "JSON invalide" }],
    });
  });
});

describe("enable", () => {
  it("reste disabled faute d'isolation et d'adapter, même confirmé", async () => {
    const { revisionId, code } = await configured();
    // Composants injectés : le build contient désormais un adapter réel (Codex).
    const result = await enable(
      context([]),
      { path: dataDir, source: "option" },
      { revisionId: null, confirm: code, interactive: false },
      { isolation: false, runtimeAdapter: false },
    );
    expect(result.exitCode).toBe(1);
    expect(result.data).toMatchObject({
      enabled: false,
      state: "disabled",
      refusal: { code: "components_missing" },
    });
    expect(result.data.refusal?.detail).toMatch(/adapter runtime non livré/);
    readDb((s) => {
      expect(s.uow.policies.getConsent(revisionId as PolicyRevisionId)).toBeNull();
      expect(s.uow.profiles.get(DEFAULT_PROFILE_ID)?.state).toBe("disabled");
      expect(s.uow.journal.list(DEFAULT_PROFILE_ID).at(-1)).toMatchObject({
        type: "action_denied",
        metadata: { action: "enable", refusal: "components_missing" },
      });
    });
  });

  it("refuse sans confirmation humaine, même avec tous les composants", async () => {
    const { revisionId } = await configured();
    const out: string[] = [];
    const noTerminal = await enable(
      context(out),
      { path: dataDir, source: "option" },
      { revisionId: null, confirm: null, interactive: true },
      ALL_COMPONENTS,
    );
    expect(noTerminal.data).toMatchObject({ refusal: { code: "confirmation_required" } });

    const jsonMode = await enable(
      context(out, () => Promise.resolve("ne sera pas demandé")),
      { path: dataDir, source: "option" },
      { revisionId: null, confirm: null, interactive: false },
      ALL_COMPONENTS,
    );
    expect(jsonMode.data).toMatchObject({ refusal: { code: "confirmation_required" } });

    const wrong = await enable(
      context(out),
      { path: dataDir, source: "option" },
      { revisionId: null, confirm: "000000000000", interactive: false },
      ALL_COMPONENTS,
    );
    expect(wrong.data).toMatchObject({ refusal: { code: "confirmation_mismatch" } });

    const typedWrong = await enable(
      context(out, () => Promise.resolve("oui")),
      { path: dataDir, source: "option" },
      { revisionId: null, confirm: null, interactive: true },
      ALL_COMPONENTS,
    );
    expect(typedWrong.data).toMatchObject({ refusal: { code: "confirmation_mismatch" } });

    readDb((s) => {
      expect(s.uow.policies.getConsent(revisionId as PolicyRevisionId)).toBeNull();
      expect(s.uow.profiles.get(DEFAULT_PROFILE_ID)?.state).toBe("disabled");
    });
  });

  it("active après saisie du code dans le terminal quand les composants existent", async () => {
    const { revisionId, code } = await configured();
    const questions: string[] = [];
    const out: string[] = [];
    const result = await enable(
      context(out, (question) => {
        questions.push(question);
        return Promise.resolve(code);
      }),
      { path: dataDir, source: "option" },
      { revisionId: null, confirm: null, interactive: true },
      ALL_COMPONENTS,
    );
    expect(result.data).toMatchObject({
      enabled: true,
      state: "ready",
      revisionId,
      confirmationChannel: "interactive_terminal",
    });
    expect(questions[0]).toContain(code);
    readDb((s) => {
      expect(s.uow.policies.getConsent(revisionId as PolicyRevisionId)).toMatchObject({
        channel: "local_cli",
      });
      expect(s.uow.profiles.get(DEFAULT_PROFILE_ID)).toMatchObject({
        state: "ready",
        activePolicyRevisionId: revisionId,
      });
    });
    const again = await run("enable", "--confirm", code);
    expect(again.json.data).toMatchObject({ refusal: { code: "no_pending_revision" } });
  });

  it("refuse une révision enregistrée sans limite obligatoire", async () => {
    await run("init");
    const draft = validDraft();
    const groups = {
      ...draft,
      identity: { profileId: DEFAULT_PROFILE_ID, agentId: "default" },
      data: { purge: "manual", exportPaths: [] },
    };
    readDb((s) => {
      s.uow.policies.appendRevision({
        schemaVersion: POLICY_SCHEMA_VERSION,
        id: "rev-incomplete" as PolicyRevisionId,
        profileId: DEFAULT_PROFILE_ID,
        previousRevisionId: null,
        createdAt: "2026-10-29T09:00:00.000Z" as UtcTimestamp,
        groups: groups as never,
      });
    });
    const result = await enable(
      context([]),
      { path: dataDir, source: "option" },
      { revisionId: null, confirm: "x", interactive: false },
      ALL_COMPONENTS,
    );
    expect(result.data).toMatchObject({ state: "disabled", refusal: { code: "missing_limit" } });
    expect(String(result.data.refusal?.detail)).toContain("data.localStorageCapBytes");
  });

  it("refuse l'activation si le stockage dépasse déjà le plafond de la révision", async () => {
    await run("init");
    const draft = draftWithoutIdentity();
    const data = { ...(draft["data"] as Record<string, unknown>), localStorageCapBytes: 1_000 };
    const proposed = await run("policy", "configure", writeDraft({ ...draft, data }));
    const result = await enable(
      context([]),
      { path: dataDir, source: "option" },
      {
        revisionId: null,
        confirm: String(proposed.json.data["confirmationCode"]),
        interactive: false,
      },
      ALL_COMPONENTS,
    );
    expect(result.data).toMatchObject({
      state: "disabled",
      refusal: { code: "storage_saturated" },
    });
  });

  it("refuse les options d'administration sur une autre commande", async () => {
    expect((await run("status", "--confirm", "x")).code).toBe(2);
    expect((await run("uninstall", "--keep-data", "--delete-data")).code).toBe(2);
  });
});

describe("export et purge par la CLI", () => {
  it("exporte vers le chemin choisi et journalise l'export", async () => {
    await run("init");
    const result = await run("export", "sortie");
    expect(result.json.data).toMatchObject({ exported: true });
    expect(fs.existsSync(path.join(tmpRoot, "sortie", "manifest.json"))).toBe(true);
    expect(readDb((s) => s.uow.journal.list(DEFAULT_PROFILE_ID).at(-1)?.type)).toBe(
      "data_exported",
    );
    const twice = await run("export", "sortie");
    expect(twice.json.data).toMatchObject({ exported: false, refusal: { code: "target_exists" } });
  });

  it("n'applique la purge qu'avec --apply et le dit explicitement", async () => {
    await run("init");
    const noRule = await run("purge");
    expect(noRule.json.data["refusal"]).toMatch(/--older-than-days/);
    const plan = await run("purge", "--older-than-days", "1");
    expect(plan.json.data).toMatchObject({ applied: false, deletedEvents: 0 });
    const applied = await run("purge", "--older-than-days", "1", "--apply");
    expect(applied.json.data).toMatchObject({ applied: true });
    expect(String(applied.json.data["note"])).toMatch(/aucun effacement physique sécurisé/);
    expect(readDb((s) => s.uow.journal.list(DEFAULT_PROFILE_ID).at(-1)?.type)).toBe("data_purged");
  });
});

describe("uninstall", () => {
  function snapshotTree(root: string): string[] {
    return fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .map((entry) => {
        const full = path.join(entry.parentPath, entry.name);
        const stats = fs.lstatSync(full);
        return `${path.relative(root, full)}:${String(stats.size)}:${String(stats.mtimeMs)}`;
      })
      .sort();
  }

  it("--dry-run liste les effets sans rien modifier", async () => {
    await run("init");
    const before = snapshotTree(tmpRoot);
    const result = await run("uninstall", "--dry-run");
    expect(result.code).toBe(0);
    expect(result.json.data).toMatchObject({ dryRun: true, outcome: "planned" });
    const plans = result.json.data["plans"] as {
      choice: string;
      effects: { kind: string; detail: string }[];
    }[];
    expect(plans.map((p) => p.choice)).toEqual(["keep", "delete"]);
    const kinds = plans[1]?.effects.map((e) => e.kind);
    expect(kinds).toEqual([
      "stop_daemon",
      "remove_launch_mechanism",
      "delete_data",
      "remove_package",
    ]);
    expect(plans[1]?.effects[0]?.detail).toMatch(/aucun daemon/);
    expect(snapshotTree(tmpRoot)).toEqual(before);
    expect(fs.existsSync(path.join(dataDir, CONTROL_DB_FILE))).toBe(true);
  });

  it("exige un choix explicite hors terminal interactif", async () => {
    await run("init");
    const result = await run("uninstall");
    expect(result.code).toBe(1);
    expect(result.json.data).toMatchObject({ outcome: "aborted" });
    expect(fs.existsSync(path.join(dataDir, CONTROL_DB_FILE))).toBe(true);
  });

  it("conserve les données sur réponse humaine dans le terminal", async () => {
    await run("init");
    const out: string[] = [];
    const code = await runCli(
      ["--data-dir", dataDir, "uninstall"],
      context(out, () => Promise.resolve("conserver")),
    );
    expect(code).toBe(0);
    expect(out.join("")).toContain("données conservées");
    expect(fs.existsSync(path.join(dataDir, CONTROL_DB_FILE))).toBe(true);
  });

  it("supprime le dossier de données sans toucher la cible d'une jonction", async () => {
    await run("init");
    const outside = path.join(tmpRoot, "hors-donnees");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "precieux.txt"), "à garder");
    fs.symlinkSync(outside, path.join(dataDir, "jonction"), "junction");
    fs.mkdirSync(path.join(dataDir, "workspace", "notes"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "workspace", "notes", "a.md"), "note");

    const result = await run("uninstall", "--delete-data");
    expect(result.code).toBe(0);
    expect(result.json.data).toMatchObject({ outcome: "data_deleted" });
    expect(fs.existsSync(dataDir)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "precieux.txt"), "utf8")).toBe("à garder");
  });

  it("refuse de supprimer un dossier qui n'est pas un dossier de données", async () => {
    fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(dataDir, "autre.txt"), "étranger");
    const result = await run("uninstall", "--delete-data");
    expect(result.code).toBe(1);
    expect(result.json.data).toMatchObject({ outcome: "refused" });
    expect(fs.existsSync(path.join(dataDir, "autre.txt"))).toBe(true);
  });
});

describe("enable en mode non isolé (ADR-006)", () => {
  async function configuredHost(): Promise<{ revisionId: string; code: string }> {
    await run("init");
    const draft = draftWithoutIdentity();
    const runtime = { ...(draft["runtime"] as Record<string, unknown>) };
    const proposed = await run(
      "policy",
      "configure",
      writeDraft({ ...draft, runtime: { ...runtime, hostUnsandboxedAcknowledged: true } }),
    );
    expect(proposed.json).toMatchObject({ ok: true, data: { status: "proposed" } });
    return {
      revisionId: String(proposed.json.data["revisionId"]),
      code: String(proposed.json.data["confirmationCode"]),
    };
  }

  it("n'exige plus l'isolation, exige toujours un adapter réel enregistré", async () => {
    const { code } = await configuredHost();
    const out: string[] = [];
    const refused = await enable(
      context(out),
      { path: dataDir, source: "option" },
      { revisionId: null, confirm: code, interactive: false },
      { isolation: false, runtimeAdapter: false },
    );
    expect(refused.data).toMatchObject({ refusal: { code: "components_missing" } });
    expect(refused.data.refusal?.detail).toMatch(/adapter runtime non livré/);
    expect(refused.data.refusal?.detail).not.toMatch(/isolation/);
  });

  it("affiche l'exposé du risque avant la confirmation humaine", async () => {
    const { code } = await configuredHost();
    const out: string[] = [];
    const result = await enable(
      context(out, () => Promise.resolve(code)),
      { path: dataDir, source: "option" },
      { revisionId: null, confirm: null, interactive: true },
      { isolation: false, runtimeAdapter: true },
    );
    expect(result.data).toMatchObject({ enabled: true, state: "ready" });
    expect(out.join("")).toContain("MODE NON ISOLÉ");
    const status = await run("status");
    const caps = (status.json.data["capabilities"] as { id: string; detail: string }[]).find(
      (c) => c.id === "isolation",
    );
    expect(caps?.detail).toMatch(/^NON ISOLÉ/);
  });
});
