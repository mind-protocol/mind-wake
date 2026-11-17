import {DesktopVoiceMode} from "./voice-mode.js";
import fs from "node:fs";
import {enqueueOwnerMessage} from "../../src/communication/owner-inbox.js";
import {completedVoiceMessage} from "./voice-exchange.js";
import path from "node:path";
import { speechProse } from "./prose.js";
import { createHash, randomUUID } from "node:crypto";
import * as z from "zod";
import { externalInboxSyncAllowed } from "../../src/communication/external-inbox-policy.js";
import {
  accountRefusal,
  appendElevenLabsError,
  closeElevenLabsCircuit,
  openElevenLabsCircuit,
  readElevenLabsCircuit,
  VOICE_CUT_MESSAGE,
} from "../../src/communication/elevenlabs-circuit.js";

/** Refus HTTP du fournisseur ; le message reste celui, expurgé, des versions précédentes. */
export class ElevenLabsHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`ElevenLabs HTTP ${String(status)} : vérifier les droits et crédits du compte.`);
  }
}

const voiceId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
// Champs inconnus ignorés (et retirés à la prochaine écriture) : une note ajoutée à la main
// ne doit pas rendre la configuration illisible ni bloquer la case de réactivation.
const configSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  apiKey: z.string().max(512),
  voiceId: voiceId.or(z.literal("")),
  autoplay: z.boolean(),
  transcriptionEnabled: z.boolean().default(false),
});
const configureSchema = configSchema
  .omit({ version: true, apiKey: true, transcriptionEnabled: true })
  .extend({
    apiKey: z.string().max(512).optional(),
    transcriptionEnabled: z.boolean().optional(),
  });
export const speechSchema = z.strictObject({
  text: z.string().trim().min(1).max(5000),
  voice_id: voiceId.optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
  thread_id: z.string().min(1).max(128).optional(),
  agent_ref: z.string().min(1).max(128).optional(),
  cycle_id: z.string().min(1).max(128).optional(),
  expected_voice_revision:z.string().min(1).max(256).optional(),
});
const clipSchema = z.strictObject({
  id: z.uuid(),
  text: z.string(),
  voiceId: z.string(),
  createdAt: z.string(),
  autoplay: z.boolean(),
  threadId: z.string().optional(),
  agentRef: z.string().optional(),
  cycleId: z.string().optional(),
  voiceModeRevision:z.string().optional(),
});

type SpeechReservation = {
  args: z.infer<typeof speechSchema>;
  receipt: string;
  fingerprint: string;
  slot: string;
};
/** Un clip non lu au-delà de ce délai n'est plus une réponse en direct. */
export const QUEUED_CLIP_TTL_MS = 10 * 60_000;
/** Réservation de lecture jamais démarrée : la webview qui l'a prise a disparu. */
export const STALE_CLAIM_MS = 60_000;
type SpeechResult ={ result: Awaited<ReturnType<ElevenLabs["generateAudio"]>> };

