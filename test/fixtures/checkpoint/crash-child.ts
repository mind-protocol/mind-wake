/**
 * Processus enfant des tests de crash des checkpoints. Lancé par
 * `node --import ts-hooks.ts crash-child.ts '<json>'`. Écrit un artefact puis meurt
 * brutalement (`process.exit`) au point demandé, sans nettoyage ni rollback explicite.
 */

import type { ArtifactId } from "../../../src/contracts/index.js";
import { openRoot, publishCheckpoint, writeArtifactAtomic } from "../../../src/checkpoint/index.js";
import { openStore } from "../../../src/store/index.js";
import { PROFILE } from "../store-ledger/setup.js";
import { candidate, NOW, SESSION } from "./setup.js";

export interface CrashArgs {
  readonly mode: "before-rename" | "before-commit";
  readonly dbPath: string;
  readonly artifacts: string;
}

const args = JSON.parse(process.argv[2] ?? "{}") as CrashArgs;
const store = openStore(args.dbPath);
const root = openRoot(args.artifacts);

const crash = (): never => process.exit(42);

const ref = writeArtifactAtomic(root, "runs/crash.txt", "travail de la session B", {
  id: "crash" as ArtifactId,
  ...(args.mode === "before-rename" && { beforeRename: crash }),
});
publishCheckpoint(
  {
    uow: store.uow,
    root,
    profileId: PROFILE,
    sessionId: SESSION,
    now: () => NOW,
    beforeCommit: crash,
  },
  candidate({ artifacts: [ref] }),
);
// Inatteignable : `beforeCommit` termine le processus dans la transaction.
process.exit(0);
