import fs from "node:fs";
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import type { CliContext } from "../context.js";
import type { DataDir } from "../paths.js";
import type { CommandResult } from "../output.js";
import {
  ConnectorError,
  newGeneration,
  safeConnectorError,
  type LiveControl,
} from "../../connectors/core.js";
import { ConnectorRecords, wakeConnectorControl } from "../../connectors/local.js";
import {
  NOTION_HOSTS,
  NotionLocal,
  notionConfigSchema,
  notionPublicScope,
  type NotionConfig,
} from "../../connectors/notion/local.js";
import type { NotionTransport } from "../../connectors/notion/transport.js";
import { isTrustedUserChannel, openTrustedUserChannel } from "../../policy/index.js";

/** Hidden terminal entry, no token in argv, env, config JSON, history or terminal echo. */
export function readNotionSecret(): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(null);
  process.stdout.write("Internal Notion token (hidden): ");
  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const finish = (result: string | null) => {
      process.stdin.off("keypress", keypress);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write("\n");
      value = "";
      resolve(result);
    };
    const keypress = (text: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") finish(null);
      else if (key.name === "return" || key.name === "enter") finish(value || null);
      else if (key.name === "backspace") value = value.slice(0, -1);
      else if (text && !key.ctrl && /^[\x21-\x7e]+$/.test(text)) {
        value += text;
        if (value.length > 4096) finish(null);
      }
    };
    process.stdin.on("keypress", keypress);
  });
}

export async function notionCommand(
  ctx: CliContext,
  dir: DataDir,
  action: string,
  filename?: string,
  seams: {
    records?: ConnectorRecords;
    control?: () => LiveControl;
    interactive?: () => boolean;
    secret?: () => Promise<string | null>;
    transport?: NotionTransport;
  } = {},
): Promise<CommandResult<unknown>> {
  const records = seams.records ?? new ConnectorRecords(dir.path);
  const control = seams.control ?? (() => wakeConnectorControl(dir.path, NOTION_HOSTS));
  const ok = (data: unknown): CommandResult<unknown> => ({
    exitCode: 0,
    data,
    human: (result) => JSON.stringify(result),
  });
  try {
    if (action === "notion-status") {
      const record = await records.read<NotionConfig>("notion");
      return ok({
        installed: true,
        configured: record !== null,
        authorized: record?.grant.enabled === true,
        available: false,
        eligible: record?.grant.enabled === true && !!record.tokenRef && control().allowed,
        scope: notionPublicScope(record),
        availabilityMeaning: "provider_not_probed",
      });
    }
    if (
      !ctx.prompt ||
      !(seams.interactive?.() ?? (process.stdin.isTTY && process.stdout.isTTY)) ||
      !isTrustedUserChannel(openTrustedUserChannel())
    )
      throw new ConnectorError("disabled");
    if (action === "notion-disconnect") {
      if ((await ctx.prompt("Disconnect Notion locally? Type DISCONNECT: ")) !== "DISCONNECT")
        throw new ConnectorError("disabled");
      const old = await records.read<NotionConfig>("notion").catch(() => null);
      const cleanup = { failed: false };
      await records.remove("notion").catch(() => {
        cleanup.failed = true;
      });
      if (fs.existsSync(path.join(records.directory, "notion.ref")))
        throw new ConnectorError("vault_unavailable");
      if (old?.tokenRef)
        await records.vault.delete(old.tokenRef).catch(() => {
          cleanup.failed = true;
        });
      return ok({
        locallyRevoked: true,
        secretCleanup: cleanup.failed ? "failed" : "complete",
        remoteRevocation: "not_attempted",
        next: "Revoke the internal connection token and page sharing in Notion settings.",
      });
    }
    if (action !== "notion-setup" || !filename) throw new ConnectorError("invalid_input");
    if (!control().allowed) throw new ConnectorError("stopped");
    if (fs.statSync(filename).size > 65536) throw new ConnectorError("invalid_input");
    const config = notionConfigSchema.parse(
      JSON.parse(fs.readFileSync(filename, "utf8")) as unknown,
    );
    const before = records.currentRef("notion");
    if (
      (await ctx.prompt(
        "Create an INTERNAL connection with Read content ONLY, no user information, insert or update capability. Share only intended roots; Notion sharing includes descendants. Wake applies the following additional scope:\n" +
          JSON.stringify(config, null, 2) +
          "\nRequested content reaches your configured model provider. No body cache/export/download. Type CONNECT: ",
      )) !== "CONNECT"
    )
      throw new ConnectorError("disabled");
    const token = await (seams.secret ?? readNotionSecret)();
    if (!token || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token))
      throw new ConnectorError("invalid_input");
    if (!control().allowed) throw new ConnectorError("stopped");
    const old = await records.read<NotionConfig>("notion");
    const generation = newGeneration();
    const tokenRef = await records.vault.put(
      JSON.stringify({ token, accountId: config.accountId, workspaceId: config.workspaceId }),
    );
    try {
      await records.write(
        "notion",
        {
          config,
          tokenRef,
          grant: { provider: "notion", account: config.accountId, generation, enabled: true },
        },
        before,
      );
      if (old?.tokenRef) await records.vault.delete(old.tokenRef);
      const local = new NotionLocal(records, control, seams.transport);
      // Prove identity and Read content for each selected root, under the common Gate.
      await local.run(async (reader) => {
        for (const root of config.rootPageIds) await reader.get([{ kind: "page", id: root }]);
      });
      const connected = await records.read<NotionConfig>("notion");
      if (
        connected?.grant.generation !== generation ||
        connected.tokenRef !== tokenRef ||
        !control().allowed
      )
        throw new ConnectorError("stopped");
      return ok({ connected: true, scope: notionPublicScope(connected) });
    } catch (error) {
      const current = await records.read<NotionConfig>("notion").catch(() => null);
      if (current?.grant.generation === generation)
        await records.remove("notion").catch(() => undefined);
      await records.vault.delete(tokenRef).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    return {
      exitCode: 1,
      data: safeConnectorError(error),
      human: (data) => "Connector operation refused or unavailable: " + JSON.stringify(data),
    };
  }
}
