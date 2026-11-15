import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ElevenLabs } from "../../services/elevenlabs/service.js";
import { registerElevenLabsTools } from "../../services/mcp/elevenlabs-tools.js";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  ELEVENLABS_CIRCUIT_FILE,
  enableElevenLabs,
  readElevenLabsCircuit,
  VOICE_CUT_MESSAGE,
} from "../../src/communication/elevenlabs-circuit.js";
import { readOwnerMessages } from "../../src/communication/owner-messages.js";

const directories: string[] = [];
function dir() {
  const d = fs.mkdtempSync(path.join(process.cwd(), "test/.elevenlabs-"));
  directories.push(d);
  return d;
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of directories.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const settings = { enabled: true, apiKey: "secret-test-key", voiceId: "voice-fr", autoplay: true };
const mp3 = () =>
  new Response(new Uint8Array([73, 68, 51, 0]), { headers: { "content-type": "audio/mpeg" } });

it("is disabled initially, saves a key without enabling, and never returns it", () => {
  const service = new ElevenLabs(dir());
  expect(service.status()).toMatchObject({ enabled: false, hasKey: false });
  service.configure({ enabled: false, voiceId: "", autoplay: true });
  expect(service.status().hasKey).toBe(false);
  service.configure({ ...settings, enabled: false });
  expect(service.status()).toMatchObject({ enabled: false, hasKey: true });
  service.configure({ ...settings, apiKey: "" });
  expect(JSON.stringify(service.status())).not.toContain("secret-test-key");
  expect(new ElevenLabs(service.dir).status().enabled).toBe(true);
});

it("paginates account voices with fixed origin and rejects redirects and provider error details", async () => {
  const http = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        voices: [{ voice_id: "fr", name: "Français", preview_url: "private" }],
        has_more: true,
        next_page_token: "next",
      }),
    )
    .mockResolvedValueOnce(new Response("secret-test-key echoed", { status: 429 }));
  const service = new ElevenLabs(dir(), http);
  service.configure(settings);
  const voices = await service.voices("a&b");
  expect(voices.voices[0]).toEqual({ voice_id: "fr", name: "Français" });
  const [url, init] = http.mock.calls[0] ?? [];
  expect(url).toBe("https://api.elevenlabs.io/v2/voices?page_size=100&next_page_token=a%26b");
  expect(init).toMatchObject({ redirect: "error", headers: { "xi-api-key": settings.apiKey } });
  await expect(service.voices()).rejects.toThrow("ElevenLabs HTTP 429");
  expect(http).toHaveBeenCalledTimes(2); // No retries that could consume more credits.
});

it("generates with default or chosen voice, persists MP3 across processes and acknowledges delivery", async () => {
  const http = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(mp3()));
  const service = new ElevenLabs(dir(), http, () => true);
  service.configure(settings);
  const result = await service.generate({ text: "Bonjour" });
  expect(http.mock.calls[0]?.[0]).toContain("/voice-fr?output_format=mp3_44100_128");
  const body = http.mock.calls[0]?.[1]?.body;
  if (typeof body !== "string") throw Error("Expected JSON request body");
  expect(JSON.parse(body)).toEqual({
    text: "Bonjour",
    model_id: "eleven_multilingual_v2",
  });
  const desktop = new ElevenLabs(service.dir, http, () => true);
  expect(desktop.pending().clips[0]?.id).toBe(result.id);
  desktop.configure({ ...settings, autoplay: false });
  expect(desktop.pending().clips[0]?.autoplay).toBe(false);
  expect(Buffer.from(desktop.audio(result.id).base64, "base64")).toEqual(
    fs.readFileSync(result.audioPath),
  );
  expect(() => desktop.audio("../../secret")).toThrow();
  desktop.acknowledge(result.id);
  expect(desktop.pending().clips).toHaveLength(0);
  expect(fs.existsSync(result.audioPath)).toBe(true);
  await service.generate({ text: "Salut", voice_id: "another" });
  expect(http.mock.calls[1]?.[0]).toContain("/another?");
});

