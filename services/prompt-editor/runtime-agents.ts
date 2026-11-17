import fs from "node:fs";
import path from "node:path";
import { workspaceDirFor, controlDbPath } from "../../src/daemon/paths.js";
import { agentRoleFile, readAgentRole } from "../../src/adapters/agent-role.js";
import {
  WAKE_HOME_SYSTEM_PROMPT,
  PERSONALITY_FILE,
  withWakePersonality,
} from "../../src/adapters/wake-system-prompt.js";
import { CLAUDE_WAKE_SYSTEM_PROMPT } from "../../src/adapters/claude/registration.js";
import { appendFilDocument, FIL_DOCUMENT } from "../../src/communication/fil-continuity.js";
import { CLUSTER_STATUS_PROMPT } from "../../src/communication/cluster-status.js";
import { openStoreReadOnly } from "../../src/store/index.js";
import { DEFAULT_PROFILE_ID } from "../../src/cli/context.js";
import {
  FAST_REPLY_SYSTEM_NOTE,
  fastReplySystemPrompt,
  assignedForkSystemPrompt,
  FORK_FAST_REPLY_IDENTITY,
  FAST_REPLY_RULES,
} from "../../src/communication/fast-reply.js";
import {
  SECOND_THREAD_SYSTEM_NOTE,
  secondThreadSystemPrompt,
} from "../../src/daemon/second-thread.js";
import { FORK_IDS, forkDir, defaultForkRole, defaultForkPrompt } from "../../src/daemon/forks.js";
import { readForkAssignment, assignedForkPrompt } from "../../src/daemon/fork-assignment.js";
import { coachSystemPrompt, defaultCoachPrompt } from "../../src/daemon/coach.js";

