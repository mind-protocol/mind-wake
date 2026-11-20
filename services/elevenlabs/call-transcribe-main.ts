import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ElevenLabs } from "./service.js";

const controller = new AbortController();
process.on("message", (message: unknown) => {
  if ((message as { cancel?: boolean } | null)?.cancel === true) controller.abort();
});

// One current call segment over stdin. No audio or credential in process arguments/logs.
try {
  const dir = process.env["MIND_WAKE_DATA_DIR"];
  if (!dir) throw Error("missing_profile");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 4_125_000) throw Error("audio_too_large");
    chunks.push(bytes);
  }
  const audio = Buffer.concat(chunks);
  // Decode only to measure and bound the segment; speech recognition stays on ElevenLabs.
  const durationSeconds = await new Promise<number>((resolve, reject) => {
    const decoder = spawn("ffmpeg", ["-v", "error", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1"],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"], signal: controller.signal });
    let decoded = 0;
    const timer = setTimeout(() => { decoder.kill(); reject(Error("decode_timeout")); }, 10_000);
    decoder.stdout.on("data", (bytes: Buffer) => { decoded += bytes.length; if (decoded > 65 * 32000) decoder.kill(); });
    decoder.once("error", () => { clearTimeout(timer); reject(Error("decode_failed")); });
    decoder.once("close", code => {
      clearTimeout(timer);
      if (code !== 0 || decoded <= 0 || decoded > 65 * 32000) reject(Error("audio_invalid"));
      else resolve(decoded / 32000);
    });
    decoder.stdin.on("error", () => {});
    decoder.stdin.end(audio);
  });
  const service = new ElevenLabs(dir);
  const result = await service.transcribeDesktop({
    audio: audio.toString("base64"),
    mime: process.argv[2], capturedAt: new Date().toISOString(), request_id: randomUUID(),
  }, controller.signal);
  process.stdout.write(JSON.stringify({ ...result, durationSeconds }));
} catch {
  // Never expose provider headers, tokens or captured speech in diagnostics.
  process.stdout.write(JSON.stringify({ error: "transcription_failed" }));
  process.exitCode = 1;
}

finally { if (process.connected) process.disconnect(); }
