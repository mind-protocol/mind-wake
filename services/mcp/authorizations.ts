import fs from "node:fs";
import path from "node:path";
import * as z from "zod";
import { IDEA_CATEGORIES, type Idea } from "./ideas.js";

export const authorizationSchema = z.strictObject({
  version: z.literal(1),
  title: z.string(),
  context: z.string(),
  example: z.string(),
  guidance: z.string(),
  entries: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        action: z.string().min(1),
        decision: z.enum(["authorized", "encouraged", "discouraged", "forbidden"]),
        scope: z.string().min(1),
        category: z.enum(IDEA_CATEGORIES),
      }),
    )
    .refine(
      (entries) => new Set(entries.map((e) => e.id)).size === entries.length,
      "Duplicate authorization IDs",
    ),
});

export type Authorizations = z.infer<typeof authorizationSchema>;

/** Never fall back to the repository owner's choices for an installed profile. */
export function authorizationPath(env: NodeJS.ProcessEnv, cwd = process.cwd()): string {
  return path.join(
    env["MIND_WAKE_DATA_DIR"] ? path.join(env["MIND_WAKE_DATA_DIR"], "workspace") : cwd,
    "AUTORISATIONS.json",
  );
}

export function readAuthorizations(
  file: string,
): { status: "loaded"; document: Authorizations } | { status: "missing" | "invalid" } {
  try {
    const document = authorizationSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    return { status: "loaded", document };
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid" };
  }
}

export function authorizationIdeas(document: Authorizations): Idea[] {
  return document.entries
    .filter((entry) => entry.decision === "authorized" || entry.decision === "encouraged")
    .map((entry) => ({
      category: entry.category,
      text: `${entry.action} — Périmètre : ${entry.scope}`,
      authorizationId: entry.id,
      preference: entry.decision as "authorized" | "encouraged",
    }));
}
