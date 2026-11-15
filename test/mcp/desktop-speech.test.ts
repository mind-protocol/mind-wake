import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ElevenLabs } from "../../services/elevenlabs/service.js";
import { speechProse } from "../../services/elevenlabs/prose.js";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
function setup(
  http: typeof fetch = vi.fn(
    async () =>
      new Response(new Uint8Array([73, 68, 51]), {
        headers: { "content-type": "audio/mpeg" },
      }),
  ),
) {
  const dir = fs.mkdtempSync(path.join(process.cwd(), "test/.speech-"));
  dirs.push(dir);
  let active = true;
  const service = new ElevenLabs(dir, http, () => active);
  service.configure({
    enabled: true,
    apiKey: "fixture-key",
    voiceId: "Marco",
    autoplay: true,
  });
  return {
    service,
    http,
    dir,
    stop: () => {
      active = false;
    },
  };
}
it("selects exact prose, preserving French, stripping Markdown, destinations, code and tables", () => {
  expect(
    speechProse(
      "# Bonjour\n\n**Ça marche.** [Le résultat](https://example.org)\n```ts\nsecret();\n```\n|a|b|\nhttps://example.org\n![photo](local.png)",
    ),
  ).toBe("Bonjour\nÇa marche. Le résultat");
  expect(speechProse("Oui !")).toBe("Oui !");
});
it("returns before the provider responds and queues a single clip for repeated requests", async () => {
  let release!: (response: Response) => void;
  const http = vi.fn<typeof fetch>(() => new Promise(resolve => { release = resolve; }));
  const { service } = setup(http);
  const input = { text: "Bonjour.", idempotency_key: "reply:background" };

  expect(service.queueDesktopSpeech(input)).toEqual({ generation: "in_progress" });
  expect(service.queueDesktopSpeech(input)).toEqual({ generation: "in_progress" });
  expect(() => service.queueDesktopSpeech({ ...input, text: "Autre texte." })).toThrow("conflit");
  expect(service.pending().clips).toEqual([]);

  release(new Response("mp3", { headers: { "content-type": "audio/mpeg" } }));
  await vi.waitFor(() => {
    expect(service.queueDesktopSpeech(input)).toMatchObject({ playback: "queued_for_desktop" });
  });
  expect(service.pending().clips).toHaveLength(1);
  expect(http).toHaveBeenCalledTimes(1);
});
it("persists request identity across instances, never regenerates/requeues an acknowledged reply", async () => {
  const f = setup();
  const input = { text: "**Bonjour.**", idempotency_key: "reply:own-1" };
  const clip = await f.service.speakDesktop(input);
  if (!("id" in clip)) throw Error("missing clip");
  expect(clip.text).toBe("Bonjour.");
  expect(f.service.claim(clip.id)).toEqual({ claimed: true });
  expect(f.service.claim(clip.id)).toEqual({ claimed: false });
  f.service.event(clip.id, "started");
  f.service.event(clip.id, "ended");
  expect(f.service.pending().clips).toEqual([]);
  const next = new ElevenLabs(f.dir, f.http, () => true);
  expect(await next.speakDesktop(input)).toEqual(clip);
  expect(f.http).toHaveBeenCalledTimes(1);
  await expect(
    next.speakDesktop({ ...input, text: "Changed" }),
  ).rejects.toThrow("conflit");
  expect(fs.existsSync(clip.audioPath)).toBe(true);
  expect(
    fs.existsSync(path.join(f.dir, "elevenlabs-audio", clip.id + ".clip")),
  ).toBe(true);
  const phases = fs
    .readFileSync(path.join(f.dir, "elevenlabs-audio/playback.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { phase: string }).phase);
  expect(phases).toEqual(["queued", "started", "ended"]);
});
it("prepares two voices concurrently and counts reservations toward the three-clip bound",async()=>{
 const releases:((r:Response)=>void)[]=[];
 const http=vi.fn<typeof fetch>(()=>new Promise(resolve=>releases.push(resolve)));
 const f=setup(http),one={text:'Un',idempotency_key:'one'};
 const first=f.service.speakDesktop(one);
 const second=new ElevenLabs(f.dir,http,()=>true).speakDesktop({text:'Deux',idempotency_key:'two'});
 expect(http).toHaveBeenCalledTimes(2);
 await expect(f.service.speakDesktop(one)).rejects.toThrow('incertain');
 await expect(f.service.speakDesktop({text:'Trois',idempotency_key:'three'})).rejects.toThrow('déjà');
 releases[0]!(new Response('mp3',{headers:{'content-type':'audio/mpeg'}}));await first;
 const third=f.service.speakDesktop({text:'Trois',idempotency_key:'three'});expect(http).toHaveBeenCalledTimes(3);
 await expect(f.service.speakDesktop({text:'Quatre',idempotency_key:'four'})).rejects.toThrow('pleine');
 releases[1]!(new Response('mp3',{headers:{'content-type':'audio/mpeg'}}));
 releases[2]!(new Response('mp3',{headers:{'content-type':'audio/mpeg'}}));await Promise.all([second,third]);
 expect(f.service.pending().clips).toHaveLength(3);expect(http).toHaveBeenCalledTimes(3);
});
it("never retries an ambiguous failed paid request and rejects long responses before provider", async () => {
  const f = setup(
    vi.fn(async () => {
      throw Error("network");
    }),
  );
  const input = { text: "Bonjour", idempotency_key: "once" };
  await expect(f.service.speakDesktop(input)).rejects.toThrow("network");
  await expect(f.service.speakDesktop(input)).rejects.toThrow("incertain");
  await expect(
    f.service.speakDesktop({ text: "a".repeat(1501), idempotency_key: "long" }),
  ).rejects.toThrow("longue");
  expect(f.http).toHaveBeenCalledTimes(1);
});
it("cancels an in-flight provider call when Pause arrives, without a queued clip", async () => {
  const http = vi.fn<typeof fetch>(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(Error("aborted")),
          { once: true },
        );
      }),
  );
  const f = setup(http);
  const pending = f.service.speakDesktop({
    text: "Bonjour",
    idempotency_key: "pause",
  });
  f.stop();
  await expect(pending).rejects.toThrow("aborted");
  expect(f.service.pending()).toEqual({ allowed: false, clips: [] });
});
it("identifies contributions from current threads", async () => {
  const f = setup();
  for (const thread of ["film", "jeu", "dialogue"])
    await f.service.speakDesktop({
      text: `Contribution ${thread}.`,
      idempotency_key: `reply:${thread}`,
      thread_id: thread,
    });
  expect(
    f.service
      .pending()
      .clips.map((clip) => clip.threadId)
      .sort(),
  ).toEqual(["dialogue", "film", "jeu"]);
  expect(f.http).toHaveBeenCalledTimes(3);
});
