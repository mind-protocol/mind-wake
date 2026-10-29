import { expect, it } from "vitest";
import { ForegroundYield } from "./foreground-yield.js";
const frame = (o: unknown) => JSON.stringify(o);
it("waits for an actual runtime task before requesting background; keeps it alive after the parent reply", () => {
  let pending = false;
  const sent: string[] = [];
  const c = new ForegroundYield(
    () => pending,
    (l) => sent.push(l),
    () => false,
  );
  c.observe(
    frame({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", name: "Bash" }] },
    }),
  );
  pending = true;
  c.tick();
  expect(sent).toEqual([]);
  c.observe(
    frame({
      type: "system",
      subtype: "task_started",
      task_id: "task",
      tool_use_id: "tool",
      is_backgrounded: false,
    }),
  );
  c.observe(
    frame({
      type: "system",
      subtype: "task_started",
      task_id: "other",
      tool_use_id: "tool-other",
      is_backgrounded: false,
    }),
  );
  c.tick();
  expect(sent).toHaveLength(1);
  const req = JSON.parse(sent[0]!);
  expect(req.request).toEqual({ subtype: "background_tasks" });
  c.tick();
  expect(sent).toHaveLength(1);
  c.observe(
    frame({
      type: "control_response",
      response: {
        request_id: req.request_id,
        subtype: "success",
        response: { backgrounded: true },
      },
    }),
  );
  expect(c.hasWork).toBe(true);
  expect(c.tasks.get("task")?.background).toBe(true);
  expect(c.tasks.get("other")?.background).toBe(true);
  pending = false;
  c.markIdle();
  c.tick();
  expect(c.hasWork).toBe(true);
  c.observe(
    frame({ type: "system", subtype: "task_notification", task_id: "task", status: "completed" }),
  );
  expect(c.hasWork).toBe(true);
  c.observe(
    frame({ type: "system", subtype: "task_notification", task_id: "other", status: "completed" }),
  );
  expect(c.hasWork).toBe(false);
});
it("delivers an arriving message between turns without cancelling the worker", () => {
  let pending = false,
    delivered = 0;
  const sent: string[] = [];
  const c = new ForegroundYield(
    () => pending,
    (l) => sent.push(l),
    () => {
      delivered++;
      pending = false;
      return true;
    },
  );
  c.observe(
    frame({
      type: "system",
      subtype: "task_started",
      task_id: "t",
      tool_use_id: "x",
      is_backgrounded: true,
    }),
  );
  c.markIdle();
  pending = true;
  c.tick();
  expect(delivered).toBe(1);
  expect(sent).toEqual([]);
  expect(c.hasWork).toBe(true);
});
it("never kills work or claims success when native backgrounding is unsupported", () => {
  const sent: string[] = [];
  const c = new ForegroundYield(
    () => true,
    (l) => sent.push(l),
    () => false,
  );
  c.observe(frame({ type: "system", subtype: "task_started", task_id: "t", tool_use_id: "x" }));
  for (let i = 0; i < 5; i++) {
    c.tick();
    const last = JSON.parse(sent.at(-1)!);
    c.observe(
      frame({
        type: "control_response",
        response: { request_id: last.request_id, subtype: "error" },
      }),
    );
  }
  expect(sent).toHaveLength(2);
  expect(c.hasWork).toBe(true);
  expect(c.notices.join(" ")).not.toContain("attente libérée");
});
it("merges native task patches and reconciles missing completion notifications from a live snapshot", () => {
  const c = new ForegroundYield(
    () => false,
    () => {},
    () => false,
  );
  c.observe(
    frame({
      type: "system",
      subtype: "task_started",
      task_id: "t",
      tool_use_id: "x",
      is_backgrounded: false,
    }),
  );
  c.observe(
    frame({
      type: "system",
      subtype: "task_updated",
      task_id: "t",
      patch: { is_backgrounded: true },
    }),
  );
  expect(c.tasks.get("t")?.background).toBe(true);
  c.observe(frame({ type: "system", subtype: "background_tasks_changed", tasks: [] }));
  expect(c.hasWork).toBe(false);
  c.observe(
    frame({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "recovered" }],
    }),
  );
  expect(c.hasWork).toBe(true);
  c.observe(
    frame({
      type: "system",
      subtype: "task_updated",
      task_id: "recovered",
      patch: { status: "completed" },
    }),
  );
  expect(c.hasWork).toBe(false);
});
it("accepts an empty success response only if native events confirm backgrounding", () => {
  const sent: string[] = [];
  const c = new ForegroundYield(
    () => true,
    (l) => sent.push(l),
    () => false,
  );
  c.observe(
    frame({
      type: "system",
      subtype: "task_started",
      task_id: "t",
      tool_use_id: "x",
      is_backgrounded: false,
    }),
  );
  c.tick();
  const request = JSON.parse(sent[0]!).request_id;
  c.observe(
    frame({
      type: "system",
      subtype: "task_updated",
      task_id: "t",
      patch: { is_backgrounded: true },
    }),
  );
  c.observe(
    frame({
      type: "control_response",
      response: { subtype: "success", request_id: request, response: {} },
    }),
  );
  expect(c.notices.join(" ")).toContain("Attente libérée");
});
