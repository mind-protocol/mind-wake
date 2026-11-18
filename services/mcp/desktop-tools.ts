import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

const point = {
  x: z.int().describe("Absolute physical screen X in pixels, including the monitor offset."),
  y: z.int().describe("Absolute physical screen Y in pixels, increasing downwards."),
};
const feedback = z.enum(["ascii", "image"]).describe("Format of the changed region returned after a click. Inherited by the next capture.");
const diff = z.boolean().default(true).describe("ASCII only. The first read of a target returns the full grid. Later reads return changed cells with 1-based row and column, text to replace, or clear (number of cells). changed=false means no change. Pass false for the full current grid.");
const window = z.string().trim().min(1).describe("Window ID from desktop_windows, or a unique title match.");
const view = {
  mode: z.enum(["ascii", "image", "ocr", "both"]).default("ascii").describe("Compact Unicode by default. Request image/both for visual evidence or OCR for word coordinates."),
  columns: z.int().min(16).max(800).default(160),
  simplified: z.boolean().default(true),
  grid: z.int().min(24).max(1000).optional().describe("Spacing in physical pixels between guide lines drawn on the JPEG."),
};
/** Optional Windows virtual desktop (Win+Tab), 1-based as in desktop_list. Omitted: this room's own desktop. */
const desktop = z.int().min(1).max(32).optional()
  .describe("Optional Windows virtual desktop number (Win+Tab order, 1-based) from desktop_list. Omitted: this room's own virtual desktop (default). 1 is normally the human's desktop. Another number targets that desktop, in the same Windows session, with the human's usual Chrome profile and signed-in accounts. A numeric window ID from desktop_list is found on its own desktop even without this parameter. Reads and captures never change the visible desktop (PrintWindow/UI Automation); only input (click, text, keys, scroll) briefly shows the target desktop, then returns to the previous one.");
const label = z.string().trim().min(1).max(300);
const auto_scroll = z.union([z.boolean(), label]).optional()
  .describe("Default off. True looks for new or renamed accessible content for up to 2 seconds. A string selects an exact accessible name, including existing content. Read status: revealed, visible, no_target, ambiguous, unavailable or window_changed.");
