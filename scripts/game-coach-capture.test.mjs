import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureCoachBatch, saveCoachFrame } from "./game-coach-capture.mjs";

// Synthetic fixture, never counted as a real observed screen.
const url =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH1EAAAAASUVORK5CYII=";
const window = { id: 8, app: "fixture:game" };
async function temporary(run) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "coach-history-test-"));
  try {
    await run(dataDir);
  } finally {
    await fs.rm(dataDir, { recursive: true });
  }
}
test("four actual API calls use intermediate targets; timestamps and index return to consumer", () =>
  temporary(async (dataDir) => {
    let time = 0;
    const calls = [];
    const sky = {
      get_window_state: async () => {
        calls.push(time);
        time += 20;
        return { window, screenshots: [{ id: `s${calls.length}`, url }] };
      },
    };
    const result = await captureCoachBatch({
      sky,
      window,
      dataDir,
      guard: async () => true,
      clock: () => time,
      now: () => new Date(1800000000000 + time),
      sleep: async (ms) => {
        time += ms;
      },
    });
    assert.deepEqual(calls, [0, 1250, 2500, 3750]);
    assert.equal(result.frames.length, 4);
    assert.equal(new Set(result.frames.map((x) => x.screenshotId)).size, 4);
    assert.equal(result.index.length, 4);
    assert.equal(result.frames[1].captureStartedAt, new Date(1800000001250).toISOString());
  }));
test("rotation keeps exactly 40 managed PNGs and never removes an unrelated file", () =>
  temporary(async (dataDir) => {
    for (let i = 0; i < 43; i++)
      await saveCoachFrame({ dataDir, url, capturedAt: new Date(1800000000000 + i).toISOString() });
    const dir = path.join(dataDir, "screen-history");
    await fs.writeFile(path.join(dir, "keep.png"), "unmanaged");
    const result = await saveCoachFrame({
      dataDir,
      url,
      capturedAt: new Date(1700000000000).toISOString(),
    });
    assert.equal(result.index.length, 40);
    assert.equal(result.index[0].capturedAt, new Date(1800000000004).toISOString());
    assert.equal(result.index.at(-1).capturedAt, new Date(1700000000000).toISOString());
    assert.equal(
      (await fs.readdir(dir)).filter((x) => x.startsWith("coach-") && x.endsWith(".png")).length,
      40,
    );
    assert.equal(await fs.readFile(path.join(dir, "keep.png"), "utf8"), "unmanaged");
  }));
test("pause during interval prevents next capture; post-capture revocation discards pixels", () =>
  temporary(async (dataDir) => {
    let time = 0,
      calls = 0;
    const sky = {
      get_window_state: async () => {
        calls++;
        return { window, screenshots: [{ id: "x", url }] };
      },
    };
    await assert.rejects(
      captureCoachBatch({
        sky,
        window,
        dataDir,
        guard: async () => time < 300,
        clock: () => time,
        sleep: async (ms) => {
          time += ms;
        },
      }),
      /suspended/,
    );
    assert.equal(calls, 1);
    let checks = 0;
    await assert.rejects(
      captureCoachBatch({ sky, window, dataDir, guard: async () => ++checks === 1 }),
      /suspended/,
    );
    assert.equal(
      JSON.parse(await fs.readFile(path.join(dataDir, "screen-history/index.json"), "utf8")).frames
        .length,
      1,
    );
  }));
test("CU Escape propagates, never retries or writes an image", () =>
  temporary(async (dataDir) => {
    let calls = 0;
    await assert.rejects(
      captureCoachBatch({
        window,
        dataDir,
        guard: async () => true,
        sky: {
          get_window_state: async () => {
            calls++;
            throw new Error("Computer Use stopped by Escape");
          },
        },
      }),
      /Escape/,
    );
    assert.equal(calls, 1);
    await assert.rejects(fs.stat(path.join(dataDir, "screen-history")), /ENOENT/);
  }));
test("unsafe directory links and invalid image bytes are rejected", () =>
  temporary(async (dataDir) => {
    await assert.rejects(
      saveCoachFrame({
        dataDir,
        url: "data:image/png;base64,aGVsbG8=",
        capturedAt: new Date().toISOString(),
      }),
      /not a PNG/,
    );
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "coach-outside-test-"));
    try {
      await fs.symlink(outside, path.join(dataDir, "screen-history"), "junction");
      await assert.rejects(
        saveCoachFrame({ dataDir, url, capturedAt: new Date().toISOString() }),
        /real private directory/,
      );
      assert.deepEqual(await fs.readdir(outside), []);
    } finally {
      await fs.rm(outside, { recursive: true });
    }
  }));
