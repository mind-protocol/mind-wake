/** Réveil du coach d'une personne par son @handle : appels Claude simulés, aucun appel fournisseur. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { callClaude as CallClaude } from "../src/communication/fast-reply.js";
import { OwnerMessages, readOwnerMessages } from "../src/communication/owner-messages.js";
import { extractHandles } from "../src/communication/coach-handles.js";
import { tickPatternHolders } from "../src/communication/pattern-holders.js";

let dataDir: string;
let clock: number;
const claude = { executable: "unused", model: "sonnet" };
const now = () => clock;
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const holdersDir = () => path.join(dataDir, "workspace", "artifacts", "pattern-holders");
const registryFile = () => path.join(holdersDir(), "COACHS-REGISTRE.json");

const holderSection = (name: string) =>
  `# ${name}\n\n\`\`\`json pattern-holder\n{ "name": "${name}", "emoji": "🧭" }\n\`\`\`\n`;

const REGISTRY = {
  version: 1,
  coachs: {
    "coach-colony": { nom: "Coach Colony", dossier: "artifacts/pattern-holders/coach-colony/" },
    "coach-telegram": {
      nom: "Coach Telegram",
      prive: true,
      dossier: "artifacts/pattern-holders/coach-telegram/",
    },
  },
  personnes: [
    {
      id: "spark-the-cat",
      coach: "coach-colony",
      handles: [{ plateforme: "colony", handle: "Spark-The-Cat" }],
      fiche: "artifacts/pattern-holders/coach-colony/spark-the-cat.md",
    },
    {
      id: "marie",
      coach: "coach-telegram",
      handles: [{ plateforme: "telegram", handle: "marie_t" }],
      fiche: "artifacts/pattern-holders/coach-telegram/marie.md",
    },
  ],
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "handle-wake-"));
  for (const slug of ["coach-colony", "coach-telegram"]) {
    const dir = path.join(holdersDir(), slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "_holder.md"), holderSection(slug));
  }
  fs.writeFileSync(registryFile(), JSON.stringify(REGISTRY));
  clock = Date.parse("2026-11-16T10:00:00.000Z");
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function human(id: string, text: string, at: string) {
  fs.appendFileSync(path.join(dataDir, "human-messages.jsonl"), `${JSON.stringify({ id, at, text })}\n`);
}
function agent(text: string, key: string, at: string) {
  const messages = new OwnerMessages(dataDir, "claude-wake");
  try {
    messages.publish(text, key, at);
  } finally {
    messages.close();
  }
}
/** Répond au réveilleur par une sélection vide, et sinon par `text`. */
const replying =
  (text: string, seen: { holder: string; prompt: string }[] = []): typeof CallClaude =>
  (_claude, _args, prompt, cwd) => {
    if (prompt.includes('"candidats"')) return Promise.resolve({ text: "[]" });
    seen.push({ holder: path.basename(cwd), prompt });
    return Promise.resolve({ text });
  };

/** Premier passage (curseur au présent), puis les messages et un second passage. */
async function run(post: () => void, call: typeof CallClaude, logs: string[] = []) {
  await tickPatternHolders({ dataDir, claude, call, now });
  post();
  return tickPatternHolders({ dataDir, claude, call, now, log: (l) => logs.push(l) });
}

it("wakes the right coach when a registered handle appears", async () => {
  const seen: { holder: string; prompt: string }[] = [];
  const outcomes = await run(
    () => { human("m1", "On en parle avec @spark-the-cat demain ?", iso(-30_000)); },
    replying("Je propose un mot court.", seen),
  );
  expect(outcomes).toEqual([
    expect.objectContaining({ slug: "coach-colony", state: "spoke", reason: "handle" }),
  ]);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.holder).toBe("coach-colony");
  expect(seen[0]?.prompt).toContain("@spark-the-cat est mentionné ici.");
  expect(seen[0]?.prompt).toContain("Tu es son coach dans le mesh.");
  expect(seen[0]?.prompt).toContain("tu n'as aucun mandat sur lui");
  expect(seen[0]?.prompt).toContain("artifacts/pattern-holders/coach-colony/spark-the-cat.md");
  expect(seen[0]?.prompt).not.toContain("coach privé");
  expect(readOwnerMessages(dataDir)?.at(-1)?.text).toBe("🧭 coach-colony · Je propose un mot court.");
});

it("matches the handle whatever its case", async () => {
  const outcomes = await run(
    () => { human("m1", "Salut @SPARK-the-Cat !", iso(-30_000)); },
    replying("ok"),
  );
  expect(outcomes.map((o) => [o.slug, o.reason])).toEqual([["coach-colony", "handle"]]);
});

it("does nothing for an unknown handle, an e-mail address or a known holder slug", async () => {
  const seen: { holder: string; prompt: string }[] = [];
  const outcomes = await run(
    () => { human("m1", "@inconnu écris à spark-the-cat@example.org", iso(-30_000)); },
    replying("x", seen),
  );
  expect(outcomes.filter((o) => o.reason === "handle")).toEqual([]);
  expect(seen.filter((s) => s.prompt.includes("est mentionné ici"))).toEqual([]);
  expect(extractHandles("a@b.fr @Foo, @bar-baz. (@x_y) /@no")).toEqual(["foo", "bar-baz", "x_y"]);
});

it("does not wake a coach for a mention written by a holder or a coach", async () => {
  const seen: { holder: string; prompt: string }[] = [];
  const outcomes = await run(
    () => { agent(
        "🧭 coach-telegram · Pense à @spark-the-cat.",
        "pattern-holder:coach-telegram:t1",
        iso(-30_000),
      ); },
    replying("x", seen),
  );
  expect(outcomes.filter((o) => o.reason === "handle")).toEqual([]);
  expect(seen.filter((s) => s.prompt.includes("est mentionné ici"))).toEqual([]);
});

it("adds the private sentence for a private coach only", async () => {
  const seen: { holder: string; prompt: string }[] = [];
  const outcomes = await run(
    () => { human("m1", "Qu'en pense @marie_t ?", iso(-30_000)); },
    replying("SILENCE", seen),
  );
  expect(outcomes).toEqual([
    expect.objectContaining({ slug: "coach-telegram", state: "silent", reason: "handle" }),
  ]);
  expect(seen[0]?.holder).toBe("coach-telegram");
  expect(seen[0]?.prompt).toContain("@marie_t est mentionné ici.");
  expect(seen[0]?.prompt).toContain(
    "Tu es un coach privé : rien de ce que tu sais par le privé ne va dans un fil partagé.",
  );
});

it("wakes nothing and logs one line, without failing, when the registry is absent or invalid", async () => {
  fs.rmSync(registryFile());
  const logs: string[] = [];
  const seen: { holder: string; prompt: string }[] = [];
  const outcomes = await run(
    () => { human("m1", "Et @spark-the-cat ?", iso(-30_000)); },
    replying("x", seen),
    logs,
  );
  expect(outcomes.filter((o) => o.reason === "handle")).toEqual([]);
  expect(seen.filter((s) => s.prompt.includes("est mentionné ici"))).toEqual([]);
  expect(logs.filter((l) => l.includes("registre des coachs"))).toHaveLength(1);

  fs.writeFileSync(registryFile(), "{ pas du json");
  human("m2", "Encore @spark-the-cat", iso(-20_000));
  const again: string[] = [];
  await expect(
    tickPatternHolders({ dataDir, claude, call: replying("x", seen), now, log: (l) => again.push(l) }),
  ).resolves.toBeDefined();
  expect(again.filter((l) => l.includes("registre des coachs"))).toHaveLength(1);
});
