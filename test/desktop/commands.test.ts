import fs from "node:fs";
import { expect, it } from "vitest";

it("every desktop command is registered in the build manifest and allowed for the panel", () => {
  const read = (file: string) => fs.readFileSync(new URL(`../../desktop/src-tauri/${file}`, import.meta.url), "utf8");
  const handler = read("src/main.rs").match(/generate_handler!\[([\s\S]*?)\]/)?.[1] ?? "";
  const commands = handler.split(",").map(s => s.trim()).filter(Boolean);
  const manifest = read("build.rs").match(/\.commands\(&\[([\s\S]*?)\]\)/)?.[1] ?? "";
  const registered = [...manifest.matchAll(/"([a-z_]+)"/g)].map(m => m[1]);
  const panel = JSON.parse(read("capabilities/panel.json")) as { permissions: string[] };
  expect(commands.length).toBeGreaterThan(0);
  expect(new Set(registered)).toEqual(new Set(commands));
  for (const command of commands) {
    expect(panel.permissions, command).toContain(`allow-${command.replaceAll("_", "-")}`);
  }
  expect(commands).toContain("wake_always_on");
});
