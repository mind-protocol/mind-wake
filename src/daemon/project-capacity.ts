/** Workspace-specific project policy; callers hold the shared project registry lock. */
export class ProjectCapacityError extends Error {}

export function projectStatus(status: unknown): "active" | "paused" | "blocked" | "archived" {
  const text = (typeof status === "string" ? status : "").toLowerCase();
  if (/pause|arrêt|arrete|stopped/.test(text)) return "paused";
  if (/attend|bloqu|blocked/.test(text)) return "blocked";
  if (/termin[eé]|^fini$|archiv/.test(text)) return "archived";
  return "active";
}

/** No default limit: one owner's policy must not become another installation's rule. */
export function assertProjectActivation(counter: Record<string, unknown>, id: string): void {
  const limit = counter["activeProjectLimit"];
  if (limit === undefined) return;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1)
    throw Error("Invalid activeProjectLimit; set a positive integer or remove the local policy");
  const registry = counter["projects"];
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) throw Error("Invalid project registry");
  const rows = registry as Record<string, unknown>;
  const active = Object.entries(rows).filter(([key, row]) =>
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key) && row && typeof row === "object" && !Array.isArray(row) &&
    projectStatus((row as Record<string, unknown>)["status"]) === "active").map(([key]) => key);
  if (active.includes(id)) return; // Existing work and pauses remain possible, even above a lowered limit.
  if (active.length >= limit)
    throw new ProjectCapacityError(`Active project limit (${limit}) reached: ${active.join(", ")}. Pause a project at an explicit milestone before activating ${id}.`);
}