const clickOptions = {
  button: z.enum(["left", "middle", "right"]).default("left"),
  count: z.int().min(1).max(2).default(1),
};
const action = z.union([
  z.strictObject({ op: z.literal("click"), ...point, ...clickOptions, auto_scroll }),
  z.strictObject({ op: z.literal("click"), label, ...clickOptions, auto_scroll }),
  z.strictObject({ op: z.literal("move"), ...point }),
  z.strictObject({ op: z.literal("scroll"), ...point, ticks: z.int().min(-100).max(100).describe("Real mouse-wheel notches (120 units each, about 40-100 px): positive up, negative down. scroll[].moved reports the measured pixels. Use ticks or pixels per action.") }),
  z.strictObject({ op: z.literal("scroll"), ...point, pixels: z.int().describe("Vertical physical pixels, positive down, negative up") }),
  z.strictObject({ op: z.literal("text"), text: z.string().max(4000), auto_scroll }),
  z.strictObject({ op: z.literal("keys"), keys: z.array(z.string().min(1)).min(1).max(5).describe('Key names are case-insensitive; Control aliases ctrl. Example: ["ctrl", "a"] (also "Ctrl+A"). Unknown keys reject the batch before input.') }),
  z.strictObject({ op: z.literal("wait"), ms: z.int().min(0).max(3000) }),
]);
const definitions = {
  desktop_open_url: [
    "Open an HTTP(S) page in a new Chrome window. Default: this room's dedicated Chrome profile on the room's virtual desktop (no account signed in). With desktop=N: a new window of the human's usual Chrome profile (signed-in accounts) created on Windows virtual desktop N; the view switches there briefly, then returns. Never moves existing windows. Returns the room, desktop GUID and the new window; navigation requested does not prove the page loaded.",
    z.strictObject({ desktop, url: z.url().refine(value => { try { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password; } catch { return false; } }, "HTTP(S) URL without credentials required") }),
  ],
  desktop_scrollto: [
    'Scroll a window until OCR text or a copied Unicode pattern is visible, e.g. {"window":"Chrome","target":{"text":"Résultats"}}. Searches from the current view down by default; set direction to up to search above. For ASCII use the original columns and simplified settings. panel selects the scrolling pane by absolute screen point; panes without an accessible scroll container are scrolled with the real wheel, then PageDown/PageUp (method in the result). Leaves the window at the last inspected view. On a match, pass capture and one candidate (excerpt, row, column) to desktop_click_excerpt.',
    z.strictObject({ desktop,
      window, target: z.union([z.strictObject({ text: label }), z.strictObject({ ascii: z.string().min(1).max(10000) })]),
      panel: z.strictObject(point).optional(), direction: z.enum(["down","up"]).default("down"),
      max_steps: z.int().min(0).max(16).default(8),
      columns: z.int().min(16).max(800).default(160), simplified: z.boolean().default(true),
    }),
  ],
  desktop_ascii: [
    "Read the named window without changing focus (default: foreground). If the target desktop has no foreground window, returns the desktop_observe screen grid. Window captures include a capture ID for desktop_click_excerpt in this session.",
    z.strictObject({ desktop, window: window.optional(), columns: z.int().min(16).max(800).default(160).describe("Grid width in characters."), simplified: z.boolean().default(true).describe("Keep OCR text and long contours. False also renders textures and gradients."), feedback: feedback.default("ascii"), diff }),
  ],
  desktop_click_excerpt: [
    'Left-click a copied excerpt, e.g. {"capture":"<ID from desktop_ascii>","excerpt":"Create"}. Preserve spaces and line breaks. If clicked=false, inspect matches and select a candidate by its 1-based row and column or copy a different excerpt. After a click, use the new capture ID. changed=false means no visible difference. If clicked=true with observation_error, observe again before acting. If the target is stale, take a fresh capture.',
    z.strictObject({ desktop, capture: z.uuid(), excerpt: z.string().min(1).max(10000), row: z.int().positive().optional(), column: z.int().positive().optional(), feedback: feedback.optional(), auto_scroll }),
  ],
  desktop_taskbar: [
    "List Windows taskbar buttons and their physical screen centers. Use desktop_act with the returned window ID and coordinates to click a pinned app.",
    z.strictObject({ desktop }),
  ],
  desktop_windows: [
    "List visible windows, titles and foreground state on this room's virtual desktop, or on Windows virtual desktop N with desktop=N (see desktop_list).",
    z.strictObject({ desktop }),
  ],
  desktop_list: [
    "List Windows virtual desktops (Win+Tab order): number, name, GUID, whether it is the visible one, whether it is this room's desktop, and the visible windows open on each. Pass the number as desktop to the other desktop_* tools.",
    z.strictObject({}),
  ],
  desktop_tabs: [
    "List the native tabs of an existing Chrome or Edge window by title or window ID.",
    z.strictObject({ desktop, window }),
  ],
  desktop_open: [
    "Activate an existing window and optionally a tab by title or ID. Ambiguous titles return candidates.",
    z.strictObject({ desktop, window, tab: z.string().trim().min(1).optional().describe("Tab ID from desktop_tabs, or a unique tab title match.") }),
  ],
  desktop_observe: [
    "Read the desktop, a window or region as compact Unicode by default. Request mode image or both for visual evidence, or ocr for word coordinates. A whole named window in ASCII mode returns a capture ID usable with desktop_click_excerpt; regions and screen grids are read-only. Coordinates are absolute physical screen pixels.",
    z.strictObject({ desktop, diff,
      window: window.optional(),
      region: z
        .strictObject({ ...point, width: z.int().positive(), height: z.int().positive() })
        .optional(),
      ...view,
    }),
  ],
  desktop_sweep: [
    "Capture each requested window (default: all) without changing the foreground window. Choose OCR for a text-only inventory.",
    z.strictObject({ desktop, windows: z.array(window).min(1).optional(), ...view }),
  ],
  desktop_click: [
    'Click visible targets in order, e.g. {"window":"Chrome","targets":["Settings",{"x":640,"y":420}]}. Each label is matched by OCR on the current screen, case-insensitively on one line. auto_scroll applies after each click. On failure, check the completed count before resuming. For a changed-region response use desktop_click_excerpt.',
    z.strictObject({ desktop, window, targets: z.array(z.union([label, z.strictObject(point)])).min(1).max(32), auto_scroll }),
  ],
  desktop_act: [
    'Perform actions in order in the target window. Focus an input before sending text. To scroll 400 pixels down in the panel under the pointer: {"window":"Chrome","actions":[{"op":"scroll","x":640,"y":420,"pixels":400}]}. Read scroll[].moved for the measured displacement (positive = content moved up) and scroll[].method. Pixels use the accessible scroll container when there is one, otherwise calibrated real wheel events, then PageDown/PageUp; ticks send real wheel notches. Set auto_scroll on individual click or text actions. On failure check the completed count before resuming. Use only within the owner\'s delegated task.',
    z.strictObject({ desktop, window, actions: z.array(action).min(1).max(32) }),
  ],
  desktop_page: [
    "Capture the current browser page from its top as overlapping viewport slices, stopping at a repeated viewport or the limit. Leaves the browser at the final slice. Returns the first slice in the selected mode and a session capture ID. page_y gives the document offset when available, otherwise slice coordinates are local; observe the current window before clicking.",
    z.strictObject({ desktop, window, max_slices: z.int().min(1).max(32).default(12), ...view,
      text: z.boolean().default(false).describe("Return the whole page as plain text in one call. First reads the web document through UI Automation TextPattern (no focus, no scrolling); if the browser does not expose it, scrolls through the page and stitches the OCR text of every slice (source tells which)."),
    }),
  ],
  desktop_slice: [
    "Read a saved viewport by capture ID and 1-based slice number without scrolling again.",
    z.strictObject({ capture: z.uuid(), slice: z.int().min(1).max(32), ...view }),
  ],
} as const;
export const DESKTOP_TOOLS = Object.keys(definitions);
type Block =
  { type: "text"; text: string } | { type: "image"; mimeType: "image/jpeg"; data: string };

