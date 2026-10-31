/** A peer proposal is data. Execution/review decisions are never wire operations. */
import * as z from "zod";
import { createHash } from "node:crypto";
import { LIMITS, partyRefSchema, idempotencyKeySchema } from "./protocol.js";
export const taskId = z.string().regex(/^task_[a-f0-9]{32}$/);
export const taskInput = z.strictObject({
  goal: z.string().min(3).max(160),
  deliverable: z.string().min(1).max(400),
  scope: z.string().min(1).max(400),
  prompt: z.string().min(1).max(LIMITS.maxMessageChars),
});
export type TaskInput = z.infer<typeof taskInput>;
export const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const requestEnvelope = z.strictObject({
  schema: z.literal("mind.peer-task/request"),
  version: z.literal(1),
  request_id: taskId,
  revision: z.literal(1),
  prompt_hash: z.string().regex(/^[a-f0-9]{64}$/),
  ...taskInput.shape,
});
export type RequestEnvelope = z.infer<typeof requestEnvelope>;
export const replyEnvelope = z.strictObject({
  schema: z.literal("mind.peer-task/reply"),
  version: z.literal(1),
  request_id: taskId,
  prompt_hash: z.string().regex(/^[a-f0-9]{64}$/),
  attempt: z.int().min(0),
  outcome: z.enum(["declined", "accepted_result"]),
  text: z.string().min(1).max(LIMITS.maxMessageChars),
  result_version: z.int().min(0),
  result_hash: z.string().regex(/^[a-f0-9]{64}$/),
  reviewed_by: z.strictObject({
    workshop_ref: partyRefSchema,
    local_role: z.enum(["agent", "human"]),
  }),
  source: z.enum(["local_helper", "local_amendment", "local_decline"]),
});
export type ReplyEnvelope = z.infer<typeof replyEnvelope>;
export function wire(value: RequestEnvelope | ReplyEnvelope): string {
  const text = JSON.stringify(value);
  if (text.length > LIMITS.maxMessageChars)
    throw Error(
      "Complete envelope exceeds shared message limit; shorten explicitly, never truncate",
    );
  return text;
}
export function makeRequest(
  from: string,
  to: string,
  input: TaskInput,
  key: string,
): RequestEnvelope {
  partyRefSchema.parse(from);
  partyRefSchema.parse(to);
  idempotencyKeySchema.parse(key);
  const canonical = taskInput.parse(input);
  return {
    schema: "mind.peer-task/request",
    version: 1,
    request_id: "task_" + digest([from, to, key]).slice(0, 32),
    revision: 1,
    prompt_hash: digest(canonical),
    ...canonical,
  };
}
export function validRequest(text: string): RequestEnvelope | null {
  try {
    const value = requestEnvelope.parse(JSON.parse(text));
    const { goal, deliverable, scope, prompt } = value;
    return value.prompt_hash === digest({ goal, deliverable, scope, prompt }) &&
      wire(value) === text
      ? value
      : null;
  } catch {
    return null;
  }
}
export function validReply(text: string): ReplyEnvelope | null {
  try {
    const value = replyEnvelope.parse(JSON.parse(text));
    return value.result_hash === digest(value.text) && wire(value) === text ? value : null;
  } catch {
    return null;
  }
}
