import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import { desktopRoom } from "../../services/mcp/computer-use-tools.js";
import { registerDesktopTools } from "../../services/mcp/desktop-tools.js";

describe("desktop room routing", () => {
  it("routes the principal with no fork metadata to Room 1", () => {
    expect(desktopRoom({})).toBe("1");
    expect(desktopRoom({ MIND_WAKE_DATA_DIR: "D" })).toBe("1");
  });
  it("keeps explicit host room precedence and rejects invalid scope", () => {
    expect(desktopRoom({ MIND_WAKE_DESKTOP_ROOM: "7", MIND_WAKE_OWNER_FORK: "5" })).toBe("7");
    expect(desktopRoom({ MIND_WAKE_OWNER_FORK: "5" })).toBe("5");
    expect(desktopRoom({ MIND_WAKE_FORK_ID: "3" })).toBe("3");
    for (const room of ["", "0", "-1", "../1", "1.5"]) expect(() => desktopRoom({ MIND_WAKE_DESKTOP_ROOM: room })).toThrow();
  });
  it("provides safe browser bootstrap without marking navigation read-only", () => {
    const configs = new Map<string, { inputSchema: { safeParse: (value: unknown) => { success: boolean } }; annotations?: { readOnlyHint?: boolean } }>();
    const server = { registerTool(name: string, config: unknown) { configs.set(name, config as never); } } as unknown as McpServer;
    registerDesktopTools(server, "python", "Marco", "1", "D");
    const open = configs.get("desktop_open_url")!;
    expect(open).toBeDefined();
    expect(open.annotations?.readOnlyHint).not.toBe(true);
    for (const url of ["https://mindprotocol.ai", "http://localhost:8789/"]) expect(open.inputSchema.safeParse({ url }).success).toBe(true);
    for (const url of ["file:///C:/secret", "javascript:alert(1)", "https://user:pass@example.com", "chrome://settings", "/local"]) expect(open.inputSchema.safeParse({ url }).success).toBe(false);
    expect(configs.get("desktop_observe")!.inputSchema.safeParse({}).success).toBe(true);
    expect(configs.get("desktop_observe")!.annotations?.readOnlyHint).toBe(true);
  });
  it("accepts an optional Windows virtual desktop number on every desktop tool and lists desktops", () => {
    const configs = new Map<string, { description: string; inputSchema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } }; annotations?: { readOnlyHint?: boolean } }>();
    const server = { registerTool(name: string, config: unknown) { configs.set(name, config as never); } } as unknown as McpServer;
    registerDesktopTools(server, "python", "Marco", "3", "D");
    expect(configs.get("desktop_list")!.annotations?.readOnlyHint).toBe(true);
    expect(configs.get("desktop_list")!.inputSchema.safeParse({}).success).toBe(true);
    const windows = configs.get("desktop_windows")!.inputSchema;
    expect(windows.safeParse({}).success).toBe(true);
    expect(windows.safeParse({ desktop: 2 }).success).toBe(true);
    for (const desktop of [0, -1, 1.5, "1"]) expect(windows.safeParse({ desktop }).success).toBe(false);
    const samples: Record<string, object> = {
      desktop_page: { window: "x" }, desktop_observe: {}, desktop_act: { window: "x", actions: [{ op: "wait", ms: 1 }] },
      desktop_open_url: { url: "https://example.com" }, desktop_tabs: { window: "x" }, desktop_sweep: {}, desktop_taskbar: {},
      desktop_click_excerpt: { capture: "6f1c1d4e-9e1a-4c1b-8a49-6c3f3c1f0a11", excerpt: "x" },
    };
    for (const [name, sample] of Object.entries(samples)) {
      expect(configs.get(name)!.inputSchema.safeParse({ ...sample, desktop: 1 }).success, name).toBe(true);
      expect(configs.get(name)!.inputSchema.safeParse({ ...sample, desktop: 0 }).success, name).toBe(false);
    }
    expect(configs.get("desktop_page")!.inputSchema.safeParse({ window: "LinkedIn", desktop: 1, text: true }).success).toBe(true);
    expect(configs.get("desktop_slice")!.inputSchema.safeParse({ capture: "6f1c1d4e-9e1a-4c1b-8a49-6c3f3c1f0a11", slice: 1, desktop: 1 }).success).toBe(false);
    expect(configs.get("desktop_open_url")!.description).toContain("human's usual Chrome profile");
  });
  it("keeps French worker messages free of double-encoded UTF-8", () => {
    for (const file of ["desktop-control.py", "desktop-tools.ts", "room_desktop.py"]) {
      const source = fs.readFileSync(path.join(import.meta.dirname, "../../services/mcp", file), "utf8");
      expect(source, file).not.toMatch(/Ã|Â|â€/);
    }
    expect(fs.readFileSync(path.join(import.meta.dirname, "../../services/mcp/desktop-control.py"), "utf8")).toContain('title="Barre des tâches"');
  });
  it("stitches overlapping page slices without repeating lines", () => {
    const source = path.join(import.meta.dirname, "../../services/mcp/desktop-control.py");
    const script = `import ast,json,sys
tree=ast.parse(open(sys.argv[1],encoding='utf-8').read())
fn=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='stitch'][0]
ns={}
exec(compile(ast.Module([fn],[]),'s','exec'),ns)
print(json.dumps(ns['stitch']([['a','b','c'],['b','c','d'],['d','e'],['x']])))`;
    const out = execFileSync(process.env["MIND_WAKE_DESKTOP_PYTHON"] ?? "python", ["-c", script, source], { encoding: "utf8" });
    expect(JSON.parse(out)).toBe(["a", "b", "c", "d", "e", "x"].join("\n"));
  });
  it.runIf(process.platform === "win32")("rejects a virtual desktop number that Windows does not have, without input", () => {
    const worker = path.join(import.meta.dirname, "../../services/mcp/desktop-control.py");
    const result = spawnSync(process.env["MIND_WAKE_DESKTOP_PYTHON"] ?? "python", [worker], {
      input: JSON.stringify({ tool: "desktop_windows", args: {}, desktop: 32, owner: { id: "t", name: "t" }, cache: "" }),
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      timeout: 60_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Bureau virtuel 32 inexistant");
  }, 70_000);
});
