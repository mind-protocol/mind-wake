import { afterEach, expect, it, vi } from "vitest";
import { mountFastReply } from "./fast-reply.js";

afterEach(() => { vi.unstubAllGlobals(); });

function setup(enabled: boolean) {
  const elements = new Map<string, any>();
  const get = (id: string) => elements.get(id) ?? elements.set(id, {checked:false,hidden:true,disabled:false,textContent:"",handler:undefined,addEventListener(_name:string,handler:()=>void){this.handler=handler;}}).get(id);
  vi.stubGlobal("document", {getElementById:get});
  const invoke = vi.fn(async (command:string,args?:Record<string,unknown>) => {
    const value = command === "fast_reply_status" ? enabled : (args?.enabled as boolean);
    return {exitCode:0,stdout:JSON.stringify({ok:true,data:{enabled:value}})};
  });
  mountFastReply(invoke);
  return {get,invoke};
}

it("reads status and visibly marks the feature as off", async () => {
  const ui=setup(false);
  await vi.waitFor(()=>expect(ui.get("fast-reply-state").textContent).toBe("Coupée"));
  expect(ui.get("fast-reply-indicator").hidden).toBe(false);
  expect(ui.get("fast-reply-indicator").textContent).toContain("⚡ coupée");
});

it("persists the selected on/off state through the dedicated Tauri commands", async () => {
  const ui=setup(false);
  await vi.waitFor(()=>expect(ui.get("fast-reply-state").textContent).toBe("Coupée"));
  ui.get("fast-reply-enabled").checked=true;
  await ui.get("fast-reply-enabled").handler();
  expect(ui.invoke).toHaveBeenLastCalledWith("fast_reply_set",{enabled:true});
  expect(ui.get("fast-reply-indicator").hidden).toBe(true);
});
