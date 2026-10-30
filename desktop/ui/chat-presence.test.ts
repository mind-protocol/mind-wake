import { describe, expect, it } from "vitest";
import { agentIsWorking, automaticBumpKind, BUMP_TEXT, LEGACY_BUMP_TEXT, resolveBumpText } from "./chat-presence.js";
import type { StatusRead } from "./view.js";
const now = 20000;
function read(state: string, daemon = "running", mode = "native"): StatusRead {
  return { ok: true, fetchedAt: now, envelope: { schema: "mind-wake.cli", schemaVersion: 1, ok: true, data: { profile: {state}, daemon: {state:daemon, mode} } } };
}
describe("conversation presence", () => {
  it("shows only a live running or checkpointing native session", () => {
    expect(agentIsWorking(read("running"),now)).toBe(true);
    expect(agentIsWorking(read("checkpointing"),now)).toBe(true);
    for (const state of ["ready","hibernating","paused","blocked","disabled","stopped","error"]) expect(agentIsWorking(read(state),now)).toBe(false);
    for (const daemon of ["stopped","crashed","never"]) expect(agentIsWorking(read("running",daemon),now)).toBe(false);
    expect(agentIsWorking(read("running","running","simulated"),now)).toBe(false);
  });
  it("clears unavailable, failed and stale observations", () => {
    expect(agentIsWorking(null,now)).toBe(false);
    expect(agentIsWorking({ok:false,fetchedAt:now,error:"offline"},now)).toBe(false);
    expect(agentIsWorking(read("running"),now+10001)).toBe(false);
  });
});

it("Bump prioritizes an iterative agent pass while keeping the direct mode", () => {
  for (const requirement of ["priorité au travail avec des agents", "trois propositions", "artifacts/participation-discussion.json", "hypothèses de réponses", "recherche si elle est utile", "utilité pour la relation et les activités", "hypothèse sourcée et révisable du point de vue de NLR", "questions liées", "c’est toi, l’agent principal, qui fais le choix final", "recommander la meilleure", "N’attribue jamais à NLR une réponse simulée", "2. Si tu as déjà une idée pertinente en tête"]) expect(BUMP_TEXT).toContain(requirement);
});
it("hides presence on CLI-level errors even if an error includes stale profile data", () => {
  const observation = read("running") as Extract<StatusRead,{ok:true}>;
  expect(agentIsWorking({...observation,envelope:{...(observation.envelope as object),ok:false}},now)).toBe(false);
});

it("reads the current workspace prompt anew for each invitation", async () => {
  let text = "BUMP: première invitation";
  const read = async () => ({format:"markdown",text});
  expect(await resolveBumpText(read)).toBe(text);
  text = "BUMP: invitation modifiée";
  expect(await resolveBumpText(read)).toBe(text);
});

it("keeps a usable built-in invitation when the workspace file cannot be used", async () => {
  for (const value of [null,{}, {format:"html",text:"BUMP: autre format"}, {format:"markdown",text:""}, {format:"markdown",text:"autre document"}, {format:"markdown",text:"BUMP:"+"x".repeat(4000)}]) {
    expect(await resolveBumpText(async () => value)).toBe(BUMP_TEXT);
  }
  expect(await resolveBumpText(async () => {throw new Error("missing file");})).toBe(BUMP_TEXT);
});

it("compacts marked human invitations and the exact legacy invitation", () => {
  expect(automaticBumpKind({from:"human",id:"ui-bump-123",text:BUMP_TEXT})).toBe("bump");
  expect(automaticBumpKind({from:"human",id:"ui-bumpe-123",text:BUMP_TEXT})).toBe("bumpe");
  expect(automaticBumpKind({from:"human",id:"ui-15ba78f2-bcc8-4668-9454-83b3b1cb7748",text:LEGACY_BUMP_TEXT})).toBe("bump");
});

it("keeps agent contributions and ordinary human BUMP text visible", () => {
  expect(automaticBumpKind({from:"agent",id:"ui-bump-123",text:BUMP_TEXT})).toBe(null);
  expect(automaticBumpKind({from:"human",id:"ui-15ba78f2-bcc8-4668-9454-83b3b1cb7748",text:"BUMP: ma question"})).toBe(null);
  expect(automaticBumpKind({from:"human",id:"ui-15ba78f2-bcc8-4668-9454-83b3b1cb7748",text:BUMP_TEXT})).toBe(null);
  expect(automaticBumpKind({from:"human",text:LEGACY_BUMP_TEXT})).toBe(null);
});
