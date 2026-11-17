import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareStt, findPython } from "./setup-stt.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake stt é-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const python = path.join(dir, "Python", "python.exe");
  const model = path.join(dir, "models", "small");
  const execute = (command, args) => {
    calls.push({ command, args });
    if (args.includes("-c") && args.some((arg) => arg.includes("WhisperModel")))
      return JSON.stringify({ python, model });
    return python;
  };
  return { dir, calls, python, model, execute };
}

test("fresh profile creates isolated runtime and absolute config only after inference", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, "voice-input.json"), JSON.stringify({ custom: true }));
  const result = prepareStt(f.dir, { execute: f.execute });
  assert.equal(result.ready, true);
  assert.ok(f.calls.some(({ args }) => args.includes("venv")));
  assert.ok(f.calls.some(({ args }) => args.includes("faster-whisper==1.2.1")));
  assert.ok(f.calls.some(({ args }) => args.includes("av==18.1.0")));
  assert.deepEqual(JSON.parse(fs.readFileSync(result.configFile)), {
    custom: true,
    transcription: { python: f.python, model: f.model, device: "auto", language: "fr" },
  });
  f.calls.length = 0;
  assert.equal(prepareStt(f.dir, { execute: f.execute }).preserved, true);
  assert.equal(f.calls.length, 1);
});

test("custom and Telegram configurations are checked without overwriting or installing", (t) => {
  for (const filename of ["voice-input.json", "telegram.json"]) {
    const f = fixture(t);
    const content = JSON.stringify({
      transcription: { python: f.python, model: f.model, device: "cuda" },
      other: "keep",
    });
    fs.writeFileSync(path.join(f.dir, filename), content);
    const result = prepareStt(f.dir, { execute: f.execute });
    assert.equal(result.configFile, path.join(f.dir, filename));
    assert.equal(fs.readFileSync(result.configFile, "utf8"), content);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].args.at(-1), "yes");
  }
});

test("download or inference failure leaves configuration untouched and no ready report", (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, "voice-input.json");
  fs.writeFileSync(file, '{"custom":true}');
  assert.throws(
    () =>
      prepareStt(f.dir, {
        execute(command, args) {
          if (args.some((arg) => arg.includes("WhisperModel"))) throw Error("offline");
          return f.execute(command, args);
        },
      }),
    /offline/,
  );
  assert.equal(fs.readFileSync(file, "utf8"), '{"custom":true}');
  assert.equal(fs.existsSync(path.join(f.dir, "installation/stt/status.json")), false);
});

test("Python discovery skips broken aliases and finds installations outside PATH", (t) => {
  const f = fixture(t);
  const pythonDir = path.join(f.dir, "Programs/Python/Python312");
  fs.mkdirSync(pythonDir, { recursive: true });
  assert.equal(
    findPython(
      (command) => {
        if (command === path.join(pythonDir, "python.exe")) return command;
        throw Error("missing");
      },
      { LOCALAPPDATA: f.dir },
    ),
    path.join(pythonDir, "python.exe"),
  );
});

test("missing Python triggers per-user install and rediscovery", (t) => {
  const f = fixture(t);
  let installed = false;
  prepareStt(f.dir, {
    env: {},
    execute(command, args) {
      if (command === "winget") {
        installed = true;
        return "";
      }
      if (!installed) throw Error("Python absent");
      return f.execute(command, args);
    },
  });
  assert.equal(installed, true);
});
