import { expect, it } from "vitest";
import {
  forkStatus,
  forkConversationEntries,
  forkIsWorking,
  ForkReadState,
  type ForkView,
  type ForksView,
} from "./forks.js";
it("distinguishes enabled, working, paused, stopped, unavailable and provider-limited forks", () => {
  const fork: ForkView = {
    id: 2,
    enabled: true,
    threadId: null,
    projects: ["projet"],
    entries: [],
    lastTurn: null,
  };
  const view: ForksView = { running: true, profile: "run", forks: [fork] };
  expect(forkStatus(fork, view)).toBe("On");
  expect(forkStatus({ ...fork, enabled: false }, view)).toContain("Off");
  expect(forkStatus(fork, { ...view, profile: "hold" })).toContain("pause");
  expect(forkStatus(fork, { ...view, profile: "stop" })).toContain("profil");
  expect(forkStatus(fork, { ...view, running: false })).toContain("Démarrage");
  expect(forkStatus({ ...fork, projects: [] }, view)).toContain("disponible");
  expect(
    forkStatus({ ...fork, lastTurn: { projectId: "projet", endedAt: null, outcome: null } }, view),
  ).toContain("Travaille");
  expect(
    forkStatus(
      { ...fork, lastTurn: { projectId: "projet", endedAt: "date", outcome: "rate_limited" } },
      view,
    ),
  ).toContain("fournisseur");
});

it("shows work only for the fork with an active assigned turn", () => {
  const active: ForkView = {
    id: 2,
    enabled: true,
    threadId: "thread",
    projects: ["a"],
    entries: [],
    lastTurn: { projectId: "a", endedAt: null, outcome: null },
  };
  const view: ForksView = { running: true, profile: "run", forks: [active] };
  expect(forkIsWorking(active, view, 100)).toBe(true);
  for (const model of [
    { ...view, running: false },
    { ...view, profile: "hold" },
    { ...view, profile: "stop" },
    { ...view, retryAtMs: 200 },
  ])
    expect(forkIsWorking(active, model, 100)).toBe(false);
  for (const fork of [
    { ...active, enabled: false },
    { ...active, projects: ["b"] },
    { ...active, lastTurn: null },
    { ...active, lastTurn: { projectId: "a", endedAt: "finished", outcome: "completed" } },
  ])
    expect(forkIsWorking(fork, view, 100)).toBe(false);
});

it("keeps unread messages separate, ignores human/events and restores read cursors", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const read = new ForkReadState(storage);
  const second: ForkView = {
    id: 2,
    enabled: true,
    projects: [],
    threadId: null,
    lastTurn: null,
    entries: [
      { id: 1, role: "agent", text: "Résultat", at: "date", delivered: true },
      { id: 2, role: "human", text: "Merci", at: "date", delivered: false },
      { id: 3, role: "event", text: "Arrêt", at: "date", delivered: true },
    ],
  };
  const third = { ...second, id: 3 };
  expect(read.unread(second)).toBe(1);
  expect(read.unread(third)).toBe(1);
  read.markRead(second);
  expect(read.unread(second)).toBe(0);
  expect(read.unread(third)).toBe(1);
  const restored = new ForkReadState(storage);
  expect(restored.unread(second)).toBe(0);
  expect(restored.unread(third)).toBe(1);
  expect(
    restored.unread({
      ...second,
      entries: [
        ...second.entries,
        { id: 4, role: "agent", text: "Suite", at: "date", delivered: true },
      ],
    }),
  ).toBe(1);
});

it("retains unread tracking in memory when local storage is blocked", () => {
  const read = new ForkReadState({
    getItem: () => {
      throw Error("blocked");
    },
    setItem: () => {
      throw Error("blocked");
    },
  });
  const fork: ForkView = {
    id: 2,
    enabled: false,
    projects: [],
    threadId: null,
    lastTurn: null,
    entries: [{ id: 5, role: "agent", text: "Résultat", at: "date", delivered: true }],
  };
  expect(read.unread(fork)).toBe(1);
  read.markRead(fork);
  expect(read.unread(fork)).toBe(0);
});

it("merges live activity in time order without duplicate finals or unread activity badges", () => {
  const fork: ForkView = {id:2, enabled:true, projects:["a"], threadId:"fork", lastTurn:null,
    entries:[{id:1,at:"2026-11-03T12:02:00Z",role:"agent",text:"Fini",delivered:true}],
    activity:[{id:"a",at:"2026-11-03T12:01:00Z",text:"Utilise l’outil exec."},
      {id:"b",at:"2026-11-03T12:02:00Z",text:"Fini",kind:"final"},
      {id:"c",at:"2026-11-03T12:03:00Z",text:"Résultat enfant",kind:"final",source:"review",threadId:"child"}]};
  const entries=forkConversationEntries(fork);
  expect(entries.map(e=>e.text)).toEqual(["Utilise l’outil exec.","Fini","Résultat enfant"]);
  expect(entries[2]).toMatchObject({activity:true,source:"review"});
  const read=new ForkReadState({getItem:()=>null,setItem:()=>{}});
  expect(read.unread(fork)).toBe(1);
  read.markRead(fork);
  expect(read.unread(fork)).toBe(0);
});
