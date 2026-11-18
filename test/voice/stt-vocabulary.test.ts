import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TERMS,
  STT_VOCABULARY_FILE,
  elevenLabsKeyterms,
  formatSttVocabularyText,
  parseSttVocabularyText,
  readSttVocabulary,
  whisperHotwordArguments,
  writeSttVocabulary,
} from "../../services/voice/stt-vocabulary.mjs";
import { vocabularyArguments } from "../../services/voice/transcription-vocabulary.mjs";
// @ts-expect-error -- module .mjs sans déclaration de types
import { localTranscriber } from "../../services/telegram/transcriber.mjs";
import { ElevenLabs } from "../../services/elevenlabs/service.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stt-vocab-"));
  dirs.push(dir);
  return dir;
}

describe("vocabulaire de transcription (stt-vocabulary.json)", () => {
  it("sans fichier : liste initiale du mandat, ElevenLabs désactivé", () => {
    const v = readSttVocabulary(tempDir());
    expect(v.source).toBe("default");
    expect(v.terms).toEqual([...DEFAULT_TERMS]);
    expect(v.terms).toEqual(expect.arrayContaining(["Codex", "ChatGPT", "MIND Wake", "pattern holder", "Équerre"]));
    expect(v.elevenlabsKeyterms).toBe(false);
    expect(elevenLabsKeyterms(v)).toEqual([]);
  });

  it("champ Réglages : une ligne par mot, doublons et commentaires ignorés, écriture puis relecture", () => {
    const dir = tempDir();
    const parsed = parseSttVocabularyText("Codex\r\n  ChatGPT  \n\n# note\ncodex\nMIND   Wake\n");
    expect(parsed.terms).toEqual(["Codex", "ChatGPT", "codex", "MIND   Wake"]);
    const saved = writeSttVocabulary(dir, { ...parsed, elevenlabsKeyterms: true });
    expect(saved.terms).toEqual(["Codex", "ChatGPT", "MIND Wake"]);
    const file = JSON.parse(fs.readFileSync(path.join(dir, STT_VOCABULARY_FILE), "utf8"));
    expect(file).toMatchObject({ version: 1, elevenlabsKeyterms: true });
    const read = readSttVocabulary(dir);
    expect(read.source).toBe("file");
    expect(formatSttVocabularyText(read).split("\n")).toHaveLength(3);
  });

  it("refuse les mots trop longs ou aux caractères interdits par ElevenLabs", () => {
    const dir = tempDir();
    expect(() => writeSttVocabulary(dir, { terms: ["x".repeat(51)] })).toThrow("50 caractères");
    expect(() => writeSttVocabulary(dir, { terms: ["<Codex>"] })).toThrow("interdits");
    expect(fs.existsSync(path.join(dir, STT_VOCABULARY_FILE))).toBe(false);
  });

  it("fichier illisible : la transcription garde la liste initiale et l'erreur est signalée", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, STT_VOCABULARY_FILE), "{pas du json");
    const v = readSttVocabulary(dir);
    expect(v.terms).toEqual([...DEFAULT_TERMS]);
    expect(v.error).toBeTruthy();
  });

  it("reprend les mots de l'ancien fichier desktop tant que le nouveau n'existe pas", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "desktop-transcription-vocabulary.json"), JSON.stringify({ version: 1, terms: ["Suno", "codex"] }));
    const v = readSttVocabulary(dir);
    expect(v.terms).toContain("Suno");
    expect(v.terms.filter((t) => t.toLowerCase() === "codex")).toHaveLength(1);
  });

  it("Whisper : --hotwords, aussi par l'ancien point d'entrée de la dictée desktop", () => {
    const dir = tempDir();
    writeSttVocabulary(dir, { terms: ["Codex", "ChatGPT"] });
    expect(whisperHotwordArguments(readSttVocabulary(dir))).toEqual(["--hotwords", "Codex, ChatGPT"]);
    expect(vocabularyArguments(dir)).toEqual(["--hotwords", "Codex, ChatGPT"]);
    expect(whisperHotwordArguments({ terms: [], elevenlabsKeyterms: false })).toEqual([]);
  });

  it("ElevenLabs temps réel : ≤ 20 caractères par terme, seulement si coché", () => {
    const v = { terms: ["Codex", "un terme assez long ici"], elevenlabsKeyterms: true };
    expect(elevenLabsKeyterms(v)).toEqual(["Codex", "un terme assez long ici"]);
    expect(elevenLabsKeyterms(v, { realtime: true })).toEqual(["Codex"]);
  });
});

