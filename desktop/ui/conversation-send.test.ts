import { expect, it } from "vitest";
import { requestConversationReply } from "./conversation-send.js";

it("requests a reply after persistence", async () => {
  const calls: string[] = [];
  const message = await requestConversationReply(async command => { calls.push(command); return {ok: true}; });
  expect(calls).toEqual(["wake_now"]);
  expect(message).toContain("réponse demandée");
});

it("reports an emergency stop without undoing the saved receipt or trying to reactivate", async () => {
  const calls: string[] = [];
  const message = await requestConversationReply(async command => {
    calls.push(command);
    return {ok: false, data: {detail: "profil stopped : arrêt demandé"}};
  });
  expect(calls).toEqual(["wake_now"]);
  expect(message).toContain("Message enregistré");
  expect(message).toContain("arrêt demandé");
});

it("keeps the saved receipt when the wake request fails", async () => {
  const message = await requestConversationReply(async () => { throw new Error("daemon indisponible"); });
  expect(message).toContain("Message enregistré");
  expect(message).toContain("daemon indisponible");
});