/** Profile-local credentials and MP3 spool. No provider key reaches the webview or MCP. */
export class ElevenLabs {
  constructor(
    readonly dir: string,
    private readonly http: typeof fetch = fetch,
    private readonly active: () => boolean = () =>
      externalInboxSyncAllowed(dir),
  ) {}
  private file() {
    return path.join(this.dir, "elevenlabs.json");
  }
  private spool() {
    return path.join(this.dir, "elevenlabs-audio");
  }
  private config() {
    try {
      return configSchema.parse(
        JSON.parse(fs.readFileSync(this.file(), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          version: 1 as const,
          enabled: false,
          apiKey: "",
          voiceId: "",
          autoplay: true,
          transcriptionEnabled: false,
        };
      throw Error("Configuration ElevenLabs invalide.", { cause: error });
    }
  }
  status() {
    const { apiKey, ...config } = this.config();
    const circuit = readElevenLabsCircuit(this.dir);
    return {
      ...config,
      hasKey: !!apiKey,
      ...(circuit ? { circuit, voiceStatus: VOICE_CUT_MESSAGE } : {}),
    };
  }
  configure(input: unknown) {
    const draft = configureSchema.parse(input);
    const previous = this.config();
    const config = {
      ...previous,
      ...draft,
      apiKey: draft.apiKey?.trim() || previous.apiKey,
    };
    if (config.enabled && (!config.apiKey || !config.voiceId))
      throw Error("Clé API et voix requises pour activer ElevenLabs.");
    // Seul geste humain qui rouvre la voix depuis Réglages : recocher l'autorisation.
    if (config.enabled && !previous.enabled) closeElevenLabsCircuit(this.dir, "settings");
    fs.mkdirSync(this.dir, { recursive: true });
    const temporary = `${this.file()}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(config), {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporary, this.file());
    return this.status();
  }
  private async request(endpoint: string, init: RequestInit = {}) {
    const { apiKey } = this.config();
    if (!apiKey) throw Error("Configurer la clé API ElevenLabs dans Réglages.");
    const response = await this.http(`https://api.elevenlabs.io${endpoint}`, {
      ...init,
      redirect: "error",
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    });
    if (!response.ok) {
      let code: string | undefined;
      try {
        const body = (await response.json()) as { detail?: { status?: unknown } };
        if (typeof body.detail?.status === "string" && /^[a-z_]{1,64}$/.test(body.detail.status))
          code = body.detail.status;
      } catch {
        /* Provider bodies may contain private context: keep only a validated status code. */
      }
      throw new ElevenLabsHttpError(response.status, code);
    }
    return response;
  }
  async voices(cursor?: string) {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor)
      query.set("next_page_token", z.string().max(2048).parse(cursor));
    const response = await this.request(`/v2/voices?${query}`);
    return z
      .object({
        voices: z.array(
          z.object({
            voice_id: voiceId,
            name: z.string(),
            category: z.string().optional(),
            labels: z.record(z.string(), z.string()).optional(),
          }),
        ),
        has_more: z.boolean(),
        next_page_token: z.string().nullable().optional(),
      })
      .parse(await response.json());
  }
  private allowed() {
    if (!this.config().enabled) throw Error("ElevenLabs est désactivé.");
    if (!this.active())
      throw Error("Wake est en pause, arrêté ou indisponible.");
  }
  /** Toute génération payante passe ici : le disjoncteur ouvert l'emporte sur la configuration. */
  private generationAllowed() {
    if (readElevenLabsCircuit(this.dir)) throw Error(VOICE_CUT_MESSAGE);
    this.allowed();
  }
  /** Journalise chaque échec ; un refus de compte ouvre le disjoncteur et décoche l'autorisation. */
  private recordGenerationFailure(error: unknown): Error {
    const status = error instanceof ElevenLabsHttpError ? error.status : null;
    const code = error instanceof ElevenLabsHttpError ? error.code : undefined;
    const message =
      error instanceof Error && /^(ElevenLabs |Wake |Configurer |Configuration |Audio |Réponse audio )/.test(error.message)
        ? error.message
        : "ElevenLabs : appel échoué (transport).";
    appendElevenLabsError(this.dir, { status, message, ...(code ? { code } : {}) });
    const reason = status === null ? undefined : accountRefusal(status, code);
    if (!reason) return error instanceof Error ? error : Error(message);
    openElevenLabsCircuit(this.dir, { status, reason, ...(code ? { code } : {}) });
    try {
      const config = this.config();
      if (config.enabled)
        this.configure({
          enabled: false,
          voiceId: config.voiceId,
          autoplay: config.autoplay,
          transcriptionEnabled: config.transcriptionEnabled,
        });
    } catch {
      // Le disjoncteur suffit à bloquer ; la case sera décochée à la prochaine écriture.
    }
    return Error(VOICE_CUT_MESSAGE);
  }
  private readonly backgroundRequests = new Set<string>();

  /**
   * La file ne doit jamais rester bloquée : une réservation de lecture jamais démarrée
   * (webview rechargée, app fermée) se libère, et un clip non lu trop ancien quitte la
   * file. Les MP3 restent sur disque ; seul le marqueur de livraison est retiré.
   */
  private releaseStaleQueue(now = Date.now()) {
    let names: string[];
    try {
      names = fs.readdirSync(this.spool());
    } catch {
      return;
    }
    for (const name of names.filter((n) => /^[0-9a-f-]{36}\.json$/.test(n))) {
      const id = name.slice(0, -5);
      const file = path.join(this.spool(), name);
      const claim = path.join(this.spool(), `${id}.claim`);
      if (fs.existsSync(path.join(this.spool(), `${id}.started`))) continue;
      let createdAt = Number.NaN;
      try {
        createdAt = Date.parse(
          (JSON.parse(fs.readFileSync(file, "utf8")) as { createdAt?: string }).createdAt ?? "",
        );
      } catch {
        // Marqueur illisible : traité comme périmé.
      }
      if (!Number.isFinite(createdAt) || now - createdAt > QUEUED_CLIP_TTL_MS) {
        this.dropQueued(id, "expired");
        continue;
      }
      try {
        if (now - fs.statSync(claim).mtimeMs > STALE_CLAIM_MS) fs.rmSync(claim, { force: true });
      } catch {
        // Pas de réservation.
      }
    }
  }
  private dropQueued(id: string, phase: "expired" | "evicted") {
    fs.rmSync(path.join(this.spool(), `${id}.json`), { force: true });
    fs.rmSync(path.join(this.spool(), `${id}.claim`), { force: true });
    fs.appendFileSync(
      path.join(this.spool(), "playback.jsonl"),
      JSON.stringify({ id, phase, at: new Date().toISOString() }) + "\n",
      { mode: 0o600 },
    );
  }
  /** File pleine : le plus ancien clip non démarré cède sa place à la nouvelle voix. */
  private evictOldestQueued(): boolean {
    const queued = fs
      .readdirSync(this.spool())
      .filter((n) => /^[0-9a-f-]{36}\.json$/.test(n))
      .map((n) => n.slice(0, -5))
      .filter((id) => !fs.existsSync(path.join(this.spool(), `${id}.started`)))
      .map((id) => {
        try {
          return {
            id,
            at: (
              JSON.parse(fs.readFileSync(path.join(this.spool(), `${id}.json`), "utf8")) as {
                createdAt?: string;
              }
            ).createdAt ?? "",
          };
        } catch {
          return { id, at: "" };
        }
      })
      .sort((a, b) => a.at.localeCompare(b.at));
    const oldest = queued[0];
    if (!oldest) return false;
    this.dropQueued(oldest.id, "evicted");
    return true;
  }

  /**
   * MP3 d'un texte pour un vocal Telegram au propriétaire (NLR, 16 nov. 2026 17:31), sans file
   * de lecture desktop. Mêmes garde-fous qu'une génération : autorisation, pause, disjoncteur,
   * voix choisie dans Réglages, modèle multilingue ; tout échec est journalisé comme les autres.
   */
  async synthesizeMp3(text: string, signal?: AbortSignal): Promise<Buffer> {
    const spoken = z.string().trim().min(1).max(5000).parse(text);
    try {
      this.generationAllowed();
      const selected = voiceId.parse(this.config().voiceId);
      const response = await this.request(
        `/v1/text-to-speech/${selected}?output_format=mp3_44100_128`,
        {
          method: "POST",
          ...(signal ? { signal } : {}),
          body: JSON.stringify({ text: spoken, model_id: "eleven_multilingual_v2" }),
        },
      );
      const reader = response.body?.getReader();
      if (!reader) throw Error("Audio ElevenLabs vide.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 16 * 1024 * 1024) throw Error("Audio ElevenLabs trop volumineux.");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (!size || !response.headers.get("content-type")?.startsWith("audio/"))
        throw Error("Réponse audio ElevenLabs invalide.");
      return Buffer.concat(chunks);
    } catch (error) {
      // Désactivé ou disjoncteur ouvert : pas un échec du fournisseur, rien à journaliser.
      if (error instanceof Error && /^(ElevenLabs est désactivé|Wake est en pause)/.test(error.message)) throw error;
      if (error instanceof Error && error.message === VOICE_CUT_MESSAGE) throw error;
      throw this.recordGenerationFailure(error);
    }
  }

  async generate(input: unknown) {
    const request = this.reserveGeneration(input);
    if ("result" in request) return request.result;
    return this.generateReserved(request);
  }

  queueGeneration(input: unknown) {
    const request = this.reserveGeneration(input, true);
    if ("result" in request) return request.result;
    if ("pending" in request) return { generation: "in_progress" as const };
    this.backgroundRequests.add(request.receipt);
    void this.generateReserved(request)
      .catch(() => process.stderr.write("ElevenLabs : échec de la génération en arrière-plan.\n"))
      .finally(() => this.backgroundRequests.delete(request.receipt));
    return { generation: "in_progress" as const };
  }

  /** One cross-process owner for all generation; ambiguous failures never auto-retry. */
  private reserveGeneration(
    input: unknown,
    background: true,
  ): { pending: true } | SpeechReservation | SpeechResult;
  private reserveGeneration(input: unknown): SpeechReservation | SpeechResult;
  private reserveGeneration(
    input: unknown,
    background = false,
  ): { pending: true } | SpeechReservation | SpeechResult {
    const args = speechSchema.parse(input);
    this.generationAllowed();
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          args.text,
          args.voice_id ?? this.config().voiceId,
          args.thread_id ?? "principal",
        ]),
      )
      .digest("hex");
    const key = createHash("sha256")
      .update(args.idempotency_key ?? randomUUID())
      .digest("hex");
    fs.mkdirSync(this.spool(), { recursive: true });
    const receipt = path.join(this.spool(), key + ".request");
    const existing = () => {
      if (!fs.existsSync(receipt)) return undefined;
      const previous = JSON.parse(fs.readFileSync(receipt, "utf8")) as {
        fingerprint: string;
        result?: Awaited<ReturnType<ElevenLabs["generateAudio"]>>;
      };
      if (previous.fingerprint !== fingerprint)
        throw Error("ElevenLabs : conflit de clé d'idempotence.");
      if (background && this.backgroundRequests.has(receipt))
        return { pending: true } as const;
      if (!previous.result)
        throw Error(
          "ElevenLabs : résultat incertain, aucune régénération automatique.",
        );
      return { result: previous.result };
    };
    const previous = existing();
    if (previous) return previous;
    const lock = path.join(this.spool(), ".generation-lock");
    try {
      fs.mkdirSync(lock);
    } catch {
      throw Error(
        "ElevenLabs : génération déjà en cours ou verrou à examiner.",
      );
    }
    // Reserve capacity atomically; do not hold a global lock over paid HTTP.
    const slot=path.join(this.spool(),'.generation-slot-'+key);
    let reserved=false;
    try {
      const reused=existing(); if(reused)return reused;
      this.releaseStaleQueue();
      const count=()=>{const names=fs.readdirSync(this.spool());return {active:names.filter(name=>name.startsWith('.generation-slot-')).length,queued:names.filter(name=>/^[0-9a-f-]{36}\.json$/.test(name)).length};};
      let {active,queued}=count();
      if(active>=2)throw Error('ElevenLabs : génération déjà en cours (2 appels).');
      // La réponse la plus récente compte plus qu'un ancien clip resté non lu.
      while(queued+active>=3&&this.evictOldestQueued())({active,queued}=count());
      if(queued+active>=3)throw Error('ElevenLabs : file desktop pleine (3 clips ou réservations).');
      fs.writeFileSync(receipt,JSON.stringify({fingerprint,phase:'reserved',at:new Date().toISOString()}),{flag:'wx',mode:0o600});
      fs.writeFileSync(slot,JSON.stringify({key,at:new Date().toISOString()}),{flag:'wx',mode:0o600});
      reserved=true;
    } finally { fs.rmdirSync(lock); }
    if(!reserved)throw Error('ElevenLabs : réservation indisponible.');
    return { args, receipt, fingerprint, slot };
  }

  private async generateReserved({ args, receipt, fingerprint, slot }: SpeechReservation) {
    const controller=new AbortController();
    const guard=setInterval(()=>{try{this.allowed();}catch{controller.abort();}},250);
    try {
      const result=await this.generateAudio(args,controller.signal).catch((error:unknown)=>{throw this.recordGenerationFailure(error);});
      fs.writeFileSync(receipt,JSON.stringify({fingerprint,result}),{mode:0o600});
      return result;
    } finally {clearInterval(guard);fs.unlinkSync(slot);}
  }
  voiceModeState(input?:unknown){const mode=new DesktopVoiceMode(this.dir);return input===undefined||input===null?mode.read():mode.update(input);}
  async speakDesktop(input: unknown) {
    const args = this.desktopSpeechArgs(input);
    return args ? this.generate(args) : { playback: "skipped_no_prose" };
  }
  queueDesktopSpeech(input: unknown) {
    const args = this.desktopSpeechArgs(input);
    return args ? this.queueGeneration(args) : { playback: "skipped_no_prose" };
  }
  private desktopSpeechArgs(input: unknown) {
    const args = z
      .strictObject({
        text: z.string().min(1).max(5000),
        idempotency_key: z.string().min(1).max(200),
        thread_id: z.string().min(1).max(128).optional(),
        agent_ref: z.string().min(1).max(128).optional(),
  cycle_id: z.string().min(1).max(128).optional(),
  expected_voice_revision:z.string().min(1).max(256).optional(),
      })
      .parse(input);
    const text = speechProse(args.text);
    if (!text) return undefined;
    if (text.length > 1500)
      throw Error(
        "ElevenLabs : réponse trop longue pour la lecture automatique (1500 caractères).",
      );
    return {
      text,
      idempotency_key: args.idempotency_key,
      ...(args.thread_id ? { thread_id: args.thread_id } : {}),
      ...(args.agent_ref ? { agent_ref: args.agent_ref } : {}),
      ...(args.cycle_id ? { cycle_id: args.cycle_id } : {}),
      ...(args.expected_voice_revision?{expected_voice_revision:args.expected_voice_revision}:{}),
    };
  }
  /** Provider key remains local. Only the one-use realtime token can leave this service. */
  private async scribeToken(signal?: AbortSignal, kind: "batch_scribe" | "realtime_scribe" = "batch_scribe"): Promise<string> {
    this.allowed();
    const response = await this.http(
      `https://api.elevenlabs.io/v1/single-use-token/${kind}`,
      {
        method: "POST",
        redirect: "error",
        signal: signal ?? AbortSignal.timeout(15_000),
        headers: { "xi-api-key": this.config().apiKey },
      },
    ).catch((error: unknown) => {
      const code = (error as { cause?: { code?: unknown } }).cause?.code;
      throw Error(
        `ElevenLabs STT transport ${typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "unavailable"}.`,
      );
    });
    if (!response.ok) {
      let code = "unknown";
      try {
        const body = (await response.json()) as {
          detail?: { status?: unknown };
        };
        if (
          typeof body.detail?.status === "string" &&
          /^[a-z_]{1,64}$/.test(body.detail.status)
        )
          code = body.detail.status;
      } catch {
        /* Provider bodies may contain private context: never echo them. */
      }
      throw Error(
        `ElevenLabs STT HTTP ${response.status} code=${code} (permission speech_to_text).`,
      );
    }
    return z
      .object({ token: z.string().min(1).max(4096) })
      .parse(await response.json()).token;
  }
  async transcriptionPermission() {
    await this.scribeToken();
    return {
      batchScribeTokenIssued: true,
      audioUploaded: false,
      permission: "batch_scribe credential issued; transcript not yet verified",
    };
  }
  async realtimeTranscriptionToken() {
    const check = () => {
      this.allowed();
      if (!this.config().transcriptionEnabled)
        throw Error("ElevenLabs STT : transcription non activée pour ce profil.");
    };
    check();
    const token = await this.scribeToken(undefined, "realtime_scribe");
    check();
    return { token };
  }
  configureTranscription(enabled: boolean) {
    const config = this.config();
    return this.configure({
      enabled: config.enabled,
      voiceId: config.voiceId,
      autoplay: config.autoplay,
      transcriptionEnabled: z.boolean().parse(enabled),
    });
  }
  /** One current recorded slice, no silent fallback, no archive upload or text rewriting. */
  async transcribeDesktop(input: unknown) {
    const args = z
      .strictObject({
        audio: z
          .string()
          .min(4)
          .max(5_500_000)
          .regex(/^[A-Za-z0-9+/]+={0,2}$/),
        capturedAt: z.string().datetime(),
        request_id: z.string().min(1).max(200),
      })
      .parse(input);
    this.allowed();
    if (!this.config().transcriptionEnabled)
      throw Error(
        "ElevenLabs STT : transcription non activée pour ce profil ; utiliser la saisie manuelle.",
      );
    const bytes = Buffer.from(args.audio, "base64");
    if (bytes.length > 4_125_000 || bytes.toString("base64") !== args.audio)
      throw Error("ElevenLabs STT : audio invalide.");
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    // Deduplicate the actual recording too, even if a transport retries with another request ID.
    const folder = path.join(this.dir, "elevenlabs-transcripts");
    fs.mkdirSync(folder, { recursive: true });
    const receipt = path.join(folder, fingerprint + ".json");
    if (fs.existsSync(receipt)) {
      const previous = JSON.parse(fs.readFileSync(receipt, "utf8")) as {
        result?: { text: string; language: string };
      };
      if (previous.result) return previous.result;
      throw Error(
        "ElevenLabs STT : extrait réservé ou résultat incertain, aucune répétition automatique.",
      );
    }
    const lock = path.join(folder, ".transcription-lock");
    try {
      fs.mkdirSync(lock);
    } catch {
      throw Error("ElevenLabs STT : transcription déjà en cours.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    const cancelMarker = path.join(
      folder,
      createHash("sha256").update(args.request_id).digest("hex") + ".cancel",
    );
    const guard = setInterval(() => {
      try {
        this.allowed();
        if (fs.existsSync(cancelMarker)) controller.abort();
      } catch {
        controller.abort();
      }
    }, 250);
    const started = Date.now();
    try {
      if (fs.existsSync(cancelMarker))
        throw Error("ElevenLabs STT : extrait annulé.");
      const token = await this.scribeToken(controller.signal); // No audio before server authorizes batch Scribe.
      this.allowed();
      if (fs.existsSync(cancelMarker))
        throw Error("ElevenLabs STT : extrait annulé.");
      controller.signal.throwIfAborted();
      fs.writeFileSync(
        receipt,
        JSON.stringify({
          phase: "reserved",
          requestId: args.request_id,
          capturedAt: args.capturedAt,
          startedAt: new Date(started).toISOString(),
        }),
        { flag: "wx", mode: 0o600 },
      );
      const form = new FormData();
      form.set(
        "file",
        new Blob([bytes], { type: "audio/webm" }),
        "current-slice.webm",
      );
      form.set("model_id", "scribe_v2");
      form.set("language_code", "fr");
      form.set("tag_audio_events", "false");
      form.set("diarize", "false");
      const response = await this.http(
        `https://api.elevenlabs.io/v1/speech-to-text?token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          body: form,
        },
      );
      if (!response.ok) {
        let code = "unknown";
        try {
          const body = (await response.json()) as {
            detail?: { status?: unknown };
          };
          if (
            typeof body.detail?.status === "string" &&
            /^[a-z_]{1,64}$/.test(body.detail.status)
          )
            code = body.detail.status;
        } catch {}
        throw Error(`ElevenLabs STT HTTP ${response.status} code=${code}.`);
      }
      const result = z
        .object({
          text: z.string().max(16000),
          language_code: z.string(),
          words: z.array(z.object({ type: z.string() })).optional(),
        })
        .parse(await response.json());
      this.allowed();
      // The hint is not a licence to translate or repair unexpected words.
      if (!["fr", "fra"].includes(result.language_code) && result.text.trim())
        throw Error(
          "ElevenLabs STT : langue inattendue ; extrait non envoyé, utiliser la saisie manuelle.",
        );
      const text =
        result.words && !result.words.some((word) => word.type === "word")
          ? ""
          : result.text.trim();
      const output = {
        text,
        language: result.language_code,
        provider: "elevenlabs",
        model: "scribe_v2",
        capturedAt: args.capturedAt,
        startedAt: new Date(started).toISOString(),
        completedAt: new Date().toISOString(),
        processingMs: Date.now() - started,
        captureAgeMs: started - Date.parse(args.capturedAt),
      };
      fs.writeFileSync(receipt, JSON.stringify({ result: output }), {
        mode: 0o600,
      });
      return output;
    } finally {
      clearInterval(guard);
      clearTimeout(timer);
      fs.rmdirSync(lock);
    }
  }
  cancelTranscription(requestId: string) {
    z.string().min(1).max(200).parse(requestId);
    const folder = path.join(this.dir, "elevenlabs-transcripts");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(
        folder,
        createHash("sha256").update(requestId).digest("hex") + ".cancel",
      ),
      "cancelled",
      { mode: 0o600 },
    );
    return { cancelled: true };
  }
  private async generateAudio(input: unknown, signal: AbortSignal) {
    const args = speechSchema.parse(input);
    this.allowed();
    const config = this.config();
    const conversational=["fil1","fil2","fil3"].includes(args.thread_id??"");
    const voiceMode=new DesktopVoiceMode(this.dir);
    const mode=conversational?voiceMode.read():undefined;
    if(conversational)voiceMode.assertDelivery(args.expected_voice_revision??mode!.revision);
    const selected = voiceId.parse(args.voice_id ?? config.voiceId);
    this.generationAllowed(); // Dernier contrôle juste avant l'appel payant.
    const response = await this.request(
      `/v1/text-to-speech/${selected}?output_format=mp3_44100_128`,
      {
        method: "POST",
        signal,
        body: JSON.stringify({
          text: args.text,
          model_id: "eleven_multilingual_v2",
        }),
      },
    );
    // Bound memory even when a provider returns an unexpected payload.
    const reader = response.body?.getReader();
    if (!reader) throw Error("Audio ElevenLabs vide.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16 * 1024 * 1024)
          throw Error("Audio ElevenLabs trop volumineux.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (!size || !response.headers.get("content-type")?.startsWith("audio/"))
      throw Error("Réponse audio ElevenLabs invalide.");
    this.allowed(); // Never enqueue playback after a Pause/Force-off during generation.
    if(mode)voiceMode.assertDelivery(mode.revision);
    const clip = {
      id: randomUUID(),
      text: args.text,
      voiceId: selected,
      createdAt: new Date().toISOString(),
      autoplay: config.autoplay,
      ...(args.thread_id ? { threadId: args.thread_id } : {}),
      ...(args.agent_ref ? { agentRef: args.agent_ref } : {}),
      ...(args.cycle_id ? { cycleId: args.cycle_id } : {}),
      ...(mode?{voiceModeRevision:mode.revision}:{}),
    };
    fs.mkdirSync(this.spool(), { recursive: true });
    const audioPath = path.join(this.spool(), `${clip.id}.mp3`);
    fs.writeFileSync(audioPath, Buffer.concat(chunks), {
      flag: "wx",
      mode: 0o600,
    });
    fs.writeFileSync(
      path.join(this.spool(), clip.id + ".clip"),
      JSON.stringify(clip),
      { flag: "wx", mode: 0o600 },
    );
    this.event(clip.id, "queued");
    fs.writeFileSync(
      path.join(this.spool(), `${clip.id}.json`),
      JSON.stringify(clip),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    return { ...clip, audioPath, playback: "queued_for_desktop" };
  }
  pending() {
    const config = this.config();
    const voiceMode=this.voiceModeState();
    if (!config.enabled || !this.active()) return { allowed: false, clips: [] };
    this.releaseStaleQueue();
    let names: string[];
    try {
      names = fs.readdirSync(this.spool());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { allowed: true, clips: [] };
      throw error;
    }
    const clips = names
      .filter((n) => /^[0-9a-f-]{36}\.json$/.test(n))
      .map((n) =>
        clipSchema.parse(
          JSON.parse(fs.readFileSync(path.join(this.spool(), n), "utf8")),
        ),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      allowed: true,
      voiceMode,
      clips: clips.filter(clip=>!["fil1","fil2","fil3"].includes(clip.threadId??"")||(voiceMode.enabled&&voiceMode.microphoneActive&&!voiceMode.paused&&!voiceMode.forceOff&&clip.voiceModeRevision===voiceMode.revision)).slice(0, 20).map((clip) => ({
        ...clip,
        autoplay: clip.autoplay && config.autoplay,
      })),
    };
  }
  audio(id: string) {
    this.allowed();
    z.uuid().parse(id);
    const file = path.join(this.spool(), `${id}.mp3`);
    if (fs.statSync(file).size > 16 * 1024 * 1024)
      throw Error("Audio trop volumineux.");
    return { id, base64: fs.readFileSync(file).toString("base64") };
  }
  /** Explicitly promote one existing pending clip after autoplay was enabled. No new audio. */
  enablePending(id: string) {
    this.allowed();
    z.uuid().parse(id);
    if (!this.config().autoplay)
      throw Error(
        "ElevenLabs : activer la lecture automatique dans les réglages.",
      );
    const marker = path.join(this.spool(), id + ".json");
    const clip = clipSchema.parse(JSON.parse(fs.readFileSync(marker, "utf8")));
    if (!fs.existsSync(path.join(this.spool(), id + ".clip")))
      fs.writeFileSync(
        path.join(this.spool(), id + ".clip"),
        JSON.stringify(clip),
        { flag: "wx", mode: 0o600 },
      );
    const temporary = marker + "." + randomUUID() + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify({ ...clip, autoplay: true }), {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, marker);
    return { id, playback: "queued_existing_audio" };
  }
  claim(id: string) {
    this.allowed();
    z.uuid().parse(id);
    if (!fs.existsSync(path.join(this.spool(), id + ".json")))
      return { claimed: false };
    try {
      fs.writeFileSync(
        path.join(this.spool(), id + ".claim"),
        new Date().toISOString(),
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        return { claimed: false };
      throw error;
    }
    return { claimed: true };
  }
  event(id: string, phase: string) {
    z.uuid().parse(id);
    z.enum([
      "queued",
      "started",
      "ended",
      "blocked",
      "cancelled",
      "error",
    ]).parse(phase);
    fs.appendFileSync(
      path.join(this.spool(), "playback.jsonl"),
      JSON.stringify({ id, phase, at: new Date().toISOString() }) + "\n",
      { mode: 0o600 },
    );
    if (phase === "started") {
      this.allowed();
      const marker=path.join(this.spool(),id+'.started');
      try{fs.writeFileSync(marker,new Date().toISOString(),{flag:'wx',mode:0o600});}
      catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
      this.acknowledge(id);
    }
    if (phase === "ended" && fs.existsSync(path.join(this.spool(),id+'.started'))) {
      this.allowed();
      const clipFile=path.join(this.spool(),id+'.clip');
      if(fs.existsSync(clipFile)){
        const clip=clipSchema.parse(JSON.parse(fs.readFileSync(clipFile,'utf8')));
        const marker=path.join(this.spool(),id+'.completed');let at=new Date().toISOString();
        try{fs.writeFileSync(marker,at,{flag:'wx',mode:0o600});}
        catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;at=fs.readFileSync(marker,'utf8');}
        const message=completedVoiceMessage(clip,at);if(message)enqueueOwnerMessage(this.dir,message);
      }
    }
    return { id, phase };
  }
  acknowledge(id: string) {
    z.uuid().parse(id);
    // Retain MP3 for replay/export; remove only the pending delivery marker.
    fs.rmSync(path.join(this.spool(), `${id}.json`), { force: true });
    return { id, acknowledged: true };
  }
}

