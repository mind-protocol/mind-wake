import { createHash, randomUUID } from "node:crypto";
import type { ConversationRole } from "./contracts.js";
import { ConversationStore } from "./store.js";
import type { RoleRuntime, RoleRuntimeResult } from "./role-runtime.js";
import { leadDraftPrompt, rolePrompt } from "./prompts.js";
import {
  reconstructMessages,
  parseObject,
  roleConversation,
  rememberUserInstructions,
} from "./messages.js";
import { parseRewrite } from "./rewrite.js";
import { ParagraphEditLimitError } from "./edit-constraints.js";

interface WorkItem {
  id: string;
  title: string;
  instructions: string;
}
interface CallResult {
  id: string;
  text: string;
  raw: string;
  data: Record<string, unknown>;
}
export class ConversationCoordinator {
  constructor(
    readonly store: ConversationStore,
    readonly runtime: RoleRuntime,
  ) {}

  async run(conversationId: string, revision: number, outerSignal?: AbortSignal): Promise<void> {
    const control = new AbortController(),
      abort = () => {
        control.abort(outerSignal?.reason ?? Error("Conversation interrupted"));
      };
    outerSignal?.addEventListener("abort", abort, { once: true });
    if (outerSignal?.aborted) abort();
    const current = () => this.store.current(conversationId);
    const cancelled = (): boolean =>
      control.signal.aborted || current()?.revision !== revision || current()?.status !== "active";
    const assertCurrent = () => {
      if (control.signal.aborted) throw control.signal.reason ?? Error("Conversation interrupted");
      const state = current();
      if (!state || state.revision !== revision || state.status !== "active")
        throw Error("Conversation superseded or stopped");
    };
    const monitor = setInterval(() => {
      try {
        assertCurrent();
      } catch (error) {
        control.abort(error);
      }
    }, 100);
    monitor.unref();
    const active = new Set<Promise<unknown>>();
    const observe = <T>(p: Promise<T>): Promise<T> => {
      active.add(p);
      void p.finally(() => active.delete(p)).catch(() => {});
      return p;
    };
    const roleCall = async (
      role: ConversationRole,
      pass: 1 | 2,
      extra: Record<string, unknown> = {},
      draft = false,
    ): Promise<CallResult> => {
      assertCurrent();
      if (control.signal.aborted) throw control.signal.reason;
      const snapshot = this.store.snapshot(conversationId);
      const systemPrompt = draft ? leadDraftPrompt() : rolePrompt(role, pass);
      const dependencies =
        pass === 2
          ? snapshot.calls
              .filter((c) => c.revision === revision && c.pass === 1 && c.status === "succeeded")
              .map((c) => c.id)
          : role === "lead" && !draft
            ? snapshot.calls
                .filter(
                  (c) =>
                    c.revision === revision &&
                    c.pass === 1 &&
                    c.status === "succeeded" &&
                    ["expertise", "pattern", "context"].includes(c.role),
                )
                .map((c) => c.id)
            : [];
      const dependencyKey = createHash("sha256")
        .update(JSON.stringify({ revision, role, pass, systemPrompt, dependencies, extra }))
        .digest("hex");
      const messages = reconstructMessages(snapshot, role, pass, {
        ...extra,
        inputDependencyKey: dependencyKey,
      });
      const reusable = snapshot.calls.find((c) => {
        if (
          c.revision !== revision ||
          c.role !== role ||
          c.pass !== pass ||
          c.status !== "succeeded" ||
          c.systemPrompt !== systemPrompt
        )
          return false;
        try {
          const last = c.messages.at(-1);
          return (
            last !== undefined && parseObject(last.content)["inputDependencyKey"] === dependencyKey
          );
        } catch {
          return false;
        }
      });
      if (reusable)
        return {
          id: reusable.id,
          text: reusable.text,
          raw: reusable.rawOutput ?? reusable.text,
          data: draft ? {} : parseObject(reusable.rawOutput ?? reusable.text),
        };
      const call = this.store.addCall({
        id: `call-${randomUUID()}`,
        conversationId,
        revision,
        role,
        pass,
        systemPrompt,
        messages,
      });
      let result: RoleRuntimeResult | undefined,
        received = "";
      try {
        result = await this.runtime.run(
          { callId: call.id, conversationId, revision, role, pass, systemPrompt, messages },
          {
            signal: control.signal,
            onEvent: (event) => {
              if (event.type === "delta") received += event.text;
              if (event.type === "text") received = event.text;
              if (current()?.revision !== revision || current()?.status !== "active") return;
              if (event.type === "activity")
                this.store.appendEvent({
                  conversationId,
                  revision,
                  role,
                  callId: call.id,
                  kind: "activity",
                  text: event.text,
                });
              // Drafts are plain public text; structured JSON from other calls is never shown as a streamed answer.
              if (draft && (event.type === "delta" || event.type === "text")) {
                this.store.updateLeadDraft(conversationId, revision, call.id, received);
                this.store.appendEvent({
                  conversationId,
                  revision,
                  role,
                  callId: call.id,
                  kind: event.type === "delta" ? "lead_delta" : "lead_preview",
                  text: event.text,
                });
                provideDraft(event.text);
              }
            },
          },
        );
        assertCurrent();
        const data = draft ? {} : parseObject(result.text);
        if (pass === 2) parseRewrite(result.text, roleConversation(snapshot, role));
        const display = draft
          ? result.text
          : typeof data["text"] === "string"
            ? data["text"]
            : result.text;
        const finished = this.store.finishCall(call.id, {
          status: "succeeded",
          text: display,
          rawOutput: result.text,
          usage: result.usage,
          publish: !draft && pass === 1,
        });
        if (role === "expertise" && pass === 1 && finished.published)
          rememberUserInstructions(this.store, conversationId, revision, data);
        return { id: call.id, text: display, raw: result.text, data };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const prior = this.store.call(call.id);
        if (prior?.status === "running") {
          this.store.finishCall(call.id, {
            status: cancelled() ? "cancelled" : "failed",
            text: result?.text ?? received,
            rawOutput: result?.text ?? received,
            ...(result ? { usage: result.usage } : {}),
            error: detail,
            publish: false,
          });
        }
        throw error;
      }
    };
    let releaseDraft!: (text: string) => void,
      draftProvided = false;
    const draftAvailable = new Promise<string>((resolve) => {
      releaseDraft = resolve;
    });
    const provideDraft = (text: string) => {
      if (!draftProvided && text.trim()) {
        draftProvided = true;
        releaseDraft(text);
      }
    };
    const usefulCommentary = async (event: string): Promise<void> => {
      const marker = createHash("sha256").update(event).digest("hex");
      if (
        this.store
          .events(conversationId)
          .some(
            (e) =>
              e.revision === revision && e.kind === "commentary_event_handled" && e.text === marker,
          )
      )
        return;
      const target = this.store
        .messages(conversationId)
        .filter((m) => m.revision === revision && m.role === "lead")
        .at(-1);
      if (!target) return;
      try {
        const result = await roleCall("commentary", 1, {
          observedEvent: event,
          editTarget: { messageId: target.id, version: target.version, text: target.text },
        });
        if (result.text.trim())
          this.store.applyCommentary(
            conversationId,
            revision,
            result.id,
            target.id,
            target.version,
            result.text,
          );
        this.store.appendEvent({
          conversationId,
          revision,
          role: "commentary",
          callId: result.id,
          kind: "commentary_event_handled",
          text: marker,
        });
      } catch (error) {
        if (!control.signal.aborted)
          this.store.appendEvent({
            conversationId,
            revision,
            role: "commentary",
            kind: "commentary_unavailable",
            text: error instanceof Error ? error.message : String(error),
          });
      }
    };
    try {
      assertCurrent();
      const existing = this.store.snapshot(conversationId);
      const finished = existing.events
        .filter((e) => e.revision === revision && e.kind === "conversation_completed")
        .at(-1);
      const latest = new Map<string, (typeof existing.calls)[number]>();
      for (const c of existing.calls.filter((c) => c.revision === revision))
        latest.set(`${c.role}:${String(c.pass)}`, c);
      const unchanged =
        finished &&
        latest.size > 0 &&
        [...latest.values()].every(
          (c) => c.status === "succeeded" && c.systemPrompt === rolePrompt(c.role, c.pass),
        ) &&
        existing.repository.every((r) => r.updatedAt <= finished.at);
      if (unchanged) {
        this.store.completeConversation(conversationId, revision);
        return;
      }
      this.store.appendEvent({
        conversationId,
        revision,
        kind: "cycle_started",
        text: "Coopération spécialisée démarrée sur cette révision.",
      });
      const expertise = observe(roleCall("expertise", 1));
      const pattern = observe(roleCall("pattern", 1));
      const firstComment = observe(
        Promise.all([pattern, draftAvailable])
          .then(([r]) =>
            usefulCommentary(
              "Pattern a identifié ces méthodes applicables pendant que le contexte est recherché : " +
                r.raw,
            ),
          )
          .catch(() => {}),
      );
      // A Context call can start as soon as the first actual Lead text arrives.
      const draft = observe(
        roleCall("lead", 1, {}, true)
          .then((r) => {
            provideDraft(r.text);
            return r;
          })
          .catch((error: unknown) => {
            releaseDraft("");
            throw error;
          }),
      );
      const context = observe(
        (async () => {
          const beginning = await draftAvailable;
          return roleCall("context", 1, { leadBeginning: beginning });
        })(),
      );
      const initial = await Promise.allSettled([pattern, draft, context, expertise]);
      await firstComment;
      assertCurrent();
      const missing = initial.flatMap((r, index) =>
        r.status === "rejected"
          ? [
              {
                role: ["pattern", "lead", "context", "expertise"][index],
                error: r.reason instanceof Error ? r.reason.message : String(r.reason),
              },
            ]
          : [],
      );
      if (missing.length === initial.length)
        throw Error("Aucun rôle initial n'a pu fournir de réponse.");
      const currentLead = this.store
        .messages(conversationId)
        .filter((m) => m.revision === revision && m.role === "lead")
        .at(-1);
      const lead = await roleCall("lead", 1, {
        missingContributions: missing,
        ...(currentLead
          ? {
              editTarget: {
                messageId: currentLead.id,
                version: currentLead.version,
                text: currentLead.text,
                leadText:
                  currentLead.segments
                    ?.filter((s) => s.role === "lead")
                    .map((s) => s.text)
                    .join("") ?? currentLead.text,
              },
            }
          : {}),
      });
      const workItems: WorkItem[] = [];
      for (const value of Array.isArray(lead.data["work"]) ? lead.data["work"] : []) {
        if (!value || typeof value !== "object") continue;
        const w = value as Record<string, unknown>;
        if (typeof w["instructions"] !== "string" || !w["instructions"].trim()) continue;
        workItems.push({
          id: typeof w["id"] === "string" ? w["id"] : `task-${String(workItems.length + 1)}`,
          title: typeof w["title"] === "string" ? w["title"] : "Travail demandé",
          instructions: w["instructions"],
        });
      }
      if (workItems.length) {
        const outcomes = await Promise.allSettled([
          roleCall("work", 1, { tasks: workItems }),
          usefulCommentary("Le Lead a confié ces travaux à Work : " + JSON.stringify(workItems)),
        ]);
        if (outcomes[0].status === "rejected")
          this.store.appendEvent({
            conversationId,
            revision,
            role: "work",
            kind: "work_incomplete",
            text:
              outcomes[0].reason instanceof Error
                ? outcomes[0].reason.message
                : String(outcomes[0].reason),
          });
      }
      assertCurrent();
      const roles = new Set(
        this.store
          .messages(conversationId)
          .filter((m) => m.revision === revision && m.role !== "human")
          .map((m) => m.role as ConversationRole),
      );
      // One rewrite and at most one bounded correction for a paragraph-limit refusal.
      const rewriteRoles = [...roles];
      const rewriteOutcomes = await Promise.allSettled(
        rewriteRoles.map((role) =>
          observe(
            (async () => {
              const before = this.store.snapshot(conversationId),
                original = roleConversation(before, role);
              const rewriteInput = {
                humanEditedMessages: before.messages
                  .filter((m) => m.edited)
                  .map((m) => ({ id: m.id, text: m.text })),
              };
              let answer: CallResult;
              try {
                answer = await roleCall(role, 2, rewriteInput);
              } catch (error) {
                if (!(error instanceof ParagraphEditLimitError)) throw error;
                assertCurrent();
                const refused = this.store
                  .calls(conversationId)
                  .filter(
                    (c) =>
                      c.revision === revision &&
                      c.role === role &&
                      c.pass === 2 &&
                      c.status === "failed",
                  )
                  .at(-1);
                if (!refused) throw error;
                this.store.appendEvent({
                  conversationId,
                  revision,
                  role,
                  callId: refused.id,
                  kind: "rewrite_correction_requested",
                  text: error.message,
                });
                answer = await roleCall(role, 2, {
                  ...rewriteInput,
                  rewriteCorrection: {
                    rejectedCallId: refused.id,
                    rejectedOutput: refused.rawOutput ?? refused.text,
                    error: error.message,
                    instruction:
                      "Return the complete valid rewrite JSON. Change or insert at most ONE paragraph in total across all assistant messages. Preserve every other paragraph and every human message exactly. Pure deletions are exempt. Do not split this edit into multiple changes.",
                  },
                });
              }
              assertCurrent();
              try {
                const rewrite = parseRewrite(answer.raw, original);
                this.store.publishRewrite(conversationId, revision, role, rewrite.messages, {
                  callId: answer.id,
                  reason: rewrite.improvements.join("\n"),
                });
                for (const entry of rewrite.repository) {
                  const previous = this.store
                    .repository(role, conversationId)
                    .find((r) => r.key === entry.key);
                  const protectHumanRule =
                    role === "expertise" &&
                    previous?.status === "accepted" &&
                    previous.sources.some((s) => s.startsWith("human:"));
                  const key = protectHumanRule
                    ? `proposal-${createHash("sha256")
                        .update(answer.id + "\0" + entry.key)
                        .digest("hex")
                        .slice(0, 24)}`
                    : entry.key;
                  this.store.contributeRepository(role, conversationId, {
                    ...entry,
                    key,
                    status: "proposed",
                    sourceCallId: answer.id,
                    reason: "Référentiel proposé pendant la seconde passe.",
                  });
                }
                this.store.appendEvent({
                  conversationId,
                  revision,
                  role,
                  callId: answer.id,
                  kind: "rewrite_applied",
                  text: rewrite.improvements.join("\n"),
                });
              } catch (error) {
                this.store.appendEvent({
                  conversationId,
                  revision,
                  role,
                  callId: answer.id,
                  kind: "rewrite_rejected",
                  text: error instanceof Error ? error.message : String(error),
                });
                throw error;
              }
            })(),
          ),
        ),
      );
      assertCurrent();
      const incomplete = rewriteOutcomes.flatMap((outcome, index) => {
        if (outcome.status !== "rejected") return [];
        const role = rewriteRoles[index];
        this.store.appendEvent({
          conversationId,
          revision,
          ...(role ? { role } : {}),
          kind: "rewrite_incomplete",
          text: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        });
        return [role ?? "unknown"];
      });
      if (incomplete.length) throw Error(`Réécriture incomplète : ${incomplete.join(", ")}`);
      this.store.completeConversation(conversationId, revision);
    } catch (error) {
      control.abort(error);
      await Promise.allSettled([...active]);
      const state = current();
      if (state?.revision === revision && state.status === "active")
        this.store.appendEvent({
          conversationId,
          revision,
          kind: "cycle_failed",
          text: error instanceof Error ? error.message : String(error),
        });
      throw error;
    } finally {
      clearInterval(monitor);
      outerSignal?.removeEventListener("abort", abort);
    }
  }
}
