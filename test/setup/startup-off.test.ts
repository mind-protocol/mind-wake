import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

const supervisorUrl = new URL("../../scripts/desktop-supervisor.mjs", import.meta.url).href;
const integrationUrl = new URL("../../scripts/windows-integration.mjs", import.meta.url).href;

/** Exécute un module ESM (les scripts sont des .mjs hors du graphe TypeScript). */
function run(script: string, ...args: string[]): unknown {
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script, ...args], {
      encoding: "utf8",
      timeout: 15000,
    }),
  );
}

it("Windows startup defaults to Off listening: `listen` before the engine, no `on`, pause fallback on an old CLI", () => {
  const out = run(
    `
    const {startOff,startScheduled,canStartOff}=await import(process.argv[1]);
    const m={repoDir:'R',dataDir:'D',node:'node'};
    const scenario=(state,daemon='stopped',locked=false,startFn=startOff,oldCli=false)=>{
      const calls=[];
      const runCli=(_n,args)=>{
        const verb=args[1]; calls.push(verb);
        const stdout=verb==='status'?JSON.stringify({ok:true,data:{profile:{state,emergencyStopLocked:locked},daemon:{state:daemon}}}):'{}';
        return {status:oldCli&&verb==='listen'?2:0,stdout};
      };
      const result=startFn===startOff?startOff(m,runCli,()=>calls.push('engine')):(startScheduled(m,{keepMode:true,run:runCli,spawnIt:()=>calls.push('engine')}),'resume');
      return {result,calls};
    };
    console.log(JSON.stringify({
      ready:scenario('ready'),
      alwaysOnCrashed:scenario('running','crashed'),
      alreadyPaused:scenario('paused'),
      engineRunning:scenario('hibernating','running'),
      stopped:scenario('stopped'),
      locked:scenario('ready','stopped',true),
      disabled:scenario('disabled'),
      resume:scenario('ready','stopped',false,'resume'),
      oldCli:scenario('ready','stopped',false,startOff,true),
      oldCliPaused:scenario('paused','stopped',false,startOff,true),
      missing:canStartOff({}),
    }));
  `,
    supervisorUrl,
  );
  expect(out).toEqual({
    ready: { result: "listening", calls: ["status", "listen", "engine"] },
    // Extinction pendant une session (Always-on) : à l'écoute, le moteur clôt l'orpheline sans relancer.
    alwaysOnCrashed: { result: "listening", calls: ["status", "listen", "engine"] },
    // Pause laissée par le démarrage du lot 1 : `listen` la lève.
    alreadyPaused: { result: "listening", calls: ["status", "listen", "engine"] },
    engineRunning: { result: "listening", calls: ["status", "listen"] },
    stopped: { result: "unchanged", calls: ["status"] },
    locked: { result: "unchanged", calls: ["status"] },
    disabled: { result: "unchanged", calls: ["status"] },
    // Reprendre le dernier mode : moteur seul, sans `on` qui écraserait Always-on.
    resume: { result: "resume", calls: ["status", "engine"] },
    // dist compilé avant le lot 2 (pas de `listen`) : repli sur la Pause du lot 1.
    oldCli: { result: "paused", calls: ["status", "listen", "pause", "engine"] },
    oldCliPaused: { result: "paused", calls: ["status", "listen", "engine"] },
    missing: false,
  });
});

it("startup mode setting: default off, survives shortcut rewrites, rejects unknown values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-startup-mode-"));
  try {
    const manifest = path.join(dir, "manifest.json");
    fs.writeFileSync(manifest, "{}");
    const out = run(
      `
      const {startupMode}=await import(process.argv[1]);
      const {setStartupMode}=await import(process.argv[2]);
      const fs=await import('node:fs');
      const manifest=process.argv[3], settings=process.argv[4];
      const before=startupMode(manifest);
      fs.writeFileSync(settings, JSON.stringify({startWithWindows:true}));
      const legacy=startupMode(manifest);
      setStartupMode(manifest,'resume');
      const resumed=startupMode(manifest);
      const kept=JSON.parse(fs.readFileSync(settings,'utf8')).startWithWindows;
      let refused=false; try{setStartupMode(manifest,'always-on');}catch{refused=true;}
      setStartupMode(manifest,'off');
      console.log(JSON.stringify({before,legacy,resumed,kept,refused,after:startupMode(manifest)}));
    `,
      supervisorUrl,
      integrationUrl,
      manifest,
      path.join(dir, "windows.json"),
    );
    expect(out).toEqual({
      before: "off",
      legacy: "off",
      resumed: "resume",
      kept: true,
      refused: true,
      after: "off",
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
