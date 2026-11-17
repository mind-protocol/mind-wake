import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerDesktopTools } from "../../services/mcp/desktop-tools.js";

it("defaults ASCII reads to deltas and accepts explicit full reads", () => {
  const schemas = new Map();
  const server = { registerTool(name: string, config: { inputSchema: unknown }) {
    schemas.set(name, config.inputSchema);
  } } as unknown as McpServer;
  registerDesktopTools(server);
  for (const tool of ["desktop_ascii", "desktop_observe"]) {
    expect(schemas.get(tool).parse({}).diff).toBe(true);
    expect(schemas.get(tool).parse({ diff: false }).diff).toBe(false);
  }
});

it("keeps independent full baselines, serializes overlapping reads, and emits complete clickable tokens", () => {
  const script = `import sys,tempfile,threading,json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0,sys.argv[1])
from desktop_ascii_diff import capture_response
with tempfile.TemporaryDirectory() as cache:
 def read(grid, args=None, window="42", desktop="desk1", tool="desktop_ascii", wait=None):
  req=dict(tool=tool,cache=cache,args=args or {})
  def capture(_):
   if wait: wait()
   return dict(grid_text=grid,columns=16,capture="new",window=window)
  return capture_response(req,capture,lambda:desktop)
 assert read("   [+1] 😀")["diff"] is False
 delta=read("   [+2]",tool="desktop_observe")
 assert delta["changes"]==[dict(row=1,column=4,text="[+2]"),dict(row=1,column=9,clear=1)],delta
 assert delta["capture"]=="new" and "grid_text" not in delta
 assert read("   [+2]")["changed"] is False
 assert read("full",{"diff":False})["grid_text"]=="full"
 assert read("full")["changes"]==[]
 for args,win,desk in [({"region":{"x":1,"y":2,"width":10,"height":6}},"42","desk1"),
                       ({},"43","desk1"),({},"42","desk2"),({"simplified":False},"42","desk1")]:
  assert read("independent",args,win,desk)["diff"] is False
 assert "diff" not in read("image",{"mode":"image"},tool="desktop_observe")
 def fail(): raise ValueError()
 try: read("bad",wait=fail)
 except ValueError: pass
 assert read("full")["changed"] is False
 entered,release=threading.Event(),threading.Event()
 def pause(): entered.set(); assert release.wait(5)
 with ThreadPoolExecutor(2) as pool:
  first=pool.submit(read,"a",wait=pause)
  assert entered.wait(5)
  second=pool.submit(read,"ab")
  release.set()
  assert first.result()["changed"]
  assert second.result()["changes"]==[dict(row=1,column=2,text="b")]
 assert read("ab")["changed"] is False
 folder=Path(cache)/"new"
 folder.mkdir()
 (folder/"ascii.json").write_text(json.dumps(dict(hwnd=42,columns=16,simplified=True,grid=["after click   "])))
 read("partial",tool="desktop_click_excerpt")
 assert read("after click")["changed"] is False`;
  execFileSync(process.env["MIND_WAKE_DESKTOP_PYTHON"] ?? "python", ["-X", "utf8", "-c", script,
    path.join(import.meta.dirname, "../../services/mcp")], { timeout: 15_000 });
});
