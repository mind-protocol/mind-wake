import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { it, expect } from "vitest";
import { editPrompts } from "../services/prompt-editor/editor.js";
import {
  patternHoldersDir,
  loadPatternHolders,
  patternHolderSystemPrompt,
  routerSystemPrompt,
} from "../src/communication/pattern-holders.js";

it("edits the sources used at wake, isolates the router and detects concurrent changes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-prompt-editor-"));
  try {
    const root = patternHoldersDir(dir);
    fs.mkdirSync(root, { recursive: true });
    for (const id of ["crypto", "vox", "reveilleur"])
      fs.writeFileSync(
        path.join(root, id + ".md"),
        '```json pattern-holder\n{"name":"' + id + '"}\n```\nMémoire ' + id,
      );
    const read = (agent: string, part: string) => editPrompts(dir, { action: "read", agent, part });
    const role = read("crypto", "role");
    const change = {
      action: "save",
      agent: "crypto",
      part: "role",
      revision: role.revision!,
      text: "Nouveau rôle partagé.",
    } as const;
    editPrompts(dir, change);
    expect(() => editPrompts(dir, change)).toThrow("changé");
    for (const h of loadPatternHolders(dir).holders) {
      const preview = read(h.slug, "preview").text;
      if (h.slug === "reveilleur") {
        expect(preview).toBe(routerSystemPrompt(root, h));
        expect(preview).not.toContain(change.text);
      } else {
        expect(preview).toBe(patternHolderSystemPrompt(h));
        expect(preview).toContain(change.text);
      }
    }
    const memory = read("crypto", "file:crypto.md");
    expect(() =>
      editPrompts(dir, {
        ...change,
        part: "file:crypto.md",
        revision: memory.revision!,
        text: "invalide",
      }),
    ).toThrow("absent");
    editPrompts(dir, {
      ...change,
      part: "file:crypto.md",
      revision: memory.revision!,
      text: memory.text + "\nSuite.",
    });
    expect(read("crypto", "preview").text).toContain("Suite.");
    expect(read("vox", "preview").text).not.toContain("Suite.");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
import { fastReplySystemPrompt } from "../src/communication/fast-reply.js";
import { defaultForkPrompt } from "../src/daemon/forks.js";
import { workspaceDirFor } from "../src/daemon/paths.js";

it("applies independent edits to a fork and the quick reply at their normal entry points", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-runtime-prompts-"));
  try {
    const workspace = workspaceDirFor(dir);
    for (const agent of ["fast-reply", "fork-3"]) {
      const r = editPrompts(dir, { action: "read", agent: "wake:" + agent, part: "role" });
      editPrompts(dir, {
        action: "save",
        agent: "wake:" + agent,
        part: "role",
        revision: r.revision!,
        text: "Edit " + agent,
      });
    }
    expect(fastReplySystemPrompt(workspace)).toContain("Edit fast-reply");
    expect(defaultForkPrompt(workspace, 3)).toContain("Edit fork-3");
    expect(defaultForkPrompt(workspace, 2)).not.toContain("Edit fork-3");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("saves an edit made directly in the complete Crypto prompt", async () => {
  const { mountPromptEditor } = await import("../desktop/ui/prompt-editor.js");
  const { vi } = await import("vitest");
  class Element {
    value = "";
    disabled = false;
    readOnly = false;
    children: Element[] = [];
    onclick?: () => void;
    oninput?: () => void;
    append(child: Element) {
      this.children.push(child);
    }
    replaceChildren(...children: Element[]) {
      this.children = children;
    }
  }
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-edit-view-"));
  try {
    const root = patternHoldersDir(dir);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, "crypto.md"),
      '```json pattern-holder\n{"name":"Crypto"}\n```\nSouvenir',
    );
    vi.stubGlobal("document", {
      querySelector: (s: string) => get(s.slice(1)),
      getElementById: get,
      createElement: () => new Element(),
    });
    vi.stubGlobal("window", { addEventListener() {} });
    vi.stubGlobal("Option", Element);
    mountPromptEditor(async (req) =>
      editPrompts(dir, req as Parameters<typeof editPrompts>[1]),
    ).open();
    await vi.waitFor(() => expect(get("prompt-reload").disabled).toBe(false));
    const input = get("prompt-fields")
      .children.flatMap((label) => label.children)
      .find((field) => field.value.includes("Souvenir"))!;
    expect(input.readOnly || input.disabled).toBe(false);
    input.value += "\nSuite du souvenir";
    input.oninput!();
    expect(get("prompt-save").disabled).toBe(false);
    get("prompt-save").onclick!();
    await vi.waitFor(() => expect(get("prompt-reload").disabled).toBe(false));
    expect(patternHolderSystemPrompt(loadPatternHolders(dir).holders[0]!)).toContain(
      "Suite du souvenir",
    );
  } finally {
    vi.unstubAllGlobals();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
