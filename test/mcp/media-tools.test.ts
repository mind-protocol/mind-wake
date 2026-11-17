/**
 * Brique médias (mandat NLR du 16 nov. 2026, 14:53–14:57) : generate_image (Codex simulé, aucun
 * appel payant), envoi de fichier au propriétaire et par un coach (API simulées, aucun envoi
 * réel), routage @handle vers une room ou un agent (forks temporaires).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MEDIA_TOOLS,
  codexImageArgs,
  codexSessionId,
  findCodexImage,
  generateImageWithCodex,
  resolveWorkspaceFile,
  telegramBotFileSender,
  telegramFileMethod,
  type ProcessRunner,
  type TelegramSendFile,
} from "../../services/mcp/media-tools.js";
import { registerOwnerTools } from "../../services/mcp/owner-tools.js";
import { TelegramOwner } from "../../services/mcp/telegram-tools.js";
import { TelegramUserAccount, type UserSidecar } from "../../services/mcp/telegram-user-tools.js";
import { seedSimulatedProfile } from "../demo/harness.js";
import { messages } from "../../src/cli/commands/messages.js";
import { processContext } from "../../src/cli/context.js";
import { workspaceDirFor } from "../../src/daemon/paths.js";
import { forkDir } from "../../src/daemon/forks.js";
import { SecondThreadStore } from "../../src/daemon/second-thread.js";
import type { ForkAssignment } from "../../src/daemon/fork-assignment.js";
import {
  routeTelegramHandle,
  signatureHandle,
  telegramAgentLabel,
  telegramHandleTable,
} from "../../src/communication/telegram-handle-route.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=",
  "base64",
);
const SESSION = "01a1e4da-bebc-7672-b499-d185db7bcfa6";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "media-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Codex simulé : écrit l'image là où Codex 0.165 la range et annonce la session. */
function fakeCodex(codexHome: string, calls: { args: readonly string[]; cwd: string }[] = []): ProcessRunner {
  return async (_command, args, options) => {
    calls.push({ args, cwd: options.cwd });
    const dir = path.join(codexHome, "generated_images", SESSION);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "exec-646ca7fb.png"), PNG);
    return { code: 0, stdout: "codex\ndone", stderr: `OpenAI Codex v0.165.0\nsession id: ${SESSION}\n` };
  };
}

describe("generate_image", () => {
  it("reads the session id and finds the image Codex stored under generated_images/<session>", () => {
    const log = "workdir: C:\\x\nsession id: 01a1e4da-bebc-7672-b499-d185db7bcfa6\n--------";
    expect(codexSessionId(log)).toBe(SESSION);
    const home = path.join(tmp, "codex");
    fs.mkdirSync(path.join(home, "generated_images", SESSION), { recursive: true });
    fs.writeFileSync(path.join(home, "generated_images", SESSION, "a.png"), PNG);
    expect(findCodexImage(log, tmp, home)).toBe(path.join(home, "generated_images", SESSION, "a.png"));
    // Sans session lisible : l'image recopiée par Codex dans le dossier de travail.
    fs.writeFileSync(path.join(tmp, "image.png"), PNG);
    expect(findCodexImage("rien", tmp, home)).toBe(path.join(tmp, "image.png"));
    expect(codexImageArgs("D", "un chat").slice(0, 6)).toEqual(["exec", "--skip-git-repo-check", "-s", "workspace-write", "-C", "D"]);
  });

  it("runs codex exec in a temporary folder of the workspace and copies the image there", async () => {
    const workspace = path.join(tmp, "ws");
    fs.mkdirSync(workspace);
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const out = await generateImageWithCodex(workspace, "des lanternes", { runner: fakeCodex(path.join(tmp, "codex"), calls), codexHome: path.join(tmp, "codex") });
    expect(out.session).toBe(SESSION);
    expect(out.sourcePath).toMatch(/^artifacts\/generated-images\/runs\/[^/]+\/codex\.png$/);
    expect(fs.readFileSync(path.join(workspace, out.sourcePath))).toEqual(PNG);
    expect(calls[0]?.args).toContain("-C");
    expect(calls[0]?.cwd).toBe(out.runDir);
    expect(fs.readFileSync(path.join(out.runDir, "codex.log"), "utf8")).toContain(SESSION);
  });

  it("reports clearly when Codex produced no image", async () => {
    const workspace = path.join(tmp, "ws");
    fs.mkdirSync(workspace);
    const runner: ProcessRunner = async () => ({ code: 1, stdout: "", stderr: "error: not logged in" });
    await expect(generateImageWithCodex(workspace, "x", { runner, codexHome: path.join(tmp, "codex") })).rejects.toThrow(/aucune image/);
  });

  it("is a real MCP tool: saved by hash like publish_image, published in the thread, path and hash returned", async () => {
    const dir = path.join(tmp, "wake");
    fs.mkdirSync(dir);
    seedSimulatedProfile(dir);
    fs.mkdirSync(workspaceDirFor(dir), { recursive: true });
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: never) => {
        handlers.set(name, handler);
        return {};
      },
    } as unknown as McpServer;
    registerOwnerTools(server, { MIND_WAKE_DATA_DIR: dir, MIND_WAKE_OWNER_MESSAGES: "1" }, { runner: fakeCodex(path.join(tmp, "codex")), codexHome: path.join(tmp, "codex") });
    expect([...handlers.keys()]).toContain("generate_image");
    expect(MEDIA_TOOLS).toEqual(["generate_image"]);
    const result = await handlers.get("generate_image")!({ prompt: "des lanternes reliées par des fils", title: "Lanternes" });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0]!.text) as { image: { path: string; absolute_path: string; sha256: string } };
    expect(data.image.path).toMatch(/^artifacts\/generated-images\/[0-9a-f]{32}\.png$/);
    expect(fs.readFileSync(data.image.absolute_path)).toEqual(PNG);
    expect(data.image.sha256).toMatch(/^[0-9a-f]{64}$/);
    const snapshot = messages(processContext(), { path: dir, source: "option" }).data;
    expect(snapshot.agentMessages?.[0]?.text).toContain(`![Lanternes](<${data.image.path}>)`);
    // La copie de travail est retirée ; le journal codex.log reste.
    const runs = path.join(workspaceDirFor(dir), "artifacts", "generated-images", "runs");
    const run = fs.readdirSync(runs)[0]!;
    expect(fs.readdirSync(path.join(runs, run))).toEqual(["codex.log"]);
  });
});

