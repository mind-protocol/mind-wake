import { expect, it, vi } from "vitest";
import { runAdviceWakes, wakeCount } from "../../services/helpers/advice-wakes.js";

const target = { runtime: "codex" as const, sessionId: "chosen", cwd: "repo" };
const answer = (text: string) => ({ ok: true, text, detail: "synthetic" });

it("hands the checkpoint to the next turn, persists each result and stops early", async () => {
  const wake = vi
    .fn()
    .mockResolvedValueOnce(answer("Artifact saved; next: verify\nMIND_WAKE: continue"))
    .mockResolvedValueOnce(answer("Artifact verified\nMIND_WAKE: done"));
  const checkpoint = vi.fn(),
    beforeWake = vi.fn().mockResolvedValue(undefined);
  const result = await runAdviceWakes({
    target,
    prompt: "Mission",
    wakes: 5,
    wake,
    checkpoint,
    beforeWake,
  });
  expect(result).toMatchObject({ workState: "done", wakesUsed: 2 });
  expect(wake).toHaveBeenCalledTimes(2);
  expect(wake.mock.calls[1]?.[1]).toContain("Artifact saved; next: verify");
  expect(checkpoint).toHaveBeenCalledTimes(2);
  expect(beforeWake).toHaveBeenCalledTimes(2);
});

it.each(["blocked", "missing-marker"])("does not retry %s", async (state) => {
  const wake = vi
    .fn()
    .mockResolvedValue(
      answer(state === "blocked" ? "Need owner\nMIND_WAKE: blocked" : "Unstructured result"),
    );
  const result = await runAdviceWakes({
    target,
    prompt: "Mission",
    wakes: 4,
    wake,
    checkpoint: vi.fn(),
    beforeWake: async () => {},
  });
  expect(result.workState).toBe(state === "blocked" ? "blocked" : "needs_review");
  expect(wake).toHaveBeenCalledTimes(1);
});

it("stops at the caller's total without claiming completion", async () => {
  const wake = vi.fn().mockResolvedValue(answer("More remains\nMIND_WAKE: continue"));
  expect(
    await runAdviceWakes({
      target,
      prompt: "Mission",
      wakes: 2,
      wake,
      checkpoint: vi.fn(),
      beforeWake: async () => {},
    }),
  ).toMatchObject({ workState: "budget_reached", wakesUsed: 2 });
  expect(wake).toHaveBeenCalledTimes(2);
});

it("rechecks authorization after a checkpoint and never starts a revoked turn", async () => {
  const wake = vi.fn().mockResolvedValue(answer("Saved\nMIND_WAKE: continue"));
  const beforeWake = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("paused"));
  await expect(
    runAdviceWakes({ target, prompt: "Mission", wakes: 3, wake, checkpoint: vi.fn(), beforeWake }),
  ).rejects.toThrow("paused");
  expect(wake).toHaveBeenCalledTimes(1);
});

it("preserves single-turn compatibility and rejects invalid totals", async () => {
  const wake = vi.fn().mockResolvedValue(answer("Ordinary answer"));
  expect(
    await runAdviceWakes({
      target,
      prompt: "Original",
      wakes: 1,
      wake,
      checkpoint: vi.fn(),
      beforeWake: async () => {},
    }),
  ).toMatchObject({ workState: "reported" });
  expect(wake).toHaveBeenCalledWith(target, "Original");
  for (const value of [0, -1, 1.5, Infinity]) expect(() => wakeCount(value)).toThrow();
});
