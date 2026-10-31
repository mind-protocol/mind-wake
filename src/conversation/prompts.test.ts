import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { CONVERSATION_ROLES } from "./contracts.js";
import { rolePrompt } from "./prompts.js";

describe("role-specific rewrite prompts", () => {
  for (const role of CONVERSATION_ROLES) {
    it(`loads the ${role} rewrite without its first-pass output contract`, () => {
      const read = (file: string) =>
        fs.readFileSync(new URL(`../../prompts/conversation/${file}`, import.meta.url), "utf8").trim();
      const common = read("common.md");
      const firstPass = read(`${role}.md`);
      const rewrite = read(`rewrite/${role}.md`);
      const contract = read("rewrite.md");
      expect(rolePrompt(role, 1)).toBe(`${common}\n\n${firstPass}`);
      expect(rolePrompt(role, 2)).toBe(`${common}\n\n${rewrite}\n\n${contract}`);
      expect(rolePrompt(role, 2)).not.toContain(firstPass);
    });
  }
});