describe("telegram file sending", () => {
  it("resolves only files inside the workspace", () => {
    const ws = path.join(tmp, "ws");
    fs.mkdirSync(path.join(ws, "g"), { recursive: true });
    fs.writeFileSync(path.join(ws, "g", "graphe.png"), PNG);
    fs.writeFileSync(path.join(tmp, "dehors.png"), PNG);
    expect(resolveWorkspaceFile(ws, "g/graphe.png").name).toBe("graphe.png");
    expect(resolveWorkspaceFile(ws, path.join(ws, "g", "graphe.png")).size).toBe(PNG.length);
    expect(() => resolveWorkspaceFile(ws, "../dehors.png")).toThrow(/workspace/);
    expect(() => resolveWorkspaceFile(ws, "absent.png")).toThrow(/introuvable/);
    expect(telegramFileMethod({ name: "a.PNG", size: 10 })).toBe("sendPhoto");
    expect(telegramFileMethod({ name: "a.png", size: 11_000_000 })).toBe("sendDocument");
    expect(telegramFileMethod({ name: "a.pdf", size: 10 })).toBe("sendDocument");
  });

  it("bot sender posts multipart sendPhoto with caption, and retries as document when Telegram refuses the photo", async () => {
    fs.writeFileSync(path.join(tmp, "telegram.json"), JSON.stringify({ enabled: true, botToken: "123:fake_token" }));
    fs.writeFileSync(path.join(tmp, "g.png"), PNG);
    const seen: { method: string; caption: unknown; field: string }[] = [];
    let refusePhoto = false;
    const http = (async (url: string, init: { body: FormData }) => {
      const method = url.split("/").pop()!;
      const field = init.body.has("photo") ? "photo" : "document";
      seen.push({ method, caption: init.body.get("caption"), field });
      if (method === "sendPhoto" && refusePhoto)
        return new Response(JSON.stringify({ ok: false, error_code: 400, description: "PHOTO_INVALID_DIMENSIONS" }), { status: 400 });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }));
    }) as unknown as typeof fetch;
    const send = telegramBotFileSender(tmp, http);
    const file = resolveWorkspaceFile(tmp, "g.png");
    expect(await send("99", file, "légende")).toEqual({ message_id: 42, method: "sendPhoto" });
    refusePhoto = true;
    expect((await send("99", file, "x")).method).toBe("sendDocument");
    expect(seen).toEqual([
      { method: "sendPhoto", caption: "légende", field: "photo" },
      { method: "sendPhoto", caption: "x", field: "photo" },
      { method: "sendDocument", caption: "x", field: "document" },
    ]);
  });

  it("telegram_send_owner with image_path sends the file with the text as caption; a long text follows separately", async () => {
    const ws = path.join(tmp, "ws");
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, "graphe.png"), PNG);
    const db = new Database(path.join(tmp, "telegram.sqlite"));
    db.exec("CREATE TABLE state(key TEXT PRIMARY KEY,value TEXT)");
    db.prepare("INSERT INTO state VALUES('chat','1864364329')").run();
    db.close();
    const texts: string[] = [];
    const files: { chat: string; name: string; caption: string }[] = [];
    const sendFile: TelegramSendFile = async (chat, file, caption) => {
      files.push({ chat, name: file.name, caption });
      return { message_id: 7, method: "sendPhoto" };
    };
    const owner = new TelegramOwner(tmp, async (_c, t) => (texts.push(t), { message_id: 8 }), sendFile, () => ws);
    const r = await owner.send_({ text: "Telegram seulement", idempotency_key: "k1", image_path: "graphe.png" });
    expect(r.message_id).toBe(7);
    expect(r.file?.method).toBe("sendPhoto");
    expect(files).toEqual([{ chat: "1864364329", name: "graphe.png", caption: "Telegram seulement" }]);
    expect(texts).toEqual([]);
    await owner.send_({ text: "x".repeat(1500), idempotency_key: "k2", image_path: "graphe.png" });
    expect(files[1]?.caption).toBe("");
    expect(texts).toEqual(["x".repeat(1500)]);
    await expect(owner.send_({ text: "t", idempotency_key: "k3", image_path: "../../etc" })).rejects.toThrow();
    // Pièce jointe suivante d'une réponse de room : légende vide acceptée avec un fichier, pas sans.
    await owner.send_({ text: "", idempotency_key: "k3-f2", image_path: "graphe.png" });
    expect(files.at(-1)?.caption).toBe("");
    await expect(owner.send_({ text: "", idempotency_key: "k3-f3" })).rejects.toThrow("Texte vide.");
    // Sans image : l'envoi texte d'avant, inchangé.
    await owner.send_({ text: "juste du texte", idempotency_key: "k4" });
    expect(texts.at(-1)).toBe("juste du texte");
  });

  it("a coach send (NLR's account) passes the workspace file to the sidecar", async () => {
    const ws = path.join(tmp, "ws");
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, "graphe.png"), PNG);
    fs.writeFileSync(path.join(tmp, "telegram-user.json"), "{}");
    fs.writeFileSync(path.join(tmp, "telegram-user.session"), "");
    const calls: string[][] = [];
    const sidecar: UserSidecar = async (args) => {
      calls.push(args);
      return { ok: true, message_id: 5, peer: { id: 1, name: "A" } };
    };
    const account = new TelegramUserAccount(tmp, sidecar, { workspace: () => ws });
    const r = await account.send({ to: "@ami", text: "voici", idempotency_key: "c1", image_path: "graphe.png" }, { coach: "coach-x" });
    expect(calls[0]).toEqual(["send", "@ami", "-", "--file", fs.realpathSync(path.join(ws, "graphe.png"))]);
    expect(r.file).toBe(fs.realpathSync(path.join(ws, "graphe.png")));
  });
});

