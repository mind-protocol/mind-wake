import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

const moduleUrl = new URL("../../scripts/windows-integration.mjs", import.meta.url).href;
const supervisorUrl = new URL("../../scripts/desktop-supervisor.mjs", import.meta.url).href;
it("supervises real child exits: restart request, crash recovery, then voluntary quit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-supervisor-"));
  try {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {spawn} from 'node:child_process';
      const {supervise}=await import(process.argv[1]);
      let launches=0;
      await supervise(process.argv[2],false,async()=>spawn(process.execPath,['-e','process.exit('+ [75,7,0][launches++] +')'],{stdio:'ignore',windowsHide:true}));
      console.log(launches);
    `,
        supervisorUrl,
        path.join(dir, "manifest.json"),
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    expect(output.trim()).toBe("3");
    expect(fs.readFileSync(path.join(dir, "desktop-supervisor.log"), "utf8")).toContain("desktop exited (75); restarting in 0ms");
    expect(fs.readFileSync(path.join(dir, "desktop-supervisor.log"), "utf8")).toContain(
      "desktop exited (7)",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("never restarts intentional exits and backs off after repeated crashes", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const {restartDelay,canStartScheduled}=await import(process.argv[1]);
    const status=(state,locked=false,daemon='stopped')=>({ok:true,data:{profile:{state,emergencyStopLocked:locked},daemon:{state:daemon}}});
    console.log(JSON.stringify({delays:[restartDelay(0,null,0),restartDelay(1,null,0),restartDelay(null,'SIGTERM',2),restartDelay(1,null,20)],
      eligible:['ready','hibernating','paused','stopped','disabled','blocked','running','checkpointing'].map(s=>canStartScheduled(status(s))),
      locked:canStartScheduled(status('ready',true)),running:canStartScheduled(status('ready',false,'running')),missing:canStartScheduled({})}));
  `,
      supervisorUrl,
    ],
    { encoding: "utf8" },
  );
  expect(JSON.parse(output)).toEqual({
    delays: [null, 1000, 4000, 60000],
    eligible: [true, true, false, false, false, false, false, false],
    locked: false,
    running: false,
    missing: false,
  });
});

it.skipIf(process.platform !== "win32")(
  "creates real shortcuts, preserves opt-out on reinstall, and quotes unusual paths",
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake windows ' $ "));
    try {
      const desktop = path.join(dir, "desktop"),
        startup = path.join(dir, "startup");
      fs.mkdirSync(desktop);
      fs.mkdirSync(startup);
      const manifestFile = path.join(dir, "manifest.json");
      fs.writeFileSync(
        manifestFile,
        JSON.stringify({
          version: 1,
          node: process.execPath,
          repoDir: dir,
          desktopExe: path.join(dir, "wake.exe"),
        }),
      );
      const output = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      const {windowsIntegration,launcherArguments}=await import(process.argv[1]);
      const manifest=process.argv[2], folders=JSON.parse(process.argv[3]);
      const states=['install','disable','install','status','enable'].map(action=>windowsIntegration(manifest,action,folders));
      console.log(JSON.stringify(states));
    `,
          moduleUrl,
          manifestFile,
          JSON.stringify({ desktop, startup }),
        ],
        { encoding: "utf8" },
      );
      expect(
        JSON.parse(output).map((s: { startWithWindows: boolean }) => s.startWithWindows),
      ).toEqual([true, false, false, false, true]);
      const link = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:WAKE_TEST_LINK); @{target=$s.TargetPath; args=$s.Arguments} | ConvertTo-Json -Compress",
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env, WAKE_TEST_LINK: path.join(startup, "MIND Wake.lnk") },
        },
      );
      const shortcut = JSON.parse(link);
      expect(shortcut.target.toLowerCase()).toContain("powershell.exe");
      const command = Buffer.from(shortcut.args.split(" ").at(-1), "base64").toString("utf16le");
      expect(command).toContain(manifestFile.replaceAll("'", "''"));
      expect(command).toContain(" --startup");
      expect(fs.existsSync(path.join(desktop, "MIND Wake.lnk"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  30000,
);
