/**
 * Surface du serveur MCP MIND : liste exacte des outils, absence de toute commande
 * d'administration ou réservée à l'humain, schémas fermés, sorties versionnées, et
 * consultation de Wake en lecture seule sur un profil réel initialisé par la CLI.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_MAIN, minimalEnv, NODE_ARGS, startHarness, type Harness } from "./harness.js";

const TIMEOUT = 60_000;

const EXPECTED_TOOLS = [
  "close_help_request",
  "invite_guide",
  "list_directory",
  "list_help_requests",
  "list_invitations",
  "propose_matches",
  "publish_help_request",
  "read_inbox",
  "reply_to_thread",
  "respond_to_invitation",
  "send_message",
  "session_checkpoint",
  "session_close",
  "session_receive",
  "session_send",
  "session_status",
  "unsure_what_to_do",
  "wake_journal",
  "wake_last_report",
  "wake_status",
  "whoami",
];

let h: Harness;
let wakeDir: string;

beforeAll(async () => {
  h = await startHarness();
  wakeDir = join(h.dir, "wake-data");
  const init = spawnSync(
    process.execPath,
    [...NODE_ARGS, CLI_MAIN, "init", "--data-dir", wakeDir],
    {
      env: minimalEnv(),
      encoding: "utf8",
    },
  );
  expect(init.status).toBe(0);
}, TIMEOUT);

afterAll(async () => {
  await h.close();
}, TIMEOUT);

describe("surface d'outils", { timeout: TIMEOUT }, () => {
  it("liste exacte ; aucune commande d'administration, de permission ou de paiement", async () => {
    const party = await h.party("agent");
    const { tools } = await party.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(EXPECTED_TOOLS);
    for (const name of names) {
      expect(name).not.toMatch(
        /enable|confirm|uninstall|pause|resume|stop|kill|policy|purge|export|daemon|grant|permission|pay|wallet|approve/,
      );
    }
    for (const tool of tools) {
      expect(tool.annotations?.openWorldHint).toBe(false);
      expect(tool.inputSchema["additionalProperties"]).toBe(false);
    }
    const { resources } = await party.client.listResources().catch(() => ({ resources: [] }));
    expect(resources).toEqual([]);

    for (const forbidden of ["enable", "uninstall", "confirm", "policy_configure", "pause"]) {
      const result = await party.client
        .callTool({ name: forbidden, arguments: {} })
        .then((r) => r.isError === true)
        .catch(() => true);
      expect(result).toBe(true);
    }
  });

  it("schéma fermé : un argument inconnu est refusé ; sortie versionnée", async () => {
    const party = await h.party("guide");
    const extra = await party
      .call("whoami", { grant: "network" })
      .catch(() => ({ isError: true, data: {} }));
    expect(extra.isError).toBe(true);
    const ok = await party.call("whoami");
    expect(ok.data).toMatchObject({ schema: "mind.mcp/whoami", schema_version: 1 });
  });
});

describe("Wake en lecture seule", { timeout: TIMEOUT }, () => {
  it("relit les choix personnels et retire une piste révoquée sans redémarrer", async () => {
    const dataDir = join(h.dir, "personal-ideas");
    const workspace = join(dataDir, "workspace");
    mkdirSync(workspace, { recursive: true });
    const file = join(workspace, "AUTORISATIONS.json");
    const document = {
      version: 1,
      title: "Test",
      context: "",
      example: "",
      guidance: "",
      entries: [
        {
          id: "owner-test",
          action: "Build my prototype",
          decision: "encouraged",
          scope: "Shared workspace only",
          category: "build",
        },
      ],
    };
    writeFileSync(file, JSON.stringify(document));
    const reader = await h.wakeOnly(dataDir);
    const first = await reader.call("unsure_what_to_do", { count: 30, categories: ["build"] });
    expect(first.isError).toBe(false);
    expect(first.data["ideas"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ authorizationId: "owner-test", preference: "encouraged" }),
      ]),
    );
    document.entries[0]!.decision = "forbidden";
    writeFileSync(file, JSON.stringify(document));
    const second = await reader.call("unsure_what_to_do", { count: 30, categories: ["build"] });
    expect(second.data["ideas"]).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ authorizationId: "owner-test" })]),
    );
    expect(second.data["authorizations"]).toMatchObject({
      status: "loaded",
      restrictions: [{ id: "owner-test", decision: "forbidden" }],
    });
  });
  it("statut, journal et bilan par les modules de src/, sans écrire dans la base", async () => {
    const db = join(wakeDir, "control.sqlite");
    const before = createHash("sha256").update(readFileSync(db)).digest("hex");
    const reader = await h.wakeOnly(wakeDir);

    const status = await reader.call("wake_status");
    expect(status.isError).toBe(false);
    expect(status.data["schema"]).toBe("mind.mcp/wake_status");
    expect(status.data["status"]).toMatchObject({
      persistence: "sqlite",
      profile: { id: "default", state: "disabled" },
    });

    const journal = await reader.call("wake_journal", { limit: 5 });
    const events = (journal.data["journal"] as Record<string, unknown>)["events"] as unknown[];
    expect(events.length).toBeGreaterThan(0);

    const report = await reader.call("wake_last_report");
    expect(report.data).toMatchObject({ report: null, hint: "aucune expérience encore" });
    expect(String(report.data["notice"])).toMatch(/Human-only commands/);

    const noHub = await reader.call("send_message", {
      to: "human-abcdefghjk",
      text: "Bonjour",
      idempotency_key: "k-0000-0001",
    });
    expect(noHub.data["error"]).toBe("permission_denied");

    const after = createHash("sha256").update(readFileSync(db)).digest("hex");
    expect(after).toBe(before);
  });

  it("dossier Wake absent : statut lisible, rien n'est créé", async () => {
    const party = await h.party("agent");
    const status = await party.call("wake_status");
    expect(status.data["status"]).toMatchObject({ profile: null });
    expect(existsSync(join(h.dir, "no-wake-data"))).toBe(false);
  });
});
