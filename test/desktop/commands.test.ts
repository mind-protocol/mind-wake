import fs from "node:fs";
import { expect, it } from "vitest";

it("every desktop command is registered in the build manifest and allowed for the panel", () => {
  const read = (file: string) => fs.readFileSync(new URL(`../../desktop/src-tauri/${file}`, import.meta.url), "utf8");
  const handler = read("src/main.rs").match(/generate_handler!\[([\s\S]*?)\]/)?.[1] ?? "";
  const commands = handler.split(",").map(s => s.trim().split("::").at(-1)!).filter(Boolean);
  const manifest = read("build.rs").match(/\.commands\(&\[([\s\S]*?)\]\)/)?.[1] ?? "";
  const registered = [...manifest.matchAll(/"([a-z_]+)"/g)].map(m => m[1]);
  const panel = JSON.parse(read("capabilities/panel.json")) as { permissions: string[] };
  const quick = JSON.parse(read("capabilities/quick-input.json")) as { permissions: string[] };
  expect(commands.length).toBeGreaterThan(0);
  expect(new Set(registered)).toEqual(new Set(commands));
  for (const command of commands) {
    const permission = `allow-${command.replaceAll("_", "-")}`;
    expect(command.startsWith("quick_input_") ? quick.permissions : panel.permissions, command).toContain(permission);
    if (command.startsWith("app_")) expect(quick.permissions).not.toContain(permission);
  }
  expect(commands).toContain("wake_always_on");
});
