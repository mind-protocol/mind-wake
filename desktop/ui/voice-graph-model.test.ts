import { describe, it, expect } from "vitest";
import {
  visibleMessages,
  selectedMessage,
  type VoiceGraph,
  type GraphMessage,
} from "./voice-graph-model.js";
const message: GraphMessage = {
  id: "m1",
  from: "fork2",
  to: "principal",
  kind: "pair",
  state: "queued",
  at: null,
  text: "synthétique",
  source: "fixture",
  correlationId: "c1",
  threadId: null,
  retry: null,
  history: [],
  detail: "",
};
const graph: VoiceGraph = {
  version: 1,
  observedAt: "2026-11-05T11:00:00Z",
  tabs: [],
  sources: [],
  limits: [],
  nodes: [
    {
      id: "fork2",
      label: "Fork2",
      kind: "session",
      tab: "fork2",
      activity: "inconnu",
      at: null,
      detail: "",
    },
    {
      id: "principal",
      label: "Principal",
      kind: "session",
      tab: "principal",
      activity: "inconnu",
      at: null,
      detail: "",
    },
  ],
  messages: [message],
};
describe("Voice graph selection", () => {
  it("shows a cross-fork edge in both endpoint tabs, never another tab", () => {
    for (const tab of ["all", "principal", "fork2"])
      expect(
        visibleMessages(graph, { tab, selected: null, query: "" }),
      ).toEqual([message]);
    expect(
      visibleMessages(graph, { tab: "fork8", selected: null, query: "" }),
    ).toEqual([]);
  });
  it("keeps selection while filtered, updated or outside the source window", () => {
    const selection = { tab: "fork8", selected: "m1", query: "absent" };
    expect(visibleMessages(graph, selection)).toEqual([]);
    expect(selectedMessage(graph, selection)).toEqual(message);
    expect(
      selectedMessage(
        { ...graph, messages: [{ ...message, state: "reçu" }] },
        selection,
      )?.state,
    ).toBe("reçu");
    expect(
      selectedMessage({ ...graph, messages: [] }, selection),
    ).toBeUndefined();
    expect(selection.selected).toBe("m1");
  });
  it("searches correlation and unknown states without treating them as success", () => {
    expect(
      visibleMessages(graph, { tab: "all", selected: null, query: "c1" }),
    ).toEqual([message]);
    expect(
      visibleMessages(graph, { tab: "all", selected: null, query: "played" }),
    ).toEqual([]);
  });
});
