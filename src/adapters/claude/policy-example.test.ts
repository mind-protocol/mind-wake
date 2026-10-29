/**
 * L'exemple de policy Claude du README passe la validation de `policy configure` et
 * reste identique au fichier `policy-claude.example.json`.
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateDraft } from "../../policy/index.js";
import { claudeRegistration, defaultClaudeConfig } from "./index.js";

const EXAMPLE = fileURLToPath(new URL("./policy-claude.example.json", import.meta.url));
const README = fileURLToPath(new URL("./README.md", import.meta.url));

describe("exemple de policy Claude", () => {
  const draft: unknown = JSON.parse(fs.readFileSync(EXAMPLE, "utf8"));

  it("passe la validation, avec la garde de quota et le consentement non isolé", () => {
    const result = validateDraft(draft, "default");
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it("désigne exactement le runtime déclaré par l'enregistrement (modèle par défaut)", () => {
    const runtime = (draft as { runtime: Record<string, unknown> }).runtime;
    const declared = claudeRegistration(defaultClaudeConfig({})).runtime();
    expect({ ...runtime, hostUnsandboxedAcknowledged: undefined }).toEqual({
      ...declared,
      hostUnsandboxedAcknowledged: undefined,
    });
  });

  it("est reproduite telle quelle dans le README", () => {
    const readme = fs.readFileSync(README, "utf8").replaceAll("\r\n", "\n");
    const json = fs.readFileSync(EXAMPLE, "utf8").replaceAll("\r\n", "\n").trim();
    expect(readme).toContain(json);
  });
});