export function registerDesktopTools(server: McpServer, python = "python", agentName?: string, room = "1", dataDir?: string) {
  const owner = { id: randomUUID(), name: agentName?.trim() || "un autre agent Wake" };
  let cache: string | undefined;
  for (const [name, [description, inputSchema]] of Object.entries(definitions)) {
    const readOnly = new Set(["desktop_list", "desktop_windows", "desktop_taskbar", "desktop_tabs", "desktop_observe", "desktop_sweep", "desktop_ascii", "desktop_slice"]);
    const annotations = readOnly.has(name) ? { readOnlyHint: true, openWorldHint: false } : undefined;
    server.registerTool(name, { description, inputSchema, ...(annotations ? { annotations } : {}) }, async (args: unknown) => {
      try {
        if (process.platform !== "win32") throw Error("Le contrôle desktop nécessite Windows.");
        if ((name === "desktop_page" || name === "desktop_ascii" || name === "desktop_observe" || name === "desktop_scrollto") && !cache) {
          cache = mkdtempSync(path.join(tmpdir(), "mind-wake-desktop-"));
          process.once("exit", () => {
            if (cache) rmSync(cache, { recursive: true, force: true });
          });
        }
        if ((name === "desktop_slice" || name === "desktop_click_excerpt") && !cache)
          throw Error("Capture absente de cette session MCP.");
        const output = await new Promise<string>((resolve, reject) => {
          const child = execFile(
            python,
            [path.join(import.meta.dirname, "desktop-control.py")],
            {
              windowsHide: true,
              timeout: 120000,
              maxBuffer: 48 * 1024 * 1024,
              encoding: "utf8",
              env: { ...process.env, PYTHONIOENCODING: "utf-8" },
            },
            (err, stdout, stderr) =>
              err ? reject(Error(stderr.trim() || err.message)) : resolve(stdout),
          );
          child.stdin?.on("error", reject);
          const { desktop: target, ...toolArgs } = args as { desktop?: number } & Record<string, unknown>;
          child.stdin?.end(JSON.stringify({ tool: name, args: toolArgs, owner, room, visionClient: server.server?.getClientVersion()?.name, ...(target === undefined ? {} : { desktop: target }), browserRoot: path.join(dataDir ?? tmpdir(), "desktop-browsers"), cache: cache ?? "" }));
        });
        const parsed: unknown = JSON.parse(output);
        const content: Block[] = [];
        for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
          const { jpeg, grid_text, ...info } = entry;
          content.push({ type: "text", text: JSON.stringify(info) });
          if (grid_text) content.push({ type: "text", text: grid_text });
          if (jpeg) content.push({ type: "image", mimeType: "image/jpeg", data: jpeg });
        }
        if (!content.length) content.push({ type: "text", text: "[]" });
        return { content };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
          ],
        };
      }
    });
  }
}