it("does not call provider when disabled or paused; does not enqueue a result after stop", async () => {
  let active = true;
  const http = vi.fn<typeof fetch>().mockImplementation(() => {
    active = false;
    return Promise.resolve(mp3());
  });
  const service = new ElevenLabs(dir(), http, () => active);
  await expect(service.generate({ text: "Bonjour" })).rejects.toThrow("désactivé");
  expect(http).not.toHaveBeenCalled();
  service.configure(settings);
  active = false;
  await expect(service.generate({ text: "Bonjour" })).rejects.toThrow("pause");
  expect(http).not.toHaveBeenCalled();
  active = true;
  await expect(service.generate({ text: "Bonjour" })).rejects.toThrow("pause");
  expect(service.pending()).toEqual({ allowed: false, clips: [] });
  // A durable request reservation survives an ambiguous paid call; no playable clip does.
  expect(fs.readdirSync(path.join(service.dir, "elevenlabs-audio")).filter(name => /\.(json|mp3)$/.test(name))).toEqual([]);
});

it("rejects non-audio responses before adding to the desktop queue", async () => {
  const service = new ElevenLabs(
    dir(),
    () => Promise.resolve(Response.json({ error: "unexpected" })),
    () => true,
  );
  service.configure(settings);
  await expect(service.generate({ text: "Bonjour" })).rejects.toThrow("invalide");
  expect(service.pending().clips).toEqual([]);
});

it("exposes the MCP tools without restart on configuration, and redacts transport errors", async () => {
  const registered = new Map<
    string,
    { inputSchema: unknown; handler: (args: object) => Promise<unknown> }
  >();
  const server = {
    registerTool: (
      name: string,
      config: { inputSchema: unknown },
      handler: (args: object) => Promise<unknown>,
    ) => registered.set(name, { inputSchema: config.inputSchema, handler }),
  };
  const directory = dir();
  vi.stubGlobal("fetch", () => Promise.reject(Error("request headers secret-test-key")));
  registerElevenLabsTools(server as unknown as McpServer, { MIND_WAKE_DATA_DIR: directory });
  expect([...registered.keys()]).toEqual(["elevenlabs_list_voices", "speak_desktop", "elevenlabs_generate_speech"]);
  new ElevenLabs(directory).configure(settings);
  const handler = registered.get("elevenlabs_list_voices")?.handler;
  if (!handler) throw Error("Missing voices tool");
  const result = await handler({});
  expect(result).toMatchObject({ isError: true });
  expect(JSON.stringify(result)).not.toContain("secret-test-key");
});

it("never stays stuck: orphan claims expire, old clips leave, a full queue yields to the newest reply", async () => {
  const http = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(mp3()));
  const service = new ElevenLabs(dir(), http, () => true);
  service.configure(settings);
  const spool = path.join(service.dir, "elevenlabs-audio");
  const marker = (id: string) => path.join(spool, `${id}.json`);
  const age = (file: string, ms: number) => {
    const t = new Date(Date.now() - ms);
    fs.utimesSync(file, t, t);
  };
  // Cas réel : clip réservé par une webview rechargée, jamais démarré, puis deux autres.
  const [a, b, c] = [
    await service.generate({ text: "Un", idempotency_key: "reply:a" }),
    await service.generate({ text: "Deux", idempotency_key: "reply:b" }),
    await service.generate({ text: "Trois", idempotency_key: "reply:c" }),
  ];
  expect(service.claim(a.id)).toEqual({ claimed: true });
  age(path.join(spool, `${a.id}.claim`), 2 * 60_000);
  // Une réservation orpheline redevient lisible.
  expect(service.pending().clips.map((clip) => clip.id)).toEqual([a.id, b.id, c.id]);
  expect(service.claim(a.id)).toEqual({ claimed: true });
  // File pleine : la nouvelle réponse passe, le plus ancien clip non lu cède sa place.
  const d = await service.generate({ text: "Quatre", idempotency_key: "reply:d" });
  expect(service.pending().clips.map((clip) => clip.id)).toEqual([b.id, c.id, d.id]);
  expect(fs.existsSync(a.audioPath)).toBe(true);
  // Un clip non lu depuis plus de dix minutes n'est plus une réponse en direct.
  const old = JSON.parse(fs.readFileSync(marker(b.id), "utf8")) as Record<string, unknown>;
  fs.writeFileSync(marker(b.id), JSON.stringify({ ...old, createdAt: new Date(Date.now() - 11 * 60_000).toISOString() }));
  expect(service.pending().clips.map((clip) => clip.id)).toEqual([c.id, d.id]);
  const log = fs.readFileSync(path.join(spool, "playback.jsonl"), "utf8");
  expect(log).toContain(`"id":"${a.id}","phase":"evicted"`);
  expect(log).toContain(`"id":"${b.id}","phase":"expired"`);
  // Un clip démarré n'est jamais retiré.
  service.event(c.id, "started");
  expect(fs.existsSync(path.join(spool, `${c.id}.started`))).toBe(true);
});

