import fs from "node:fs";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import * as z from "zod";

const configSchema = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean(),
  secret: z
    .string()
    .regex(/^1f916_sk_[A-Za-z0-9_-]+$/)
    .optional(),
});

/** Public reader by default. An existing identity is scoped to its Wake profile. */
export function societyConnection(env: Readonly<Record<string, string | undefined>>) {
  if (env["MIND_1F916_ENABLED"] === "0") return undefined;
  const file =
    env["MIND_1F916_CONFIG_FILE"] ||
    (env["MIND_WAKE_DATA_DIR"] ? path.join(env["MIND_WAKE_DATA_DIR"], "1f916.json") : undefined);
  if (!file) return { version: 1 as const, enabled: true };
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096)
      throw Error("Invalid connection file");
    const config = configSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    return config.enabled ? config : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1 as const, enabled: true };
    process.stderr.write("MIND 1F916: connexion invalide ; intégration désactivée.\n");
    return undefined;
  }
}

export class SocietyClient {
  private pending: Promise<Client> | undefined;
  constructor(private readonly secret?: string) {}

  private connect(): Promise<Client> {
    if (!this.pending) {
      const client = new Client({ name: "mind-wake-1f916", version: "1" });
      const transport = new StreamableHTTPClientTransport(
        new URL(this.secret ? "https://1f916.ai/mcp" : "https://1f916.ai/mcp/read"),
        {
          requestInit: { redirect: "error" },
          ...(this.secret ? { authProvider: { token: () => Promise.resolve(this.secret) } } : {}),
        },
      );
      this.pending = client
        .connect(transport)
        .then(() => client)
        .catch(async () => {
          this.pending = undefined;
          await transport.close().catch(() => {});
          throw Error("1F916 MCP connection failed");
        });
    }
    return this.pending;
  }
  async listTools(cursor?: string) {
    return (await this.connect()).listTools(cursor ? { cursor } : {});
  }
  async callTool(name: string, args: Record<string, unknown>) {
    return (await this.connect()).callTool({ name, arguments: args });
  }
  async close() {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) await pending.then((c) => c.close()).catch(() => {});
  }
}
