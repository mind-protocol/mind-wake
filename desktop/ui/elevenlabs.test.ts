import { afterEach, expect, it, vi } from "vitest";
import { initElevenLabs } from "./elevenlabs.js";

afterEach(() => vi.unstubAllGlobals());

function desktop(blockAutoplay = false) {
  class Element {
    value = "";
    checked = false;
    hidden = true;
    disabled = false;
    textContent = "";
    src = "";
    ended = false;
    listeners = new Map<string, () => void>();
    addEventListener(name: string, handler: () => void) {
      this.listeners.set(name, handler);
    }
    querySelectorAll() {
      return [];
    }
    replaceChildren() {}
    removeAttribute() {
      this.src = "";
    }
    pause = vi.fn();
    load = vi.fn();
    play = vi.fn(() => {
      if (blockAutoplay) return Promise.reject(Error("NotAllowedError"));
      this.ended = false;
      this.listeners.get("play")?.();
      this.listeners.get("playing")?.();
      return Promise.resolve();
    });
  }
  const nodes = new Map<string, Element>();
  const get = (id: string) => {
    const existing = nodes.get(id);
    if (existing) return existing;
    const element = new Element();
    nodes.set(id, element);
    return element;
  };
  let interval: (() => Promise<void>) | undefined;
  let allowed = true;
  let holdAudio = false;
  let resumeAudio: (() => void) | undefined;
  let pending = [{ id: "clip-1", text: "Bonjour", voiceId: "fr", autoplay: true }];
  vi.stubGlobal("document", { getElementById: (id: string) => get(id.replace("elevenlabs-", "")) });
  vi.stubGlobal("window", {
    setInterval: (fn: () => Promise<void>) => {
      interval = fn;
    },
  });
  vi.stubGlobal(
    "Option",
    class {
      constructor(
        public text: string,
        public value: string,
      ) {}
    },
  );
  const revoked = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: () => "blob:audio", revokeObjectURL: revoked });
  const invoke = vi.fn((_command: string, args?: Record<string, unknown>) => {
    let data: unknown;
    switch (args?.["action"]) {
      case "status":
        data = { enabled: true, autoplay: true, voiceId: "fr", hasKey: true };
        break;
      case "pending":
        data = { allowed, clips: pending };
        break;
      case "audio":
        data = { base64: "SUQzAA==" };
        if (holdAudio) {
          holdAudio = false;
          return new Promise<{ exitCode: number; stdout: string }>((resolve) => {
            resumeAudio = () => {
              resolve({ exitCode: 0, stdout: JSON.stringify({ ok: true, data }) });
            };
          });
        }
        break;
      case "ack":
        pending = pending.filter((item) => item.id !== args["payload"]);
        data = {};
        break;
      default:
        throw Error("Unexpected call");
    }
    return Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ ok: true, data }) });
  });
  initElevenLabs(invoke);
  return {
    get,
    invoke,
    revoked,
    holdNextAudio: () => {
      holdAudio = true;
    },
    releaseAudio: () => {
      resumeAudio?.();
    },
    tick: async () => {
      void interval?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    stop: () => {
      allowed = false;
    },
    add: () => {
      pending.push({ id: "clip-2", text: "Salut", voiceId: "fr", autoplay: true });
    },
  };
}

it("keeps a clip available when autoplay is blocked, acknowledges only actual playback", async () => {
  const ui = desktop(true);
  await vi.waitFor(() => {
    expect(ui.get("audio").play).toHaveBeenCalledOnce();
  });
  expect(ui.get("player").hidden).toBe(false);
  expect(ui.get("playing").textContent).toContain("Appuyer sur lecture");
  expect(ui.invoke.mock.calls.some((call) => call[1]?.["action"] === "ack")).toBe(false);
  ui.get("audio").listeners.get("playing")?.();
  await vi.waitFor(() => {
    expect(ui.invoke.mock.calls.some((call) => call[1]?.["action"] === "ack")).toBe(true);
  });
});

it("plays clips sequentially, leaves replay available, and stops on Pause/Force-off", async () => {
  const ui = desktop();
  await vi.waitFor(() => {
    expect(ui.get("audio").play).toHaveBeenCalledOnce();
  });
  ui.add();
  await ui.tick();
  expect(ui.get("audio").play).toHaveBeenCalledOnce();
  ui.get("audio").ended = true;
  await ui.tick();
  await vi.waitFor(() => {
    expect(ui.get("playing").textContent).toBe("Salut");
  });
  expect(ui.get("player").hidden).toBe(false);
  ui.stop();
  await ui.tick();
  await vi.waitFor(() => {
    expect(ui.get("player").hidden).toBe(true);
  });
  expect(ui.get("audio").pause).toHaveBeenCalled();
  expect(ui.revoked).toHaveBeenCalled();
});

it("waits through a manual pause and starts the queued voice only after the ended event", async () => {
  const ui = desktop();
  await vi.waitFor(() => {
    expect(ui.get("audio").play).toHaveBeenCalledOnce();
  });
  ui.add();
  ui.get("audio").pause();
  await ui.tick();
  await ui.tick();
  expect(ui.get("audio").play).toHaveBeenCalledOnce();
  expect(ui.get("playing").textContent).toBe("Bonjour");
  ui.get("audio").ended = true;
  ui.get("audio").listeners.get("ended")?.();
  await vi.waitFor(() => {
    expect(ui.get("playing").textContent).toBe("Salut");
  });
  expect(ui.get("audio").play).toHaveBeenCalledTimes(2);
});

it("serializes simultaneous polls and lets a replay finish when the next voice is loading", async () => {
  const ui = desktop();
  await vi.waitFor(() => {
    expect(ui.get("audio").play).toHaveBeenCalledOnce();
  });
  ui.add();
  ui.holdNextAudio();
  ui.get("audio").ended = true;
  await Promise.all([ui.tick(), ui.tick(), ui.tick()]);
  expect(ui.invoke.mock.calls.filter((call) => call[1]?.["action"] === "audio")).toHaveLength(2);
  await ui.get("audio").play(); // Replay the first clip during the pending read.
  const pauses = ui.get("audio").pause.mock.calls.length;
  ui.releaseAudio();
  await ui.tick();
  expect(ui.get("playing").textContent).toBe("Bonjour");
  expect(ui.get("audio").pause).toHaveBeenCalledTimes(pauses);
  ui.get("audio").ended = true;
  ui.get("audio").listeners.get("ended")?.();
  await vi.waitFor(() => {
    expect(ui.get("playing").textContent).toBe("Salut");
  });
  expect(ui.get("audio").play).toHaveBeenCalledTimes(3);
});