describe("credits circuit breaker", () => {
  const refused = (status: number, detail?: string) => () =>
    Promise.resolve(Response.json(detail ? { detail: { status: detail } } : {}, { status }));
  const errors = (directory: string) =>
    fs
      .readFileSync(path.join(directory, "elevenlabs-audio", "errors.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  it("opens on HTTP 401, notifies the owner once, and blocks every generation path without HTTP", async () => {
    const http = vi.fn<typeof fetch>().mockImplementation(refused(401));
    const service = new ElevenLabs(dir(), http, () => true);
    service.configure(settings);
    await expect(service.generate({ text: "Bonjour", idempotency_key: "a" })).rejects.toThrow(VOICE_CUT_MESSAGE);
    expect(http).toHaveBeenCalledTimes(1);
    const circuit = JSON.parse(
      fs.readFileSync(path.join(service.dir, ELEVENLABS_CIRCUIT_FILE), "utf8"),
    ) as Record<string, unknown>;
    expect(circuit).toMatchObject({ open: true, status: 401, notified: "owner_message" });
    expect(typeof circuit["at"]).toBe("string");
    expect(service.status()).toMatchObject({
      enabled: false,
      voiceStatus: VOICE_CUT_MESSAGE,
      circuit: { status: 401 },
    });
    expect(JSON.stringify(service.status())).not.toContain("secret-test-key");
    // Desktop auto-read, MCP speak_desktop / generate (forks included): same service, no paid call.
    const other = new ElevenLabs(service.dir, http, () => true);
    await expect(other.speakDesktop({ text: "Salut.", idempotency_key: "b" })).rejects.toThrow(VOICE_CUT_MESSAGE);
    expect(() => other.queueDesktopSpeech({ text: "Salut.", idempotency_key: "c" })).toThrow(VOICE_CUT_MESSAGE);
    expect(() => other.queueGeneration({ text: "Salut", thread_id: "fork-7" })).toThrow(VOICE_CUT_MESSAGE);
    await expect(other.generate({ text: "Salut" })).rejects.toThrow(VOICE_CUT_MESSAGE);
    expect(http).toHaveBeenCalledTimes(1);
    const notices = readOwnerMessages(service.dir) ?? [];
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain("Voix coupée");
    const log = errors(service.dir);
    expect(log[0]).toMatchObject({ status: 401, message: expect.stringContaining("HTTP 401") as unknown });
    expect(log.filter((entry) => entry["event"] === "circuit_open")).toHaveLength(1);
    for (const entry of log) expect(typeof entry["at"]).toBe("string");
  });

  it("opens once when concurrent generations are refused", async () => {
    const releases: ((response: Response) => void)[] = [];
    const http = vi.fn<typeof fetch>(() => new Promise((resolve) => releases.push(resolve)));
    const service = new ElevenLabs(dir(), http, () => true);
    service.configure(settings);
    const first = service.generate({ text: "Un", idempotency_key: "one" });
    const second = service.generate({ text: "Deux", idempotency_key: "two" });
    await vi.waitFor(() => {
      expect(releases).toHaveLength(2);
    });
    for (const release of releases) release(Response.json({}, { status: 402 }));
    await expect(first).rejects.toThrow(VOICE_CUT_MESSAGE);
    await expect(second).rejects.toThrow(VOICE_CUT_MESSAGE);
    expect(readOwnerMessages(service.dir)).toHaveLength(1);
    expect(errors(service.dir).filter((entry) => entry["event"] === "circuit_open")).toHaveLength(1);
  });

  it("trips on quota codes but only logs transient failures", async () => {
    const http = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(refused(429, "too_many_concurrent_requests"))
      .mockImplementationOnce(refused(500))
      .mockImplementationOnce(refused(429, "quota_exceeded"));
    const service = new ElevenLabs(dir(), http, () => true);
    service.configure(settings);
    await expect(service.generate({ text: "Un" })).rejects.toThrow("ElevenLabs HTTP 429");
    await expect(service.generate({ text: "Deux" })).rejects.toThrow("ElevenLabs HTTP 500");
    expect(fs.existsSync(path.join(service.dir, ELEVENLABS_CIRCUIT_FILE))).toBe(false);
    await expect(service.generate({ text: "Trois" })).rejects.toThrow(VOICE_CUT_MESSAGE);
    expect(errors(service.dir).slice(0, 3).map((entry) => entry["status"])).toEqual([429, 500, 429]);
    expect(errors(service.dir)[2]).toMatchObject({ code: "quota_exceeded" });
    expect(readElevenLabsCircuit(service.dir)).toMatchObject({ status: 429, code: "quota_exceeded" });
  });

  it("stays open until the human re-checks the toggle; other settings saves do not reopen", async () => {
    const http = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(refused(401))
      .mockImplementation(() => Promise.resolve(mp3()));
    const service = new ElevenLabs(dir(), http, () => true);
    service.configure(settings);
    await expect(service.generate({ text: "Bonjour" })).rejects.toThrow(VOICE_CUT_MESSAGE);
    service.configure({ ...settings, enabled: false, autoplay: false });
    service.configureTranscription(true);
    expect(readElevenLabsCircuit(service.dir)).not.toBeNull();
    // An unreadable breaker file never counts as an authorisation.
    fs.writeFileSync(path.join(service.dir, ELEVENLABS_CIRCUIT_FILE), "{");
    await expect(service.generate({ text: "Encore" })).rejects.toThrow(VOICE_CUT_MESSAGE);
    expect(http).toHaveBeenCalledTimes(1);
    service.configure(settings);
    expect(readElevenLabsCircuit(service.dir)).toBeNull();
    await expect(service.generate({ text: "Encore" })).resolves.toMatchObject({
      playback: "queued_for_desktop",
    });
    expect(http).toHaveBeenCalledTimes(2);
  });

  it("CLI enable closes the breaker, keeps the key, drops unknown notes, and makes no network call", async () => {
    const http = vi.fn<typeof fetch>().mockImplementation(refused(401));
    const service = new ElevenLabs(dir(), http, () => true);
    service.configure(settings);
    await expect(service.generate({ text: "Bonjour" })).rejects.toThrow(VOICE_CUT_MESSAGE);
    // A hand-written note must not make the whole configuration unreadable.
    const file = path.join(service.dir, "elevenlabs.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...stored, disabledReason: "note", disabledAt: "2026-11-13" }));
    expect(service.status()).toMatchObject({ enabled: false, hasKey: true });
    expect(enableElevenLabs(service.dir)).toEqual({ enabled: true, circuitClosed: true });
    const after = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(after).toMatchObject({ enabled: true, apiKey: "secret-test-key", voiceId: "voice-fr" });
    expect(after).not.toHaveProperty("disabledReason");
    expect(service.status()).not.toHaveProperty("voiceStatus");
    expect(http).toHaveBeenCalledTimes(1);
    expect(errors(service.dir).at(-1)).toMatchObject({ event: "circuit_closed" });
  });
});
