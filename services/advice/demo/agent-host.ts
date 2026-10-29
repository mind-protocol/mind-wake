/**
 * Serveur d'origine SIMULÉ de l'agent guest (SPEC §17.2, étape 4) : c'est lui, côté agent,
 * qui réveille l'agent factice de G2 dans son propre processus et relaie ses attestations
 * de sauvegarde. Le prompt, la mémoire et le credential de l'agent restent dans son
 * dossier privé ; ce module les crée pour la démo puis ne les lit jamais.
 *
 * Dans la démo, tout tourne sur une même machine, mais en processus et dossiers séparés :
 * le guest n'est jamais chargé dans le processus du guide ni dans celui du service.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckpointAttestation } from "./bridge.js";
import { CONVERSATION_DIR, NODE_ARGS, minimalEnv } from "./runtime.js";

export interface GuestPersona {
  readonly agentId: string;
  /** Contenu privé : ne doit jamais apparaître côté guide ni dans le service. */
  readonly systemPrompt: string;
  readonly privateToken: string;
  readonly priorMemory: string;
}

export interface WakeOptions {
  readonly pipe: string;
  readonly invitation: string;
  readonly linkKey: string;
  readonly script?: "cooperative" | "hostile";
  readonly duplicateSends?: boolean;
  /** Le guest résume et clôt après ce nombre de réponses (0 : jamais). */
  readonly closeAfter?: number;
  /** Simule un réveil impossible (dossier privé introuvable). */
  readonly failWake?: boolean;
}

export interface AwakeGuest {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  stderr(): string;
  kill(): Promise<void>;
}

export class AgentHost {
  readonly root: string;
  readonly persona: GuestPersona;
  readonly home: string;
  readonly checkpointsPath: string;
  #offset = 0;
  #pending = "";
  readonly #guests = new Set<ChildProcess>();

  constructor(root: string, persona: GuestPersona) {
    this.root = root;
    this.persona = persona;
    this.home = join(root, "home");
    const runtime = join(root, "runtime");
    this.checkpointsPath = join(runtime, "checkpoints.jsonl");
    mkdirSync(runtime, { recursive: true });
    if (!existsSync(this.home)) {
      mkdirSync(this.home, { recursive: true });
      writeFileSync(join(this.home, "system-prompt.txt"), persona.systemPrompt, "utf8");
      writeFileSync(
        join(this.home, "credentials.json"),
        JSON.stringify({ privateToken: persona.privateToken }),
        "utf8",
      );
      writeFileSync(
        join(this.home, "memory.jsonl"),
        `${JSON.stringify({ type: "tool", name: persona.priorMemory, ok: true })}\n`,
        "utf8",
      );
    }
  }

  /** Réveille l'agent factice dans un processus séparé. */
  wake(options: WakeOptions): AwakeGuest {
    const child = spawn(
      process.execPath,
      [...NODE_ARGS, join(CONVERSATION_DIR, "guest/fake-guest.ts")],
      {
        stdio: ["ignore", "ignore", "pipe"],
        // Seul le guest reçoit ses variables ; aucune variable de l'hôte n'est héritée.
        env: minimalEnv({
          MIND_ADVICE_PIPE: options.pipe,
          MIND_ADVICE_INVITATION: options.invitation,
          MIND_ADVICE_LINK_KEY: options.linkKey,
          GUEST_HOME: options.failWake === true ? join(this.root, "absent") : this.home,
          GUEST_SCRIPT: options.script ?? "cooperative",
          GUEST_DUPLICATE_SENDS: options.duplicateSends === true ? "1" : "0",
          GUEST_CLOSE_AFTER: String(options.closeAfter ?? 0),
          GUEST_CHECKPOINTS: this.checkpointsPath,
        }),
      },
    );
    this.#guests.add(child);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => {
        this.#guests.delete(child);
        resolve(code);
      });
    });
    return {
      child,
      exited,
      stderr: () => stderr,
      kill: async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exited;
      },
    };
  }

  /** Nouvelles attestations de sauvegarde (références opaques seulement). */
  pullCheckpoints(): CheckpointAttestation[] {
    if (!existsSync(this.checkpointsPath)) return [];
    const fd = openSync(this.checkpointsPath, "r");
    try {
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) {
        const read = readSync(fd, buffer, 0, buffer.length, this.#offset);
        if (read === 0) break;
        this.#offset += read;
        this.#pending += buffer.toString("utf8", 0, read);
      }
    } finally {
      closeSync(fd);
    }
    const lines = this.#pending.split("\n");
    this.#pending = lines.pop() ?? "";
    return lines.filter((line) => line.length > 0).map(parseAttestation);
  }

  async stop(): Promise<void> {
    await Promise.all(
      [...this.#guests].map(
        (child) =>
          new Promise<void>((resolve) => {
            child.once("exit", () => {
              resolve();
            });
            child.kill();
          }),
      ),
    );
  }
}

function parseAttestation(line: string): CheckpointAttestation {
  const raw = JSON.parse(line) as Record<string, unknown>;
  const { encounterId, inReplyTo, checkpointRef } = raw;
  if (
    typeof encounterId !== "string" ||
    typeof inReplyTo !== "string" ||
    typeof checkpointRef !== "string"
  ) {
    throw new Error("attestation de sauvegarde mal formée");
  }
  return { encounterId, inReplyTo, checkpointRef };
}