describe("@handle routing from Telegram", () => {
  const agent = (id: string, name: string) => ({
    id,
    name,
    instructions: path.join(tmp, `${id}.md`),
    writable: [],
    owner: { colony: null, profile: "publish" as const },
    tools: "none" as const,
    private: false,
  });
  function rooms(): Map<number, ForkAssignment> {
    const base = { engine: "claude", workspace: tmp, writable: [], inbox: "explicit", owner: null, assignedAt: "2026-11-16T00:00:00Z" };
    return new Map<number, ForkAssignment>([
      [2, { ...base, instructions: "x", holder: null, agents: [agent("coach-colony", "Coach Colony"), agent("vox", "Faux VOX")] } as unknown as ForkAssignment],
      [4, { ...base, instructions: "x", holder: "atelier-jeu" } as unknown as ForkAssignment],
      [7, { ...base, instructions: "x", holder: "vox-holder" } as unknown as ForkAssignment],
    ]);
  }
  function dataDir(): string {
    for (const n of [2, 4, 7]) fs.mkdirSync(forkDir(tmp, n), { recursive: true });
    return tmp;
  }

  it("builds the table from the room registry: room<n>, owner signature, holder, agent ids; rooms win", () => {
    const table = telegramHandleTable(dataDir(), (n) => rooms().get(n) ?? null);
    expect([...table.keys()].sort()).toEqual(["atelier-jeu", "coach-colony", "room2", "room4", "room7", "vox", "vox-holder"]);
    // « vox » est le handle de la Room 7 (signature VOX (Room 7)), pas l'agent homonyme de la Room 2.
    expect(table.get("vox")).toMatchObject({ room: 7, agent: null, label: "Room 7 (VOX)" });
    expect(table.get("coach-colony")).toMatchObject({ room: 2, label: "Coach Colony (Room 2)" });
    expect(signatureHandle("Fixeur Écoute (Room 2)")).toBe("fixeur-ecoute");
  });

  it("a main-thread pattern holder is reachable by slug or name, after rooms and their agents, and writes nothing", () => {
    const dir = dataDir();
    const holders = () => [
      { slug: "crypto", name: "Crypto", emoji: "🪙" },
      { slug: "coach-des-coachs", name: "Coach des coachs", emoji: "🕸️" },
      { slug: "coach-colony", name: "Zénith", emoji: "☀️" },
    ];
    const table = telegramHandleTable(dir, (n) => rooms().get(n) ?? null, holders);
    expect(table.get("crypto")).toMatchObject({ room: 0, holder: "crypto", label: "🪙 Crypto (fil principal)" });
    // Un holder agent d'une room se joint dans sa room : ni son slug ni son nom ne visent le fil principal.
    expect(table.get("coach-colony")).toMatchObject({ room: 2, agent: { id: "coach-colony" } });
    expect(table.has("zenith")).toBe(false);
    expect(routeTelegramHandle(dir, "coach-des-coachs", "@coach-des-coachs salut", "tg-1-20001", table)).toEqual({
      status: "main", label: "🕸️ Coach des coachs (fil principal)", holder: "coach-des-coachs", mention: "@coach-des-coachs",
    });
    expect(routeTelegramHandle(dir, "coin", "@coin salut", "tg-1-20002", telegramHandleTable(dir, (n) => rooms().get(n) ?? null, () => [{ slug: "crypto", name: "Coin", emoji: "🪙" }]))).toMatchObject({ status: "main", mention: "@crypto" });
  });

  it("a room handle becomes a human message in that room; an agent handle a notice for that agent only; idempotent", () => {
    const dir = dataDir();
    const table = telegramHandleTable(dir, (n) => rooms().get(n) ?? null);
    const first = routeTelegramHandle(dir, "VOX", "@vox regarde", "tg-1-11186", table);
    expect(first).toMatchObject({ status: "routed", room: 7, agent: null, label: "Room 7 (VOX)" });
    expect(routeTelegramHandle(dir, "vox", "@vox regarde", "tg-1-11186", table)).toEqual(first);
    const toAgent = routeTelegramHandle(dir, "coach-colony", "@coach-colony une idée", "tg-1-11187", table);
    expect(toAgent).toMatchObject({ status: "routed", room: 2, agent: "coach-colony" });
    const room7 = new SecondThreadStore(forkDir(dir, 7));
    const room2 = new SecondThreadStore(forkDir(dir, 2));
    try {
      expect(room7.entries().map((e) => [e.role, e.text])).toEqual([["human", "@vox regarde"]]);
      const entry = room2.entries()[0]!;
      expect(entry.text).toBe("@coach-colony une idée");
      expect(entry.notice?.label).toBe(telegramAgentLabel(agent("coach-colony", "Coach Colony")));
      // Messages de NLR : ils valent un tour unique dans une room désactivée.
      expect(room7.isHumanOrigin(room7.entries()[0]!)).toBe(true);
      expect(room2.isHumanOrigin(entry)).toBe(true);
    } finally {
      room7.close();
      room2.close();
    }
    const unknown = routeTelegramHandle(dir, "vxo", "@vxo", "tg-1-3", table);
    expect(unknown).toEqual({ status: "unknown", handle: "vxo", known: ["atelier-jeu", "coach-colony", "room2", "room4", "room7", "vox", "vox-holder"] });
  });

  it("a new room is routable as soon as its folder and assignment exist", () => {
    const dir = dataDir();
    const all = rooms();
    expect(telegramHandleTable(dir, (n) => all.get(n) ?? null).has("room8")).toBe(false);
    fs.mkdirSync(forkDir(dir, 8), { recursive: true });
    all.set(8, { ...all.get(4)!, holder: "nouvelle" } as ForkAssignment);
    const table = telegramHandleTable(dir, (n) => all.get(n) ?? null);
    expect(table.get("room8")?.room).toBe(8);
    expect(table.get("nouvelle")?.room).toBe(8);
  });
});
