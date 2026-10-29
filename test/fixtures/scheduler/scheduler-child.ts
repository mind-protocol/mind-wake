/**
 * Processus enfant des tests multi-processus du scheduler. Argument : JSON `ChildArgs`.
 * - `hold-lock` : prend le verrou d'instance, écrit le marqueur, puis attend sa mort.
 * - `tick` : prend le verrou, attend le fichier `go`, fait un tour, écrit le résultat.
 * - `tick-and-hang` : comme `tick`, puis reste vivant avec la session « en cours ».
 * Aucun runner ni modèle : le lanceur factice ne termine jamais la session.
 */

import { existsSync, writeFileSync } from "node:fs";
import { FakeClock, InstanceLockError, acquireInstanceLock } from "../../../src/scheduler/index.js";
import { openStore } from "../../../src/store/index.js";
import { bench } from "./setup.js";

export interface ChildArgs {
  readonly mode: "hold-lock" | "tick" | "tick-and-hang";
  readonly dbPath: string;
  readonly lockPath: string;
  readonly marker: string;
  readonly go?: string;
  readonly idPrefix: string;
  readonly wallMs: number;
}

const args = JSON.parse(process.argv[2] ?? "{}") as ChildArgs;

/**
 * Garde vivants les objets passés : un verrou non référencé peut être fermé par le
 * ramasse-miettes, ce qui le relâcherait.
 */
function hang(...keepAlive: unknown[]): void {
  setInterval(() => keepAlive.length, 1_000);
}

async function waitFor(path: string): Promise<void> {
  while (!existsSync(path)) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function main(): Promise<void> {
  if (args.mode === "hold-lock") {
    const lock = acquireInstanceLock(args.lockPath);
    writeFileSync(args.marker, JSON.stringify({ held: true }));
    hang(lock);
    return;
  }
  const store = openStore(args.dbPath);
  let b;
  try {
    b = bench(store, args.lockPath, { clock: new FakeClock(args.wallMs), idPrefix: args.idPrefix });
  } catch (error) {
    if (error instanceof InstanceLockError) {
      writeFileSync(args.marker, JSON.stringify({ lockError: error.code }));
      store.close();
      return;
    }
    throw error;
  }
  if (args.go !== undefined) await waitFor(args.go);
  b.freshPriority();
  const result = await b.scheduler.tick();
  writeFileSync(args.marker, JSON.stringify({ kind: result.kind }));
  if (args.mode === "tick-and-hang") {
    hang(b, store);
    return;
  }
  b.close();
  store.close();
}

await main();
