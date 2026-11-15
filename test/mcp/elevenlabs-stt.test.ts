import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ElevenLabs } from "../../services/elevenlabs/service.js";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
function setup(http: typeof fetch) {
  const dir = fs.mkdtempSync(path.join(process.cwd(), "test/.stt-"));
  dirs.push(dir);
  const service = new ElevenLabs(dir, http, () => true);
  service.configure({
    enabled: true,
    apiKey: "fixture-private",
    voiceId: "Marco",
    autoplay: true,
    transcriptionEnabled: true,
  });
  return { service, dir };
}
const input = {
  audio: "AQID",
  capturedAt: "2026-11-04T20:40:00Z",
  request_id: "current-recording",
};
it("requires separate profile STT consent and keeps it across ordinary TTS saves", async () => {
  const http = vi.fn<typeof fetch>();
  const f = setup(http);
  f.service.configure({ enabled: true, voiceId: "Marco", autoplay: true });
  expect(f.service.status().transcriptionEnabled).toBe(true);
  f.service.configureTranscription(false);
  await expect(f.service.transcribeDesktop(input)).rejects.toThrow(
    "non activée",
  );
  expect(http).not.toHaveBeenCalled();
});
it("checks batch credential without uploading audio, and never returns its token", async () => {
  const http = vi.fn<typeof fetch>(async () =>
    Response.json({ token: "private-temporary-token" }),
  );
  const f = setup(http);
  const result = await f.service.transcriptionPermission();
  expect(result.audioUploaded).toBe(false);
  expect(JSON.stringify(result)).not.toContain("private");
  expect(http).toHaveBeenCalledTimes(1);
  expect(http.mock.calls[0]?.[0]).toBe(
    "https://api.elevenlabs.io/v1/single-use-token/batch_scribe",
  );
  expect(http.mock.calls[0]?.[1]?.body).toBeUndefined();
});
it("never uploads when permission is refused and reports only HTTP and safe code", async () => {
  const http = vi.fn<typeof fetch>(async () =>
    Response.json(
      { detail: { status: "missing_permissions", message: "fixture-private" } },
      { status: 401 },
    ),
  );
  const f = setup(http);
  await expect(f.service.transcribeDesktop(input)).rejects.toThrow(
    "HTTP 401 code=missing_permissions",
  );
  expect(http).toHaveBeenCalledTimes(1);
});
it("sends official multipart with French hint after preflight, deduplicates actual bytes and retains latency metadata", async () => {
  const http = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ token: "temporary" }))
    .mockResolvedValueOnce(
      Response.json({
        text: "Oui, je continue.",
        language_code: "fra",
        words: [{ type: "word" }],
      }),
    );
  const f = setup(http);
  const result = await f.service.transcribeDesktop(input);
  expect(result.text).toBe("Oui, je continue.");
  const form = http.mock.calls[1]?.[1]?.body as FormData;
  expect(form.get("model_id")).toBe("scribe_v2");
  expect(form.get("language_code")).toBe("fr");
  expect(form.get("tag_audio_events")).toBe("false");
  expect(form.get("file")).toBeInstanceOf(Blob);
  expect(http.mock.calls[1]?.[1]?.headers).toBeUndefined(); // Multipart boundary belongs to fetch.
  expect(result).toHaveProperty("captureAgeMs");
  expect(result).toHaveProperty("processingMs");
  expect(
    await new ElevenLabs(f.dir, http, () => true).transcribeDesktop({
      ...input,
      request_id: "retry",
    }),
  ).toEqual(result);
  expect(http).toHaveBeenCalledTimes(2);
});
it("does not invent or translate unexpected-language words and never retries uncertain uploads", async () => {
  const http = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ token: "temporary" }))
    .mockResolvedValueOnce(
      Response.json({
        text: "Нет",
        language_code: "rus",
        words: [{ type: "word" }],
      }),
    );
  const f = setup(http);
  await expect(f.service.transcribeDesktop(input)).rejects.toThrow(
    "langue inattendue",
  );
  await expect(f.service.transcribeDesktop(input)).rejects.toThrow("incertain");
  expect(http).toHaveBeenCalledTimes(2);
});
it("keeps silence empty and honours cancellation before uploading", async () => {
  const http = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ token: "temporary" }))
    .mockResolvedValueOnce(
      Response.json({ text: "", language_code: "fr", words: [] }),
    );
  const f = setup(http);
  expect((await f.service.transcribeDesktop(input)).text).toBe("");
  f.service.cancelTranscription("cancelled");
  await expect(
    f.service.transcribeDesktop({
      ...input,
      audio: "BAUG",
      request_id: "cancelled",
    }),
  ).rejects.toThrow("annulé");
  expect(http).toHaveBeenCalledTimes(2);
});