export interface Source {
  id: string;
  label: string;
  file: string;
  read: () => string;
}
export interface RuntimeAgent {
  id: string;
  name: string;
  preview: () => string;
  sources: Source[];
  last?: () => string;
}
function text(file: string) {
  return fs.readFileSync(file, "utf8");
}
export function runtimeAgents(dataDir: string): RuntimeAgent[] {
  const w = workspaceDirFor(dataDir);
  const agents: RuntimeAgent[] = [];
  const fileSource = (file: string, label: string): Source => ({
    id: "file",
    label,
    file,
    read: () => text(file),
  });
  const role = (id: string, fallback: () => string): Source => ({
    id: "role",
    label: "Instructions de rôle",
    file: agentRoleFile(w, id),
    read: () => readAgentRole(w, id, fallback()),
  });
  const home: Source = {
    ...role("wake-home", () => WAKE_HOME_SYSTEM_PROMPT),
    id: "home",
    label: "Base partagée des forks, du second fil et de la réponse rapide",
  };
  const personality: Source = {
    id: "personality",
    label: "Personnalité partagée de Wake",
    file: path.join(w, PERSONALITY_FILE),
    read: () =>
      fs.existsSync(path.join(w, PERSONALITY_FILE)) ? text(path.join(w, PERSONALITY_FILE)) : "",
  };
  function add(
    id: string,
    name: string,
    preview: () => string,
    sources: Source[],
    last?: () => string,
  ) {
    agents.push({ id: "wake:" + id, name, preview, sources, ...(last ? { last } : {}) });
  }
  for (const engine of ["claude", "codex"]) {
    const id = "marco-" + engine;
    const source = role(id, () =>
      engine === "claude" ? CLAUDE_WAKE_SYSTEM_PROMPT : WAKE_HOME_SYSTEM_PROMPT,
    );
    add(
      id,
      "Marco · " + (engine === "claude" ? "Claude" : "Codex"),
      () => {
        let base = source.read();
        if (engine === "codex" && fs.existsSync(controlDbPath(dataDir))) {
          const store = openStoreReadOnly(controlDbPath(dataDir));
          try {
            const rev = store.uow.profiles.get(DEFAULT_PROFILE_ID)?.activePolicyRevisionId;
            if (rev && store.uow.policies.getRevision(rev)?.groups.runtime.nativeCapabilities)
              base += "\n\n" + CLUSTER_STATUS_PROMPT;
          } finally {
            store.close();
          }
        }
        base = withWakePersonality(w, base);
        const fil = path.join(w, FIL_DOCUMENT);
        return fs.existsSync(fil) ? appendFilDocument(base, JSON.parse(text(fil))) : base;
      },
      [source, personality],
    );
  }
  add("fast-reply", "⚡ Réponse rapide", () => fastReplySystemPrompt(w), [
    role("fast-reply", () => FAST_REPLY_SYSTEM_NOTE),
    home,
    personality,
  ]);
  add("second-thread", "Second fil Claude", () => secondThreadSystemPrompt(w), [
    role("second-thread", () => SECOND_THREAD_SYSTEM_NOTE),
    home,
    personality,
  ]);
  add("coach", "Coach", () => coachSystemPrompt(w), [role("coach", defaultCoachPrompt)]);
  for (const id of FORK_IDS) {
    const assignment = readForkAssignment(forkDir(dataDir, id));
    if (assignment) {
      const source = fileSource(assignment.instructions, "Instructions du fork");
      add(
        "fork-" + id,
        "Fork " + id + " · " + path.basename(assignment.instructions),
        () => assignedForkPrompt(id, assignment),
        [source],
      );
      const voice = "fast-reply-fork-" + id;
      add(
        voice,
        "⚡ Réponse rapide · Fork " + id,
        () => assignedForkSystemPrompt(dataDir, `fork:${id}`) ?? fastReplySystemPrompt(w),
        [
          role(voice, () => FORK_FAST_REPLY_IDENTITY),
          {
            ...role("fast-reply-fork-rules", () => FAST_REPLY_RULES.join(" ")),
            id: "rules",
            label: "Règles partagées des réponses rapides de fork",
          },
          source,
        ],
      );
    } else {
      add("fork-" + id, "Fork " + id, () => defaultForkPrompt(w, id), [
        role("fork-" + id, () => defaultForkRole(id)),
        home,
        personality,
      ]);
    }
  }
  const simulation = path.join(w, "artifacts", "projets", "ui-app", "alignment-proxy229");
  const prompt = path.join(simulation, "PROMPT.md");
  if (fs.existsSync(prompt)) {
    const last = () => {
      const files = fs
        .readdirSync(simulation)
        .filter((n) => /^input-[a-f0-9]{64}\.json$/.test(n))
        .map((n) => ({ n, t: fs.statSync(path.join(simulation, n)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      if (!files.length) throw Error("Aucun appel de la Simulation enregistré.");
      const snapshot = JSON.parse(text(path.join(simulation, files[0]!.n)));
      if (typeof snapshot.systemPrompt !== "string")
        throw Error("Prompt du dernier appel indisponible.");
      return snapshot.systemPrompt;
    };
    add(
      "simulation",
      "Simulation NLR",
      () => text(prompt),
      [fileSource(prompt, "Rôle de la Simulation")],
      last,
    );
  }
  // Le keeper Séries relit ces trois sources lors de la reprise de chaque rôle.
  const projects = path.join(w, "artifacts", "projets");
  if (fs.existsSync(projects))
    for (const project of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const config = path.join(projects, project.name, "keeper", "config.json");
      if (!fs.existsSync(config)) continue;
      let c;
      try {
        c = JSON.parse(text(config));
      } catch {
        continue;
      }
      if (c?.version !== 1 || typeof c.skillsRoot !== "string" || !c.seriesRoot || !c.roles)
        continue;
      for (const [name, settings] of Object.entries(c.roles)) {
        const output = (settings as { outputRoot?: string })?.outputRoot;
        if (typeof output !== "string" || !/^[a-z0-9-]+$/.test(name)) continue;
        const skill = path.join(c.skillsRoot, "series-" + name);
        const files = [
          path.join(skill, "system.md"),
          path.join(skill, "SKILL.md"),
          path.join(output, ".duo", "ROLE-GUIDE.md"),
        ];
        if (
          !files.every(
            (f) => fs.existsSync(f) && fs.realpathSync(f).startsWith(fs.realpathSync(w) + path.sep),
          )
        )
          continue;
        const sources = files.map((file) => ({
          ...fileSource(file, path.basename(file)),
          id: path.basename(file),
        }));
        add(
          "series:" + project.name + ":" + name,
          "Séries · " + name,
          () => sources.map((s) => s.read()).join("\n\n"),
          sources,
        );
      }
    }
  return agents;
}
