/**
 * Outil MCP `computer_use` (mandat NLR du 16 nov. 2026, 14:59) : Codex simulé, aucun écran
 * piloté. Vérifie le dossier horodaté, les arguments de `codex exec`, la consigne (lecture seule
 * par défaut, navigateur dédié), le texte final et les captures renvoyés.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMPUTER_USE_TOOLS,
  computerUseArgs,
  computerUseInstruction,
  finalFromLog,
  registerComputerUseTools,
  runComputerUse,
  runStamp,
} from "../../services/mcp/computer-use-tools.js";
import type { ProcessRunner } from "../../services/mcp/media-tools.js";

const SESSION = "01a1e505-602a-7de0-9a6e-9cc3bad65a07";
let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cu-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Codex simulé : écrit une capture et le texte final (`-o`), annonce la session. */
function fakeCodex(calls: { args: readonly string[]; cwd: string }[], final = "Page title: **Example Domain**"): ProcessRunner {
  return async (_command, args, options) => {
    calls.push({ args, cwd: options.cwd });
    fs.writeFileSync(path.join(options.cwd, "cu-1.jpg"), "jpg");
    fs.writeFileSync(path.join(options.cwd, "page-1.png"), "png");
    const o = args[args.indexOf("-o") + 1]!;
    if (final !== "") fs.writeFileSync(o, final);
    return { code: 0, stdout: "", stderr: `OpenAI Codex v0.165.0\nsession id: ${SESSION}\n` };
  };
}

describe("computer_use", () => {
  it("lance codex exec avec computer_use dans artifacts/computer-use/<horodatage>/ et renvoie texte et captures", async () => {
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const r = await runComputerUse(tmp, "Ouvre example.com et donne le titre.", {
      runner: fakeCodex(calls),
      command: "codex",
      now: new Date(2026, 10, 16, 16, 41, 28),
    });
    expect(calls).toHaveLength(1);
    const { args, cwd } = calls[0]!;
    expect(path.dirname(cwd)).toBe(path.join(fs.realpathSync(tmp), "artifacts", "computer-use"));
    expect(path.basename(cwd)).toMatch(/^20261116-164128-[a-z0-9]{1,4}$/);
    expect(args.slice(0, 8)).toEqual(["exec", "--skip-git-repo-check", "--enable", "computer_use", "-s", "danger-full-access", "-C", cwd]);
    expect(args[9]).toBe(path.join(cwd, "final.md"));
    expect(r.final).toBe("Page title: **Example Domain**");
    expect(r.screenshots.map((s) => path.basename(s))).toEqual(["cu-1.jpg", "page-1.png"]);
    expect(r.codex_session).toBe(SESSION);
    expect(fs.readFileSync(path.join(cwd, "task.md"), "utf8")).toContain("allow_submit: false");
    expect(fs.existsSync(r.log)).toBe(true);
  });

  it("consigne : lecture seule par défaut, jamais d'URL tapée dans la barre d'adresse", () => {
    const opts = { helper: "H.mjs", profile: "P" };
    const ro = computerUseInstruction("tâche", { ...opts, allowSubmit: false });
    expect(ro).toContain("READ-ONLY by default");
    expect(ro).toContain('node "H.mjs" open <https-url>');
    expect(ro).toContain("do NOT type URLs into an address bar");
    expect(ro).toContain("Never close, minimize or reuse windows");
    expect(ro.endsWith("Task:\ntâche")).toBe(true);
    const rw = computerUseInstruction("tâche", { ...opts, allowSubmit: true });
    expect(rw).not.toContain("READ-ONLY");
    expect(rw).toContain("never buy, pay, log in");
  });

  it("sans -o (plantage) : texte final tiré du journal", async () => {
    expect(finalFromLog("codex\nfait\ntokens used\n27,091\nTitre : Example Domain\n")).toBe("Titre : Example Domain");
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const r = await runComputerUse(tmp, "x", { runner: fakeCodex(calls, ""), command: "codex" });
    expect(r.final).toContain("session id");
  });

  it("refuse une tâche vide ; outil absent sans profil Wake", async () => {
    await expect(runComputerUse(tmp, "   ", { runner: fakeCodex([]) })).rejects.toThrow("Tâche vide");
    const names: string[] = [];
    const server = { registerTool: (n: string) => names.push(n) } as unknown as McpServer;
    registerComputerUseTools(server, {});
    expect(names).toEqual([]);
    registerComputerUseTools(server, { MIND_WAKE_DATA_DIR: tmp });
    expect(names).toEqual([...COMPUTER_USE_TOOLS]);
  });

  it("horodatage et arguments stables", () => {
    expect(runStamp(new Date(2026, 0, 2, 3, 4, 5), "ab12")).toBe("20260102-030405-ab12");
    expect(computerUseArgs("D", "I", "F")).toEqual(["exec", "--skip-git-repo-check", "--enable", "computer_use", "-s", "danger-full-access", "-C", "D", "-o", "F", "I"]);
  });
});
