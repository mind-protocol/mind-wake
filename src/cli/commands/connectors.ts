import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import * as z from "zod";
import type { CliContext } from "../context.js";
import type { DataDir } from "../paths.js";
import type { CommandResult } from "../output.js";
import {
  ConnectorError,
  ConnectorGate,
  newGeneration,
  safeConnectorError,
  type LiveControl,
} from "../../connectors/core.js";
import { ConnectorRecords, wakeConnectorControl } from "../../connectors/local.js";
import { gmailConfigSchema, GMAIL_HOSTS, type GmailConfig } from "../../connectors/gmail.js";
import { beginGmailOAuth } from "../../connectors/oauth.js";
import { isTrustedUserChannel, openTrustedUserChannel } from "../../policy/index.js";
import { notionCommand } from "./notion.js";

/** System browser through Windows ShellExecute; URL only in private stdin, no logging. */
async function systemBrowser(url: string): Promise<void> {
  if (process.platform !== "win32") throw new ConnectorError("unavailable");
  const root = process.env["SystemRoot"] ?? "C:\\Windows";
  return new Promise((resolve, reject) => {
    const child = spawn(
      path.join(root, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; try {$s=New-Object Diagnostics.ProcessStartInfo; $s.FileName=[Console]::In.ReadToEnd(); $s.UseShellExecute=$true; [Diagnostics.Process]::Start($s) | Out-Null} catch {exit 1}",
      ],
      { env: { SystemRoot: root }, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] },
    );
    const timer = setTimeout(() => child.kill(), 10_000);
    child.on("error", () => {
      clearTimeout(timer);
      reject(new ConnectorError("unavailable"));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new ConnectorError("unavailable"));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(url);
  });
}

export async function connectors(
  ctx: CliContext,
  dir: DataDir,
  action: string,
  filename?: string,
  // In-process dependency injection only; never read from CLI flags/environment.
  seams: {
    records?: ConnectorRecords;
    control?: () => LiveControl;
    interactive?: () => boolean;
    browser?: (url: string) => Promise<void>;
    transport?: typeof fetch;
  } = {},
): Promise<CommandResult<unknown>> {
  if (action.startsWith("notion-")) return notionCommand(ctx, dir, action, filename);
  const records = seams.records ?? new ConnectorRecords(dir.path);
  const control = seams.control ?? (() => wakeConnectorControl(dir.path, GMAIL_HOSTS));
  try {
    if (action === "status") {
      const record = await records.read<GmailConfig>("gmail");
      return {
        exitCode: 0,
        human: (data) => JSON.stringify(data),
        data: {
          installed: true,
          configured: record !== null,
          authorized: record?.grant.enabled === true,
          available: false,
          eligible: record?.grant.enabled === true && record.tokenRef !== null && control().allowed,
          availabilityMeaning:
            "provider not probed by this read-only command; use MCP gmail_status after a successful read",
        },
      };
    }
    // Exactly the existing trusted CLI channel; no auth command registered with MCP.
    if (!ctx.prompt || !(seams.interactive?.() ?? (process.stdin.isTTY && process.stdout.isTTY)))
      throw new ConnectorError("disabled");
    const channel = openTrustedUserChannel();
    if (!isTrustedUserChannel(channel)) throw new ConnectorError("disabled");
    if (action === "gmail-disconnect") {
      if ((await ctx.prompt("Disconnect Gmail locally now? Type DISCONNECT: ")) !== "DISCONNECT")
        throw new ConnectorError("disabled");
      const record = await records.read<GmailConfig>("gmail").catch(() => null);
      const cleanup = { failed: false };
      await records.remove("gmail").catch(() => {
        cleanup.failed = true;
      });
      // A failed unlink is different from failed encrypted-secret cleanup.
      if (fs.existsSync(path.join(records.directory, "gmail.ref")))
        throw new ConnectorError("vault_unavailable");
      if (record?.tokenRef)
        await records.vault.delete(record.tokenRef).catch(() => {
          cleanup.failed = true;
        });
      return {
        exitCode: 0,
        human: () =>
          "Local access closed. Remote revocation was not attempted; remove access in Google Account > Third-party connections.",
        data: {
          locallyRevoked: true,
          secretCleanup: cleanup.failed ? "failed" : "complete",
          remoteRevocation: "not_attempted",
        },
      };
    }
    if (action !== "gmail-setup" || !filename) throw new ConnectorError("invalid_input");
    if (!control().allowed) throw new ConnectorError("stopped");
    if (fs.statSync(filename).size > 65536) throw new ConnectorError("invalid_input");
    const setup = z
      .strictObject({
        config: gmailConfigSchema,
        clientSecret: z.string().min(1).max(4096).optional(),
      })
      .parse(JSON.parse(fs.readFileSync(filename, "utf8")) as unknown);
    const setupRef = records.currentRef("gmail");
    const answer = await ctx.prompt(
      "Google gmail.readonly is RESTRICTED and covers your mailbox/settings, not just a label. " +
        "Wake will additionally restrict reads to this local scope:\n" +
        JSON.stringify(setup.config, null, 2) +
        "\nRead content will reach your configured model provider when requested. No file export/body cache/attachments. " +
        "This starts OAuth in your system browser. Type CONNECT to authorize this local scope: ",
    );
    if (answer !== "CONNECT" || !control().allowed) throw new ConnectorError("disabled");
    const old = await records.read<GmailConfig>("gmail");
    const grant = {
      provider: "gmail",
      account: setup.config.account,
      generation: newGeneration(),
      enabled: true,
    };
    await records.write("gmail", { config: setup.config, grant, tokenRef: null }, setupRef);
    const expectedRef = records.currentRef("gmail");
    if (old?.tokenRef) await records.vault.delete(old.tokenRef);
    const gate = new ConnectorGate(
      control,
      async () => (await records.read<GmailConfig>("gmail"))?.grant ?? null,
    );
    const stored: { tokenRef: string | null } = { tokenRef: null };
    try {
      await gate.run(
        "gmail",
        setup.config.account,
        async (signal, check) => {
          const pending = await beginGmailOAuth({
            clientId: setup.config.clientId,
            account: setup.config.account,
            ...(setup.clientSecret ? { clientSecret: setup.clientSecret } : {}),
            signal,
            check,
            ...(seams.transport ? { transport: seams.transport } : {}),
          });
          try {
            await (seams.browser ?? systemBrowser)(pending.authorizationUrl);
            const tokens = await pending.complete();
            await check();
            stored.tokenRef = await records.vault.put(JSON.stringify(tokens));
            await check();
            await records.write(
              "gmail",
              { config: setup.config, grant, tokenRef: stored.tokenRef },
              expectedRef,
            );
          } finally {
            pending.cancel();
          }
        },
        180_000,
      );
    } catch (error) {
      const current = await records.read<GmailConfig>("gmail").catch(() => null);
      // Do not erase another owner's newer setup/revocation.
      if (
        fs.existsSync(path.join(records.directory, "gmail.ref")) &&
        (records.currentRef("gmail") === expectedRef ||
          (current?.grant.generation === grant.generation && current.tokenRef === stored.tokenRef))
      )
        await records.remove("gmail").catch(() => undefined);
      if (stored.tokenRef) await records.vault.delete(stored.tokenRef).catch(() => undefined);
      throw error;
    }
    return {
      exitCode: 0,
      human: () => "Gmail connected within the confirmed local scope.",
      data: { connected: true },
    };
  } catch (error) {
    return {
      exitCode: 1,
      human: (data) => "Connector operation refused or unavailable: " + JSON.stringify(data),
      data: safeConnectorError(error),
    };
  }
}