describe("branchements", () => {
  it("vocal Telegram : transcribe.py reçoit les hotwords du profil, relus à chaque vocal", async () => {
    const dir = tempDir();
    const run = vi.fn(async (_command: string, _args: string[]) => JSON.stringify({ text: "On lance Codex." }));
    const transcribe = localTranscriber({ transcription: { model: "small", language: "fr" } }, "/repo", run, { dataDir: dir });
    expect(await transcribe(Buffer.from([1, 2, 3]))).toBe("On lance Codex.");
    let args = run.mock.calls[0]?.[1] ?? [];
    expect(args.slice(args.indexOf("--hotwords"), args.indexOf("--hotwords") + 2)).toEqual(["--hotwords", DEFAULT_TERMS.join(", ")]);
    expect(args).toContain("--language");
    writeSttVocabulary(dir, { terms: ["FluxBeam"] });
    await transcribe(Buffer.from([1]));
    args = run.mock.calls[1]?.[1] ?? [];
    expect(args).toContain("FluxBeam");
    expect(args).not.toContain(DEFAULT_TERMS.join(", "));
  });

  it("vocal Telegram sans dataDir : comportement inchangé (pas de hotwords)", async () => {
    const run = vi.fn(async (_command: string, _args: string[]) => JSON.stringify({ text: "x" }));
    await localTranscriber({ transcription: { model: "small" } }, "/repo", run)(Buffer.from([1]));
    expect(run.mock.calls[0]?.[1]).not.toContain("--hotwords");
  });

  function elevenlabs(dir: string, http: typeof fetch) {
    const service = new ElevenLabs(dir, http, () => true);
    service.configure({ enabled: true, apiKey: "fixture-private", voiceId: "Marco", autoplay: true, transcriptionEnabled: true });
    return service;
  }
  const scribeOk = () =>
    vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ token: "temporary" }))
      .mockResolvedValueOnce(Response.json({ text: "Codex répond.", language_code: "fra", words: [{ type: "word" }] }));
  const input = { audio: "AQID", capturedAt: new Date().toISOString(), request_id: "r1" };

  it("ElevenLabs Scribe batch : aucun keyterm par défaut (pas de surcoût)", async () => {
    const dir = tempDir();
    const http = scribeOk();
    await elevenlabs(dir, http).transcribeDesktop(input);
    expect((http.mock.calls[1]?.[1]?.body as FormData).getAll("keyterms")).toEqual([]);
  });

  it("ElevenLabs Scribe batch : keyterms répétés quand l'option est cochée, texte non réécrit", async () => {
    const dir = tempDir();
    writeSttVocabulary(dir, { terms: ["Codex", "ChatGPT"], elevenlabsKeyterms: true });
    const http = scribeOk();
    const result = await elevenlabs(dir, http).transcribeDesktop({ ...input, request_id: "r2" });
    expect((http.mock.calls[1]?.[1]?.body as FormData).getAll("keyterms")).toEqual(["Codex", "ChatGPT"]);
    expect(result.text).toBe("Codex répond.");
  });

  it("ElevenLabs temps réel : le jeton est accompagné des keyterms seulement si coché", async () => {
    const dir = tempDir();
    const token = () => vi.fn<typeof fetch>().mockResolvedValue(Response.json({ token: "temporary" }));
    expect(await elevenlabs(dir, token()).realtimeTranscriptionToken()).toEqual({ token: "temporary", keyterms: [] });
    writeSttVocabulary(dir, { terms: ["Codex"], elevenlabsKeyterms: true });
    expect(await elevenlabs(dir, token()).realtimeTranscriptionToken()).toEqual({ token: "temporary", keyterms: ["Codex"] });
  });
});
