import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ElevenLabs } from "../../services/elevenlabs/service.js";
import { registerElevenLabsTools } from "../../services/mcp/elevenlabs-tools.js";
import type { McpServer } from "@modelcontextprotocol/server";

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
  expect(fs.existsSync(path.join(service.dir, "elevenlabs-audio"))).toBe(false);
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
  expect([...registered.keys()]).toEqual(["elevenlabs_list_voices", "elevenlabs_generate_speech"]);
  new ElevenLabs(directory).configure(settings);
  const handler = registered.get("elevenlabs_list_voices")?.handler;
  if (!handler) throw Error("Missing voices tool");
  const result = await handler({});
  expect(result).toMatchObject({ isError: true });
  expect(JSON.stringify(result)).not.toContain("secret-test-key");
});
