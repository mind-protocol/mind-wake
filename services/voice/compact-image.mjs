import { spawn } from "node:child_process";

export const MAX_SCREENSHOT_BYTES = 96_000;
/** Keep aspect ratio, never enlarge, and bound the encoded data before IPC/storage. */
export async function compactScreenshot(base64, ffmpeg = "ffmpeg") {
  const source = Buffer.from(base64, "base64");
  for (const side of [960, 720, 480, 320]) {
    const bytes = await new Promise((resolve, reject) => {
      const child = spawn(
        ffmpeg,
        [
          "-v",
          "error",
          "-f",
          "image2pipe",
          "-i",
          "pipe:0",
          "-vf",
          `scale=w='min(${side},iw)':h='min(${side},ih)':force_original_aspect_ratio=decrease`,
          "-frames:v",
          "1",
          "-threads",
          "1",
          "-q:v",
          "7",
          "-f",
          "image2pipe",
          "-c:v",
          "mjpeg",
          "pipe:1",
        ],
        { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
      );
      const parts = [];
      let size = 0;
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("Compression de capture trop longue."));
      }, 10_000);
      child.stdout.on("data", (part) => {
        size += part.length;
        if (size > 2_000_000) {
          child.kill();
          return;
        }
        parts.push(part);
      });
      child.on("error", () => {
        clearTimeout(timer);
        reject(Error("FFmpeg indisponible pour réduire la capture."));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        code === 0
          ? resolve(Buffer.concat(parts))
          : reject(Error("Échec de réduction de la capture."));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(source);
    });
    if (bytes.length > 0 && bytes.length <= MAX_SCREENSHOT_BYTES) return bytes;
  }
  throw Error("Capture trop volumineuse après compression.");
}
