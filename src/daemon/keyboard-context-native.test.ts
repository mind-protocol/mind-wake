import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
it.runIf(process.platform === "win32")(
  "observes synthetic edits but excludes a protected field and preexisting content",
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-keyboard-native-"));
    const native = fs.readFileSync(
      fileURLToPath(new URL("./keyboard-context-native.ps1", import.meta.url)),
      "utf8",
    );
    const fixture = fs.readFileSync(
      fileURLToPath(new URL("../../test/helpers/keyboard-context-form.ps1", import.meta.url)),
      "utf8",
    );
    const windowAnchor = "$window=[WakeInputWindow]::GetForegroundWindow()";
    const focusAnchor = "$element=[System.Windows.Automation.AutomationElement]::FocusedElement";
    expect(native).toContain(windowAnchor);
    expect(native).toContain(focusAnchor);
    const script = native
      .replace("$heartbeat=[DateTime]::UtcNow", "$heartbeat=[DateTime]::UtcNow\n" + fixture)
      .replace(windowAnchor, "$window=$testForm.Handle")
      .replace(
        focusAnchor,
        "$element=[System.Windows.Automation.AutomationElement]::FromHandle($testBox.Handle)",
      )
      .replace(
        "  Reset-Baseline\n  $icon.Visible=$false",
        "  Reset-Baseline\n  $testTimer.Stop();$testForm.Close();$testTimer.Dispose();$testForm.Dispose()\n  $icon.Visible=$false",
      );
    const file = path.join(dir, "fixture.ps1");
    fs.writeFileSync(file, script);
    try {
      const result = await new Promise<{
        safe: boolean;
        protectedLeak: boolean;
        initialLeak: boolean;
        code: number | null;
      }>((resolve, reject) => {
        const child = spawn(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-STA", "-File", file],
          { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
        );
        let tail = "",
          safe = false,
          protectedLeak = false,
          initialLeak = false;
        child.stdout.on("data", (chunk: Buffer) => {
          tail += chunk.toString();
          const lines = tail.split("\n");
          tail = lines.pop() ?? "";
          for (const line of lines)
            try {
              const e = JSON.parse(line) as Record<string, unknown>;
              if (e["type"] === "text" && typeof e["text"] === "string") {
                safe ||= e["text"].includes("useful") || e["text"].includes("updated");
                protectedLeak ||= e["text"].includes("never-capture-this");
                initialLeak ||= e["text"].includes("existing before collection");
              }
            } catch {
              /* native protocol ignores non-events */
            }
        });
        child.stderr.resume();
        const stop = setTimeout(() => child.stdin.end("stop\n"), 9000),
          kill = setTimeout(() => child.kill(), 13000);
        child.once("error", (error) => {
          clearTimeout(stop);
          clearTimeout(kill);
          reject(error);
        });
        child.once("close", (code) => {
          clearTimeout(stop);
          clearTimeout(kill);
          tail = "";
          resolve({ safe, protectedLeak, initialLeak, code });
        });
      });
      expect(result).toEqual({ safe: true, protectedLeak: false, initialLeak: false, code: 0 });
    } finally {
      if (!path.resolve(dir).startsWith(path.join(os.tmpdir(), "wake-keyboard-native-")))
        throw Error("Unexpected test directory");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  20000,
);
