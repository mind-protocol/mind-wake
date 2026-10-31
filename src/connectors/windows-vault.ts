import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ConnectorError, type SecretVault } from "./core.js";

const refPattern = /^[0-9a-f-]{36}$/;
// Fixed program: secret bytes travel only through private pipes, never command arguments/environment.
const PROGRAM = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security;
try {
 $r = [Console]::In.ReadToEnd() | ConvertFrom-Json;
 $bytes = [Convert]::FromBase64String($r.data);
 $entropy = [Text.Encoding]::UTF8.GetBytes('mind-wake-connectors-v1');
 if ($r.op -eq 'protect') { $out = [Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser) }
 elseif ($r.op -eq 'unprotect') { $out = [Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser) }
 else { exit 1 };
 [Console]::Out.Write([Convert]::ToBase64String($out));
 [Array]::Clear($bytes,0,$bytes.Length); [Array]::Clear($out,0,$out.Length);
} catch { exit 1 }`;

export class WindowsVault implements SecretVault {
  constructor(readonly directory: string) {}

  private async crypt(op: "protect" | "unprotect", bytes: Buffer): Promise<Buffer> {
    if (process.platform !== "win32") throw new ConnectorError("vault_unavailable");
    const root = process.env["SystemRoot"] ?? "C:\\Windows";
    return new Promise((resolve, reject) => {
      const child = spawn(
        path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PROGRAM],
        {
          windowsHide: true,
          env: { SystemRoot: root },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => child.kill(), 10_000);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 262144) child.kill();
        else chunks.push(chunk);
      });
      child.stderr.resume(); // Never forward OS/provider diagnostics.
      child.stdin.on("error", () => undefined);
      child.on("error", () => {
        clearTimeout(timer);
        reject(new ConnectorError("vault_unavailable"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 || size === 0 || size > 262144)
          reject(new ConnectorError("vault_unavailable"));
        else resolve(Buffer.from(Buffer.concat(chunks).toString("ascii"), "base64"));
      });
      child.stdin.end(JSON.stringify({ op, data: bytes.toString("base64") }));
    });
  }

  private file(ref: string): string {
    if (!refPattern.test(ref)) throw new ConnectorError("vault_unavailable");
    return path.join(this.directory, ref + ".dpapi");
  }

  async put(value: string): Promise<string> {
    if (Buffer.byteLength(value) > 65536) throw new ConnectorError("invalid_input");
    const bytes = Buffer.from(value);
    try {
      const encrypted = await this.crypt("protect", bytes);
      await fs.mkdir(this.directory, { recursive: true });
      const ref = randomUUID();
      await fs.writeFile(this.file(ref), encrypted, { flag: "wx", mode: 0o600 });
      return ref;
    } catch {
      throw new ConnectorError("vault_unavailable");
    } finally {
      bytes.fill(0);
    }
  }

  async get(ref: string): Promise<string> {
    try {
      const encrypted = await fs.readFile(this.file(ref));
      if (encrypted.length > 262144) throw new ConnectorError("vault_unavailable");
      const bytes = await this.crypt("unprotect", encrypted);
      try {
        return bytes.toString("utf8");
      } finally {
        bytes.fill(0);
      }
    } catch {
      throw new ConnectorError("vault_unavailable");
    }
  }

  async delete(ref: string): Promise<void> {
    try {
      await fs.rm(this.file(ref), { force: true });
    } catch {
      throw new ConnectorError("vault_unavailable");
    }
  }
}
