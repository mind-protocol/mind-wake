import { describe, expect, it } from "vitest";
import { interfilStream } from "./fork-interfil.js";

const context = { threadId: "thread", turnId: "turn" };
const item = { id: "item", type: "agentMessage", phase: "final_answer" };

describe("inter-fork stream", () => {
  it("previews split markers and routes a completed item once", () => {
    const previews: string[] = [];
    const stream = interfilStream(2, "thread", to => to === 8, draft => {
      if (draft) previews.push(draft.text);
    });
    stream.event("item/started", { ...context, item });
    for (const delta of ["[agent:fo", "rk8]Bon", "jour[/ag", "ent]"])
      stream.event("item/agentMessage/delta", { ...context, itemId: "item", delta });
    expect(previews).toEqual(["Bon", "Bonjour", "Bonjour"]);
    expect(stream.final()).toBeUndefined();
    stream.event("item/completed", { ...context, item: { ...item, text: "[agent:fork8]Bonjour[/agent]" } });
    expect(stream.final()).toMatchObject({ from: 2, to: 8, text: "Bonjour" });
  });

  it("ignores private phases and checks authorization again before delivery", () => {
    let allowed = true;
    const stream = interfilStream(2, "thread", () => allowed, () => {});
    const text = "[agent:fork8]Bonjour[/agent]";
    stream.event("item/started", { ...context, item: { ...item, phase: "commentary" } });
    stream.event("item/completed", { ...context, item: { ...item, text } });
    expect(stream.final()).toBeUndefined();
    stream.event("item/started", { ...context, item });
    stream.event("item/completed", { ...context, item: { ...item, text } });
    allowed = false;
    expect(stream.final()).toBeUndefined();
  });
});
