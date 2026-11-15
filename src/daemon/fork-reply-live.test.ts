import { describe, expect, it } from "vitest";
import { replyDraft, unwrapUserReply } from "./fork-reply-live.js";

const address = { threadId: "owned", turnId: "turn" };
const itemId = "message";
const started = (phase: string) => ({
  ...address,
  item: { type: "agentMessage", id: itemId, phase },
});
const delta = (value: string) => ({ ...address, itemId, delta: value });

describe("fork live user reply", () => {
  it("streams text from matching final-answer deltas and hides split markers", () => {
    const shown: string[] = [];
    const observe = replyDraft(address.threadId, (text) => shown.push(text));
    observe("item/started", started("final_answer"));
    observe("item/agentMessage/delta", delta(" [us"));
    observe("item/agentMessage/delta", delta("er]Ville"));
    observe("item/agentMessage/delta", delta(" fondée. [/u"));
    observe("item/agentMessage/delta", delta("ser]Texte hors overlay."));
    observe("item/agentMessage/delta", delta("Autre texte."));
    expect(shown).toEqual(["Ville", "Ville fondée.", "Ville fondée."]);
    expect(unwrapUserReply("[user]Ville fondée.[/user] Détail.")).toBe("Ville fondée.\n\nDétail.");
  });

  it("ignores unscoped, private, tool and unmarked text and never replays a completed item", () => {
    const shown: string[] = [];
    const observe = replyDraft(address.threadId, (text) => shown.push(text));
    observe("item/agentMessage/delta", delta("[user]Missing start"));
    observe("item/started", started("commentary"));
    observe("item/agentMessage/delta", delta("[user]Commentary"));
    observe("item/started", started("final_answer"));
    observe("item/agentMessage/delta", { ...delta("[user]Foreign"), threadId: "other" });
    observe("item/agentMessage/delta", { ...delta("[user]Foreign"), turnId: "other" });
    observe("item/agentMessage/delta", { ...delta("[user]Foreign"), itemId: "other" });
    observe("item/reasoning/textDelta", delta("[user]Reasoning"));
    observe("item/commandExecution/outputDelta", delta("[user]Command"));
    observe("item/agentMessage/delta", delta("Ordinary final reply"));
    observe("item/completed", {
      ...address,
      item: { ...started("final_answer").item, text: "[user]Final" },
    });
    expect(shown).toEqual([]);
    expect(unwrapUserReply("Ordinary final reply")).toBe("Ordinary final reply");
  });
});
