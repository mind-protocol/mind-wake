import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { openCallControls } from "./call-control-store.mjs";

/** Caller authority comes only from the host's existing owner signature. */
export function registerAgentCallControl(server: McpServer, {dir, caller, label}: {dir: string; caller: string; label?: string}) {
  server.registerTool("list_active_calls", {
    description: "List active app calls in which this agent is a participant. Returns exact call IDs and epochs for hangup_call. Older clients without call-session support are not included.",
    inputSchema: z.strictObject({}),
  }, () => {
    const book = openCallControls(dir);
    try { return {content:[{type:"text" as const, text:JSON.stringify({schema:"mind.call.active.v1", calls:book.listForCaller(caller)})}]}; }
    finally { book.close(); }
  });
  server.registerTool("invite_to_call", {
    description: "Add an agent, a room or a pattern holder to the app call in progress, so it hears the human and answers in the call. Open to every agent; the app server performs the addition with its own rights (no key or token passes through you). target: stable slug or id from the call directory (e.g. viz, vox, room3, coach-des-coachs). call_id defaults to the active call. reason: a few words, announced in one line to the participants with your name. Returns added, already_joined, target_unknown, no_active_call or pending (app server busy or offline; the request expires after 60 s).",
    inputSchema: z.strictObject({
      target:z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.-]{0,60}$/),
      call_id:z.string().uuid().optional(),
      reason:z.string().trim().min(1).max(200),
    }),
  }, async ({target, call_id, reason}) => {
    const answer = (value: Record<string, unknown>, isError = false) =>
      ({...(isError ? {isError:true} : {}), content:[{type:"text" as const, text:JSON.stringify({schema:"mind.call.invite.v1", ...value})}]});
    let request: number | undefined; let first;
    const book = openCallControls(dir);
    try {
      first = book.requestInvite({...(call_id ? {id:call_id, epoch:1 as const} : {}), caller, callerLabel:label ?? caller, target, reason});
      if (first.state !== "pending") return answer({call_id:first.call_id, target, status:first.status});
      request = first.request;
    } catch(error) {
      const code = String((error as {code?:string})?.code ?? (error as Error)?.message ?? error);
      return answer({target, status:code === "no_active_call" ? "no_active_call" : code}, code !== "no_active_call");
    } finally { book.close(); }
    // Le serveur de l'app règle la demande en une seconde environ ; au-delà, elle reste en attente.
    for (let waited = 0; waited < 6000; waited += 250) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const poll = openCallControls(dir);
      try {
        const current = request === undefined ? null : poll.invite(request);
        if (current?.state === "settled") return answer({call_id:current.call_id, target, status:current.status, ...(current.error ? {error:current.error} : {})},
          !["added", "already_joined"].includes(String(current.status)));
      } finally { poll.close(); }
    }
    return answer({call_id:first.call_id, target, status:"pending", request});
  });
  server.registerTool("hangup_call", {
    description: "End one exact app call for its participants, only if this agent belongs to it. Warn the human before hanging up. Requires call_id and epoch from list_active_calls; never guess an ID. Idempotent; a stored end request is not proof the clients stopped audio. Does not ring or call back.",
    inputSchema: z.strictObject({
      call_id:z.string().uuid(),
      epoch:z.literal(1),
    }),
  }, ({call_id, epoch}) => {
    const book = openCallControls(dir);
    try { return {content:[{type:"text" as const, text:JSON.stringify({schema:"mind.call.hangup.v1", ...book.requestHangup({id:call_id,epoch,caller})})}]}; }
    catch(error) { return {isError:true, content:[{type:"text" as const, text:String((error as Error)?.message ?? error)}]}; }
    finally { book.close(); }
  });
}
