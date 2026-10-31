import * as z from "zod";
import { ConnectorError, ConnectorGate } from "../core.js";
import { ConnectorRecords, wakeConnectorControl, type ConnectorRecord } from "../local.js";
import { NotionReadonly, notionId } from "./client.js";
import { notionFetch, NotionError, type NotionTransport } from "./transport.js";
import type { NotionGrant } from "./types.js";

export const NOTION_HOSTS = ["api.notion.com"] as const;
const id = z
  .string()
  .regex(
    /^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
  )
  .transform(notionId);
export const notionConfigSchema = z.strictObject({
  accountId: id,
  workspaceId: id,
  workspaceName: z.string().trim().min(1).max(200),
  rootPageIds: z.array(id).min(1).max(20),
  includeDescendants: z.boolean(),
  mode: z.literal("internal"),
  readContent: z.literal(true),
});
export type NotionConfig = z.infer<typeof notionConfigSchema>;
const credentialSchema = z.strictObject({
  token: z.string().min(1).max(4096),
  accountId: id,
  workspaceId: id,
});

/** Validate the token's bot/workspace, never enumerate users or accept provider URLs. */
export async function verifyNotionIdentity(
  transport: NotionTransport,
  token: string,
  config: NotionConfig,
  signal: AbortSignal,
): Promise<void> {
  const response = await transport({ method: "GET", path: "/users/me" }, token, signal);
  if (response.status !== 200)
    throw new NotionError(response.status === 401 ? "invalid_token" : "identity_unavailable");
  const user = z
    .object({
      object: z.literal("user"),
      type: z.literal("bot"),
      id,
      bot: z.object({
        workspace_id: id,
        workspace_name: z.string(),
        owner: z.object({ type: z.literal("workspace") }),
      }),
    })
    .parse(response.data);
  if (
    user.id !== config.accountId ||
    user.bot.workspace_id !== config.workspaceId ||
    user.bot.workspace_name !== config.workspaceName
  )
    throw new ConnectorError("account_mismatch");
}

/** Production adapter: one common Gate covers identity, every page/retry and the final return. */
export class NotionLocal {
  constructor(
    readonly records: ConnectorRecords,
    readonly control: () => ReturnType<typeof wakeConnectorControl>,
    readonly transport: NotionTransport = notionFetch,
  ) {}

  async run<T>(work: (reader: NotionReadonly) => Promise<T>): Promise<T> {
    const record = await this.records.read<NotionConfig>("notion");
    if (!record?.tokenRef) throw new ConnectorError("disabled");
    const tokenRef = record.tokenRef;
    const config = notionConfigSchema.parse(record.config);
    const gate = new ConnectorGate(this.control, async () => {
      const current = await this.records.read<NotionConfig>("notion");
      return current?.grant.generation === record.grant.generation &&
        current.tokenRef === record.tokenRef
        ? current.grant
        : null;
    });
    return gate.run("notion", config.accountId, async (signal, check) => {
      await check();
      const credential = credentialSchema.parse(
        JSON.parse(await this.records.vault.get(tokenRef)) as unknown,
      );
      await check();
      if (
        credential.accountId !== config.accountId ||
        credential.workspaceId !== config.workspaceId
      )
        throw new ConnectorError("account_mismatch");
      const transport: NotionTransport = async (request, token, requestSignal) => {
        await check();
        const response = await this.transport(request, token, requestSignal);
        await check();
        return response;
      };
      await verifyNotionIdentity(transport, credential.token, config, signal);
      const grant: NotionGrant = {
        ...config,
        credentialRef: tokenRef,
        generation: record.grant.generation,
        signal,
      };
      const reader = new NotionReadonly(
        {
          currentGrant: () => (signal.aborted ? null : grant),
          withCredential: async (binding, use) => {
            await check();
            if (
              binding.accountId !== config.accountId ||
              binding.workspaceId !== config.workspaceId ||
              binding.credentialRef !== record.tokenRef
            )
              throw new ConnectorError("account_mismatch");
            return use(credential.token);
          },
        },
        transport,
      );
      return work(reader);
    });
  }
}

export function notionPublicScope(record: ConnectorRecord<NotionConfig> | null) {
  if (!record) return null;
  const config = notionConfigSchema.parse(record.config);
  return {
    accountId: config.accountId,
    workspaceId: config.workspaceId,
    workspaceName: config.workspaceName,
    rootPageIds: config.rootPageIds,
    includeDescendants: config.includeDescendants,
    readContent: true,
    mode: "internal",
  };
}
