import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ElevenLabs } from "../../services/elevenlabs/service.js";
import { readElevenLabsCircuit, VOICE_CUT_MESSAGE } from "../../src/communication/elevenlabs-circuit.js";

const directories: string[] = [];
function dir() {
  const d = fs.mkdtempSync(path.join(process.cwd(), "test/.elevenlabs-tg-"));
  directories.push(d);
  return d;
}
afterEach(() => {
  for (const d of directories.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const settings = { enabled: true, apiKey: "secret-test-key", voiceId: "voice-fr", autoplay: true };
const mp3 = () => new Response(new Uint8Array([73, 68, 51, 0]), { headers: { "content-type": "audio/mpeg" } });

it("synthesizeMp3 returns MP3 bytes from the selected voice and multilingual model, without queuing desktop playback", async () => {
  const http = vi.fn<typeof fetch>().mockResolvedValue(mp3());
  const service = new ElevenLabs(dir(), http, () => true);
  service.configure(settings);
  const bytes = await service.synthesizeMp3("Bonjour NLR.");
  expect([...bytes]).toEqual([73, 68, 51, 0]);
  const [url, init] = http.mock.calls[0] ?? [];
  expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice-fr?output_format=mp3_44100_128");
  expect(JSON.parse(String(init?.body))).toEqual({ text: "Bonjour NLR.", model_id: "eleven_multilingual_v2" });
  expect(service.pending()).toMatchObject({ clips: [] });
});

it("synthesizeMp3 refuses without HTTP when disabled or when the circuit is open", async () => {
  const http = vi.fn<typeof fetch>();
  const service = new ElevenLabs(dir(), http, () => true);
  service.configure({ ...settings, enabled: false });
  await expect(service.synthesizeMp3("Bonjour")).rejects.toThrow("ElevenLabs est désactivé");
  expect(http).not.toHaveBeenCalled();
});

it("synthesizeMp3 on HTTP 402 rejects, opens the circuit and then refuses without HTTP", async () => {
  const http = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 402 }));
  const service = new ElevenLabs(dir(), http, () => true);
  service.configure(settings);
  await expect(service.synthesizeMp3("Bonjour")).rejects.toThrow(VOICE_CUT_MESSAGE);
  expect(readElevenLabsCircuit(service.dir)).toBeTruthy();
  await expect(service.synthesizeMp3("Bonjour")).rejects.toThrow();
  expect(http).toHaveBeenCalledTimes(1);
});
