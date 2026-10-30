import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authorizationSchema,
  authorizationPath,
  readAuthorizations,
  authorizationIdeas,
} from "../../services/mcp/authorizations.js";
import { pickIdeas } from "../../services/mcp/ideas.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const document = () =>
  authorizationSchema.parse({
    version: 1,
    title: "Choices",
    context: "",
    example: "",
    guidance: "",
    entries: ["authorized", "encouraged", "discouraged", "forbidden"].map((decision, index) => ({
      id: `A${index}`,
      action: `Action ${index}`,
      decision,
      scope: "Only shared files",
      category: "build",
    })),
  });

describe("owner authorization suggestions", () => {
  it("mixes only positive decisions, retaining scope and provenance", () => {
    const personal = authorizationIdeas(document());
    expect(personal).toHaveLength(2);
    expect(personal.every((i) => i.text.includes("Only shared files"))).toBe(true);
    const picked = pickIdeas(30, ["build"], () => 0, personal);
    expect(picked.filter((i) => i.authorizationId)).toEqual(personal);
    expect(pickIdeas(30, ["fix"], () => 0, personal).every((i) => !i.authorizationId)).toBe(true);
  });
  it("reloads revocations and fails closed on invalid data", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wake-authorizations-"));
    roots.push(root);
    const file = path.join(root, "AUTORISATIONS.json");
    expect(readAuthorizations(file).status).toBe("missing");
    const data = document();
    fs.writeFileSync(file, JSON.stringify(data));
    const first = readAuthorizations(file);
    expect(first.status === "loaded" && authorizationIdeas(first.document).length).toBe(2);
    for (const entry of data.entries) entry.decision = "forbidden";
    fs.writeFileSync(file, JSON.stringify(data));
    const next = readAuthorizations(file);
    expect(next.status === "loaded" && authorizationIdeas(next.document)).toEqual([]);
    fs.writeFileSync(file, "{broken");
    expect(readAuthorizations(file).status).toBe("invalid");
    expect(
      authorizationSchema.safeParse({ ...data, entries: [...data.entries, data.entries[0]] })
        .success,
    ).toBe(false);
  });
  it("uses the installed workspace without inheriting repository choices", () => {
    expect(authorizationPath({ MIND_WAKE_DATA_DIR: "/profile" }, "/repo")).toBe(
      path.join("/profile", "workspace", "AUTORISATIONS.json"),
    );
    expect(authorizationPath({}, "/repo")).toBe(path.join("/repo", "AUTORISATIONS.json"));
  });
});
