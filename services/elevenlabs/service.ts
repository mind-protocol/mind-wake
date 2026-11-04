import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as z from "zod";
import { externalInboxSyncAllowed } from "../../src/communication/external-inbox-policy.js";

const voiceId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const configSchema = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean(),
  apiKey: z.string().max(512),
  voiceId: voiceId.or(z.literal("")),
  autoplay: z.boolean(),
});
const configureSchema = configSchema.omit({ version: true, apiKey: true }).extend({
  apiKey: z.string().max(512).optional(),
});
export const speechSchema = z.strictObject({
  text: z.string().trim().min(1).max(5000),
  voice_id: voiceId.optional(),
});
const clipSchema = z.strictObject({
  id: z.uuid(),
  text: z.string(),
  voiceId: z.string(),
  createdAt: z.string(),
  autoplay: z.boolean(),
});

/** Profile-local credentials and MP3 spool. No provider key reaches the webview or MCP. */
export class ElevenLabs {
  constructor(
    readonly dir: string,
    private readonly http: typeof fetch = fetch,
    private readonly active: () => boolean = () => externalInboxSyncAllowed(dir),
  ) {}
  private file() {
    return path.join(this.dir, "elevenlabs.json");
  }
  private spool() {
    return path.join(this.dir, "elevenlabs-audio");
  }
  private config() {
    try {
      return configSchema.parse(JSON.parse(fs.readFileSync(this.file(), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1 as const, enabled: false, apiKey: "", voiceId: "", autoplay: true };
      throw Error("Configuration ElevenLabs invalide.", { cause: error });
    }
  }
  status() {
    const { apiKey, ...config } = this.config();
    return { ...config, hasKey: !!apiKey };
  }
  configure(input: unknown) {
    const draft = configureSchema.parse(input);
    const previous = this.config();
    const config = { ...previous, ...draft, apiKey: draft.apiKey?.trim() || previous.apiKey };
    if (config.enabled && (!config.apiKey || !config.voiceId))
      throw Error("Clé API et voix requises pour activer ElevenLabs.");
    fs.mkdirSync(this.dir, { recursive: true });
    const temporary = `${this.file()}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(config), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, this.file());
    return this.status();
  }
  private async request(endpoint: string, init: RequestInit = {}) {
    const { apiKey } = this.config();
    if (!apiKey) throw Error("Configurer la clé API ElevenLabs dans Réglages.");
    const response = await this.http(`https://api.elevenlabs.io${endpoint}`, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    });
    if (!response.ok)
      throw Error(
        `ElevenLabs HTTP ${String(response.status)} : vérifier les droits et crédits du compte.`,
      );
    return response;
  }
  async voices(cursor?: string) {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("next_page_token", z.string().max(2048).parse(cursor));
    const response = await this.request(`/v2/voices?${query}`);
    return z
      .object({
        voices: z.array(
          z.object({
            voice_id: voiceId,
            name: z.string(),
            category: z.string().optional(),
            labels: z.record(z.string(), z.string()).optional(),
          }),
        ),
        has_more: z.boolean(),
        next_page_token: z.string().nullable().optional(),
      })
      .parse(await response.json());
  }
  private allowed() {
    if (!this.config().enabled) throw Error("ElevenLabs est désactivé.");
    if (!this.active()) throw Error("Wake est en pause, arrêté ou indisponible.");
  }
  async generate(input: unknown) {
    const args = speechSchema.parse(input);
    this.allowed();
    const config = this.config();
    const selected = voiceId.parse(args.voice_id ?? config.voiceId);
    const response = await this.request(
      `/v1/text-to-speech/${selected}?output_format=mp3_44100_128`,
      {
        method: "POST",
        body: JSON.stringify({ text: args.text, model_id: "eleven_multilingual_v2" }),
      },
    );
    // Bound memory even when a provider returns an unexpected payload.
    const reader = response.body?.getReader();
    if (!reader) throw Error("Audio ElevenLabs vide.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16 * 1024 * 1024) throw Error("Audio ElevenLabs trop volumineux.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (!size || !response.headers.get("content-type")?.startsWith("audio/"))
      throw Error("Réponse audio ElevenLabs invalide.");
    this.allowed(); // Never enqueue playback after a Pause/Force-off during generation.
    const clip = {
      id: randomUUID(),
      text: args.text,
      voiceId: selected,
      createdAt: new Date().toISOString(),
      autoplay: config.autoplay,
    };
    fs.mkdirSync(this.spool(), { recursive: true });
    const audioPath = path.join(this.spool(), `${clip.id}.mp3`);
    fs.writeFileSync(audioPath, Buffer.concat(chunks), { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(this.spool(), `${clip.id}.json`), JSON.stringify(clip), {
      flag: "wx",
      mode: 0o600,
    });
    return { ...clip, audioPath, playback: "queued_for_desktop" };
  }
  pending() {
    const config = this.config();
    if (!config.enabled || !this.active()) return { allowed: false, clips: [] };
    let names: string[];
    try {
      names = fs.readdirSync(this.spool());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { allowed: true, clips: [] };
      throw error;
    }
    const clips = names
      .filter((n) => /^[0-9a-f-]{36}\.json$/.test(n))
      .map((n) => clipSchema.parse(JSON.parse(fs.readFileSync(path.join(this.spool(), n), "utf8"))))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      allowed: true,
      clips: clips
        .slice(0, 20)
        .map((clip) => ({ ...clip, autoplay: clip.autoplay && config.autoplay })),
    };
  }
  audio(id: string) {
    this.allowed();
    z.uuid().parse(id);
    const file = path.join(this.spool(), `${id}.mp3`);
    if (fs.statSync(file).size > 16 * 1024 * 1024) throw Error("Audio trop volumineux.");
    return { id, base64: fs.readFileSync(file).toString("base64") };
  }
  acknowledge(id: string) {
    z.uuid().parse(id);
    // Retain MP3 for replay/export; remove only the pending delivery marker.
    fs.rmSync(path.join(this.spool(), `${id}.json`), { force: true });
    return { id, acknowledged: true };
  }
}
