import fs from "node:fs";
import path from "node:path";
import * as z from "zod";

export const redditConnectionSchema = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean(),
  clientId: z.string().regex(/^[a-zA-Z0-9_-]{5,100}$/),
  clientSecret: z.string().max(1000).optional(),
  refreshToken: z.string().min(1).max(4096),
  userAgent: z
    .string()
    .min(1)
    .max(300)
    .regex(/^[^\r\n]+$/),
  allowWrite: z.boolean().default(false),
  scopes: z.array(z.string()).default(["identity", "read"]),
  syncReplies: z.boolean().default(false),
  subscriptions: z
    .array(z.string().regex(/^[A-Za-z0-9_]{2,21}$/))
    .max(50)
    .default([]),
});

/** Never fall back to credentials belonging to another profile. */
export function redditEnvironment(env: Readonly<Record<string, string | undefined>>) {
  const file =
    env["MIND_REDDIT_CONFIG_FILE"] ||
    (env["MIND_WAKE_DATA_DIR"] ? path.join(env["MIND_WAKE_DATA_DIR"], "reddit.json") : undefined);
  if (!file) return env;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384)
      throw new Error("Invalid credential file");
    const config = redditConnectionSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    return {
      ...env,
      MIND_REDDIT_ENABLED: config.enabled ? "1" : "0",
      MIND_REDDIT_CLIENT_ID: config.clientId,
      MIND_REDDIT_CLIENT_SECRET: config.clientSecret,
      MIND_REDDIT_REFRESH_TOKEN: config.refreshToken,
      MIND_REDDIT_USER_AGENT: config.userAgent,
      MIND_REDDIT_ALLOW_WRITE: config.allowWrite ? "1" : "0",
      MIND_REDDIT_ACCESS_TOKEN: undefined,
      MIND_REDDIT_SYNC_REPLIES: config.syncReplies ? "1" : "0",
      MIND_REDDIT_SUBSCRIPTIONS: config.subscriptions.join(","),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return env;
    process.stderr.write("MIND Reddit: fichier de connexion invalide ; intégration désactivée.\n");
    return { ...env, MIND_REDDIT_ENABLED: "0", MIND_REDDIT_ALLOW_WRITE: "0" };
  }
}
